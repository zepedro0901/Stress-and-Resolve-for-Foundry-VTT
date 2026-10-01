/**
 * More of the PDF's Stress sources:
 * - Targeted by a creature you're frightened of: + its CR.
 * - Lingering conditions: each round Blinded, Deafened, Poisoned, Restrained or Paralyzed: + the CR of the
 *   creature that inflicted it (natively blind or deaf characters skip those two).
 * - An ally dies: watchers + 1d8 per Hit Die of the ally; those who learn of it later, half.
 * - Killing blow on a creature you're frightened of: − twice its CR (see adaptations.mjs, damage applied).
 */
import { MODULE_ID } from "./constants.mjs";
import { addStress, tracksStress } from "./stress.mjs";
import { locateToken, sourceActor, turnEndRules } from "./effects.mjs";
import { card, fearCheck } from "./adaptations.mjs";
import { registerHandler, requestGM } from "./socket.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const setting = key => game.settings.get(MODULE_ID, key);

export const LINGERING = ["blinded", "deafened", "poisoned", "restrained", "paralyzed"];

function isResponsibleGM() {
  return game.user.isGM && (game.users.activeGM?.id === game.user.id);
}

function effectsOf(actor) {
  return actor?.allApplicableEffects ? [...actor.allApplicableEffects()] : [...(actor?.effects ?? [])];
}

const crOf = actor => {
  if ( !actor || (actor.type === "character") ) return null;
  const cr = Number(actor.system?.details?.cr);
  return Number.isFinite(cr) ? cr : null;
};

/** Is this the same creature (synthetic token actors compare by uuid, linked actors by id)? */
export function sameCreature(a, b) {
  if ( !a || !b ) return false;
  if ( a.uuid === b.uuid ) return true;
  return !a.isToken && !b.isToken && (a.id === b.id);
}

/** The creatures this character is currently frightened of (from the Frightened effects' sources). */
export function fearedCreatures(actor) {
  const out = [];
  for ( const e of effectsOf(actor) ) {
    if ( e.disabled || !e.statuses?.has?.("frightened") ) continue;
    const source = sourceActor(e);
    if ( source && !out.some(o => sameCreature(o, source)) ) out.push(source);
  }
  return out;
}

export const fears = (actor, creature) => fearedCreatures(actor).some(c => sameCreature(c, creature));

/* -------------------------------------------- */
/*  Targeted by a feared creature               */
/* -------------------------------------------- */

async function onTargeted(activity) {
  if ( !setting("fearTargetStress") ) return;
  const attacker = activity?.actor;
  const cr = crOf(attacker);
  if ( cr === null ) return;
  const targets = [...(game.user.targets ?? [])].map(t => t.actor).filter(tracksStress);
  for ( const target of targets ) {
    if ( !fears(target, attacker) ) continue;
    await addStress(target, cr, {
      reason: loc("Reason.FearTargeted", { enemy: attacker.name, action: activity.item?.name ?? activity.name ?? "" }),
      sourceUuid: attacker.uuid
    });
  }
}

/* -------------------------------------------- */
/*  Lingering conditions                        */
/* -------------------------------------------- */

/**
 * At the end of the character's turn: for each lingering condition, Stress equal to the CR of the creature
 * that inflicted it (the highest, if several effects give the same condition).
 */
export async function lingering(actor) {
  if ( !setting("conditionStress") ) return;
  const data = actor.flags?.[MODULE_ID] ?? {};
  for ( const status of LINGERING ) {
    if ( (status === "blinded") && data.nativeBlind ) continue;
    if ( (status === "deafened") && data.nativeDeaf ) continue;
    const effects = effectsOf(actor).filter(e => !e.disabled && e.statuses?.has?.(status));
    if ( !effects.length ) continue;
    const condition = game.i18n.localize(CONFIG.statusEffects?.find?.(s => s.id === status)?.name ?? status);
    let best = null;
    for ( const effect of effects ) {
      const source = sourceActor(effect);
      let cr = crOf(source);
      let name = source?.name;
      if ( (cr === null) && !source ) {
        // Unknown source (e.g. from the token HUD): ask the GM once and remember it on the effect.
        const stored = effect.getFlag?.(MODULE_ID, "cr");
        if ( stored === undefined ) {
          cr = await askCR(actor, condition);
          try { await effect.setFlag?.(MODULE_ID, "cr", cr ?? 0); } catch(err) { /* can't store */ }
        } else cr = stored;
        name = loc("Reason.UnknownSource");
      }
      if ( (cr !== null) && (cr > 0) && (!best || (cr > best.cr)) ) best = { cr, name };
    }
    if ( !best ) continue;
    await addStress(actor, best.cr, { reason: loc("Reason.Lingering", { condition, enemy: best.name }) });
  }
}

/** Ask the GM for the CR of whatever inflicted a condition. */
async function askCR(actor, status) {
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: loc("Source.AskCR.Title") },
    content: `<p>${loc("Source.AskCR.Body", { name: esc(actor.name), condition: esc(status) })}</p>
      <div class="form-group"><label>${loc("Fx.FearPrompt.CR")}</label><input type="text" name="cr" placeholder="1/2"></div>`,
    buttons: [
      { action: "ok", label: loc("Fx.FearPrompt.Apply"), default: true, callback: (event, button) => parseCR(button.form.elements.cr.value) },
      { action: "skip", label: loc("Fx.FearPrompt.Skip") }
    ],
    rejectClose: false
  });
  return typeof result === "number" && Number.isFinite(result) ? result : null;
}

export function parseCR(text) {
  text = String(text ?? "").trim();
  if ( !text ) return null;
  const [a, b] = text.split("/").map(Number);
  const value = b ? a / b : a;
  return Number.isFinite(value) ? value : null;
}

/* -------------------------------------------- */
/*  An ally dies                                */
/* -------------------------------------------- */

/** Hit Dice of a creature: a character's level, or the dice in an NPC's HP formula. */
export function hitDice(actor) {
  if ( actor.type === "character" ) return Math.max(1, Number(actor.system?.details?.level) || 1);
  const formula = String(actor.system?.attributes?.hp?.formula ?? "");
  const dice = [...formula.matchAll(/(\d*)d\d+/gi)].reduce((n, m) => n + (Number(m[1]) || 1), 0);
  return Math.max(1, dice || Math.floor(Number(actor.system?.details?.cr) || 1));
}

/** Is the dead creature an ally of the player characters? Characters always are; NPCs if their token is Friendly. */
function isPartyAlly(actor, token) {
  if ( actor.type === "character" ) return true;
  return (token?.disposition ?? actor.prototypeToken?.disposition) === 1;
}

const down = a => ["dead", "unconscious"].some(s => a.statuses?.has?.(s));

/** Deaths being handled right now (the dead condition and the third failed save can both report one). */
const mourning = new Set();

/**
 * An ally died: every other player character on the same scene gains 1d8 Stress per Hit Die of the ally.
 * The GM gets a button for the characters who weren't there, to use when they learn of it (half).
 */
export async function allyDied(actor) {
  if ( !setting("allyDeathStress") ) return;
  if ( !game.user.isGM ) return requestGM("allyDied", { actorUuid: actor.uuid });
  if ( actor.getFlag(MODULE_ID, "mourned") || mourning.has(actor.uuid) ) return;
  const { scene, token } = locateToken(actor, canvas?.scene);
  if ( !isPartyAlly(actor, token) ) return;
  mourning.add(actor.uuid);
  try {
    await actor.setFlag(MODULE_ID, "mourned", true);
  } finally {
    mourning.delete(actor.uuid);
  }

  const hd = hitDice(actor);
  const watchers = [];
  for ( const t of scene?.tokens ?? [] ) {
    const other = t.actor;
    if ( !tracksStress(other) || sameCreature(other, actor) || down(other) || watchers.includes(other) ) continue;
    watchers.push(other);
  }
  const absent = game.actors.filter(a => tracksStress(a) && a.hasPlayerOwner && !sameCreature(a, actor)
    && !watchers.some(w => sameCreature(w, a)));

  await card(actor, `<h3>${loc("Source.Death.Title", { name: esc(actor.name) })}</h3>
    <p>${loc("Source.Death.Text", { name: esc(actor.name), hd })}</p>
    ${watchers.length ? "" : `<p>${loc("Source.Death.NoWitness")}</p>`}`, { cls: "sr-affliction" });
  for ( const w of watchers ) {
    const r = await new Roll(`${hd}d8`).evaluate();
    await addStress(w, r.total, { reason: loc("Reason.AllyDied", { name: actor.name, hd }) });
  }
  if ( absent.length ) {
    await card(actor, `<p>${loc("Source.Death.Absent", { name: esc(actor.name) })}</p>
      ${absent.map(a => `<button type="button" class="sr-learn-button" data-actor="${a.uuid}" data-dead="${actor.uuid}"
        data-hd="${hd}"><i class="fa-solid fa-envelope-open-text" inert></i> ${loc("Source.Death.Learns", { name: esc(a.name) })}</button>`).join("")}`,
    { cls: "sr-affliction", whisperGM: true });
  }
}

/** A character learns of an ally's death later: half of 1d8 per Hit Die. */
export async function learnOfDeath(actor, deadName, hd) {
  const r = await new Roll(`${hd}d8`).evaluate();
  const n = Math.max(1, Math.floor(r.total / 2));
  await addStress(actor, n, { reason: loc("Reason.AllyDiedLearned", { name: deadName, hd, roll: r.total }) });
}

function registerDeathWatch() {
  registerHandler("allyDied", actor => allyDied(actor));

  // The dead condition (dnd5e adds it automatically for most creatures; the GM can add it from the HUD or tracker).
  Hooks.on("createActiveEffect", effect => {
    if ( !isResponsibleGM() || !effect.statuses?.has?.("dead") ) return;
    const actor = effect.parent;
    if ( actor?.documentName === "Actor" ) allyDied(actor).catch(err => console.error(`${MODULE_ID} | Ally death failed`, err));
  });
  // A character's third failed death save.
  Hooks.on("dnd5e.rollDeathSave", (rolls, { subject, outcome }) => {
    if ( outcome !== "death" || !subject ) return;
    setTimeout(() => allyDied(subject).catch(err => console.error(`${MODULE_ID} | Ally death failed`, err)), 0);
  });
  // Brought back: they can be mourned again next time.
  Hooks.on("deleteActiveEffect", effect => {
    if ( !isResponsibleGM() || !effect.statuses?.has?.("dead") ) return;
    const actor = effect.parent;
    if ( actor?.getFlag?.(MODULE_ID, "mourned") ) actor.unsetFlag(MODULE_ID, "mourned");
  });
  Hooks.on("updateActor", (actor, changes) => {
    if ( !isResponsibleGM() || !actor.getFlag?.(MODULE_ID, "mourned") ) return;
    const hp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
    if ( (hp > 0) && !actor.statuses?.has?.("dead") ) actor.unsetFlag(MODULE_ID, "mourned");
  });

  Hooks.on("renderChatMessageHTML", (message, html) => {
    for ( const button of html.querySelectorAll(".sr-learn-button") ) {
      if ( !game.user.isGM ) { button.disabled = true; continue; }
      button.addEventListener("click", async event => {
        event.preventDefault();
        button.disabled = true;
        const who = fromUuidSync(button.dataset.actor, { strict: false });
        const dead = fromUuidSync(button.dataset.dead, { strict: false });
        if ( who ) await learnOfDeath(who, dead?.name ?? "?", Number(button.dataset.hd) || 1);
      });
    }
  });
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerSources() {
  fearCheck.fears = fears;
  turnEndRules.push(lingering);
  registerDeathWatch();
  Hooks.on("dnd5e.postUseActivity", activity => {
    onTargeted(activity).catch(err => console.error(`${MODULE_ID} | Feared attacker Stress failed`, err));
  });
}
