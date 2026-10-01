/**
 * The PDF's class, feat and spell changes, adjusted for the 2024 rules (see the module plan):
 *
 * Barbarian Rage · Bard Bardic Inspiration and Song of Rest (2024: one Bardic Inspiration use) ·
 * Cleric Divine Intervention and Turn Undead · Fighter Second Wind · Monk Patient Defense (Focus Point) ·
 * Paladin Lay on Hands and Aura of Courage · Ranger Favored Enemy (2024: the target of your Hunter's Mark) ·
 * Rogue Sneak Attack · Sorcerer Calming Spell · Warlock Pact Magic and Dark Commune · Wizard Arcane Recovery ·
 * Artificer Craftsman's Calm · Blood Hunter Crimson Rite · Calm Emotions · Soothe.
 */
import { MODULE_ID, statusId } from "./constants.mjs";
import { tokenDistance } from "./math.mjs";
import { addStress, getData, resolveCheck, riders, setStress, tracksStress } from "./stress.mjs";
import { card, findEffect, findFeat, ident, partyMembers, slug } from "./adaptations.mjs";
import { registerHandler, requestGM } from "./socket.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const setting = key => game.settings.get(MODULE_ID, key);
const enabled = () => setting("classRiders");

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

export const classLevels = (actor, id) => Number(actor?.classes?.[id]?.system?.levels) || 0;
const mod = (actor, ability) => Number(actor?.system?.abilities?.[ability]?.mod) || 0;
const prof = actor => Number(actor?.system?.attributes?.prof) || 0;

/** A die like "d8" from a dnd5e scale value, with a fallback. */
function scaleDie(actor, cls, key, fallback="d6") {
  const v = actor?.system?.scale?.[cls]?.[key];
  const die = v?.die ?? (typeof v === "string" ? v : null);
  if ( die ) return String(die).replace(/^1d/, "d");
  if ( v?.faces ) return `d${v.faces}`;
  return fallback;
}

async function heal(actor, formula, reason, data={}) {
  const r = await new Roll(formula, data).evaluate();
  await addStress(actor, -Math.max(1, r.total), { reason });
  return r.total;
}

function tokenOf(actor, scene=canvas?.scene) {
  if ( actor.isToken ) return actor.token;
  return scene?.tokens?.find(t => t.actorId === actor.id) ?? null;
}

const incapacitated = actor => ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"]
  .some(s => actor.statuses?.has(s));

/* -------------------------------------------- */
/*  Reductions to Stress received               */
/* -------------------------------------------- */

/**
 * Class reductions to a Stress gain, each to a minimum of 1:
 * Rage (−CON), Aura of Courage (−the Paladin's CHA), Favored Enemy (half), Craftsman's Calm (−attuned items).
 */
export function reduceStress(actor, delta, options={}) {
  const notes = [];
  if ( !enabled() || (delta <= 0) ) return { delta, notes };
  const cut = (n, key, data) => {
    if ( n <= 0 ) return;
    const before = delta;
    delta = Math.max(1, delta - n);
    if ( delta < before ) notes.push(loc(`Class.Reason.${key}`, { n: before - delta, ...data }));
  };

  // Barbarian: Rage.
  if ( classLevels(actor, "barbarian") && findEffect(actor, ["rage"]) ) cut(mod(actor, "con"), "Rage");

  // Paladin: Aura of Courage (the strongest aura that reaches this character).
  const aura = strongestAura(actor);
  if ( aura ) cut(aura.n, "Aura", { name: aura.name });

  // Ranger: Stress from the creature under this Ranger's Hunter's Mark is halved.
  if ( classLevels(actor, "ranger") && options.sourceUuid ) {
    const source = fromUuidSync(options.sourceUuid, { strict: false });
    const mark = source && findEffect(source, ["hunters-mark"]);
    if ( mark && (!mark.origin || String(mark.origin).startsWith(actor.uuid)) ) {
      const before = delta;
      delta = Math.max(1, Math.floor(delta / 2));
      if ( delta < before ) notes.push(loc("Class.Reason.Favored", { n: before - delta }));
    }
  }

  // Artificer: Craftsman's Calm.
  if ( classLevels(actor, "artificer") ) cut(Number(actor.system?.attributes?.attunement?.value) || 0, "Craftsman");

  return { delta, notes };
}

/** The Paladin whose Aura of Courage covers this actor with the largest reduction: { n, name }. */
export function strongestAura(actor, scene=canvas?.scene) {
  const own = tokenOf(actor, scene);
  if ( !own || !scene ) return null;
  const grid = { size: scene.grid.size, distance: scene.grid.distance };
  let best = null;
  for ( const t of scene.tokens ) {
    const paladin = t.actor;
    if ( !paladin || !findFeat(paladin, "aura-of-courage") || incapacitated(paladin) ) continue;
    if ( (paladin !== actor) && (t.disposition !== own.disposition) ) continue;
    const range = findFeat(paladin, "aura-expansion") ? 30 : 10;
    if ( (paladin !== actor) && (tokenDistance(t, own, grid) > range) ) continue;
    const n = mod(paladin, "cha");
    if ( (n > 0) && (!best || (n > best.n)) ) best = { n, name: paladin.name };
  }
  return best;
}

/* -------------------------------------------- */
/*  Calm Emotions: suppress an affliction       */
/* -------------------------------------------- */

export async function suppress(actor, casterUuid, seconds=60) {
  const data = getData(actor);
  if ( data.state !== "afflicted" ) return;
  await actor.update({
    [`flags.${MODULE_ID}.suppressed`]: true,
    [`flags.${MODULE_ID}.suppressedBy`]: { casterUuid, until: game.time.worldTime + seconds }
  });
  await setStatusEnabled(actor, false);
  await card(actor, `<p>${loc("Class.Calm.Suppressed", { name: esc(actor.name), condition: loc(`Condition.${data.condition}.Name`) })}</p>`,
    { cls: "sr-virtue" });
}

export async function unsuppress(actor) {
  const data = getData(actor);
  if ( !data.suppressed ) return;
  await actor.update({ [`flags.${MODULE_ID}.suppressed`]: null, [`flags.${MODULE_ID}.suppressedBy`]: null });
  await setStatusEnabled(actor, true);
  if ( data.state ) {
    await card(actor, `<p>${loc("Class.Calm.Returns", { name: esc(actor.name), condition: loc(`Condition.${data.condition}.Name`) })}</p>`,
      { cls: "sr-affliction" });
  }
}

/** Turn the affliction's status effect (icon and mechanics) off or back on. */
async function setStatusEnabled(actor, on) {
  const { condition, subCondition } = getData(actor);
  for ( const key of [condition, subCondition].filter(Boolean) ) {
    const effect = actor.effects?.find(e => e.statuses?.has(statusId(key)));
    if ( effect && (effect.disabled === on) ) await effect.update({ disabled: !on });
  }
}

function registerCalm() {
  // Calm Emotions ends: when its concentration ends, or after its minute.
  Hooks.on("deleteActiveEffect", effect => {
    if ( !isResponsibleGM() || !effect.statuses?.has("concentrating") ) return;
    const caster = effect.parent;
    for ( const actor of game.actors ?? [] ) {
      const by = actor.getFlag?.(MODULE_ID, "suppressedBy");
      if ( by?.casterUuid && (by.casterUuid === caster?.uuid) ) unsuppress(actor);
    }
  });
  Hooks.on("updateWorldTime", worldTime => {
    if ( !isResponsibleGM() ) return;
    for ( const actor of game.actors ?? [] ) {
      const by = actor.getFlag?.(MODULE_ID, "suppressedBy");
      if ( by && (worldTime >= by.until) ) unsuppress(actor);
    }
  });
}

function isResponsibleGM() {
  return game.user.isGM && (game.users.activeGM?.id === game.user.id);
}

/* -------------------------------------------- */
/*  Chat buttons: heal Stress                   */
/* -------------------------------------------- */

/** A button that rolls a formula and heals that much Stress on one character. One click. */
function healButton(actor, label, formula, reason) {
  return `<button type="button" class="sr-heal-button" data-actor="${actor.uuid}" data-formula="${esc(formula)}"
    data-reason="${esc(reason)}"><i class="fa-solid fa-brain" inert></i> ${esc(label)}</button>`;
}

function registerButtons() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    for ( const button of html.querySelectorAll(".sr-heal-button") ) {
      const actor = fromUuidSync(button.dataset.actor, { strict: false });
      if ( !actor?.isOwner ) { button.disabled = true; continue; }
      button.addEventListener("click", async event => {
        event.preventDefault();
        button.disabled = true;
        await heal(actor, button.dataset.formula, button.dataset.reason);
        // Bardic Inspiration is used up.
        if ( button.dataset.formula && button.closest(".sr-bardic") ) {
          const effect = findEffect(actor, ["bardic-inspiration"]);
          if ( effect ) await effect.delete();
        }
      });
    }
    for ( const button of html.querySelectorAll(".sr-turned-button") ) {
      const actor = fromUuidSync(button.dataset.actor, { strict: false });
      if ( !actor?.isOwner ) { button.disabled = true; continue; }
      button.addEventListener("click", async event => {
        event.preventDefault();
        const n = await askNumber(loc("Class.TurnUndead.Title"), loc("Class.TurnUndead.Ask"), Number(button.dataset.count) || 1, 20);
        if ( !n ) return;
        button.disabled = true;
        await heal(actor, `${n}d6`, loc("Class.Reason.TurnUndead", { n }));
      });
    }
  });
}

async function askNumber(title, text, value, max) {
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title },
    content: `<div class="form-group"><label>${text}</label>
      <input type="number" name="n" min="0" max="${max}" step="1" value="${value}" autofocus></div>`,
    ok: { label: loc("Class.Apply"), callback: (event, button) => Number(button.form.elements.n.value) },
    rejectClose: false
  });
  return Math.clamp(Math.floor(Number(result) || 0), 0, max);
}

/* -------------------------------------------- */
/*  Before use: HP or Stress                    */
/* -------------------------------------------- */

const choiceApproved = new Map();
const isApproved = uuid => (choiceApproved.get(uuid) ?? 0) > Date.now();

/** Second Wind and Lay on Hands: choose to heal Stress instead of Hit Points. */
function registerChoices() {
  Hooks.on("dnd5e.preUseActivity", activity => {
    if ( !enabled() ) return;
    const item = activity.item;
    const id = ident(item);
    const isSecondWind = id === "second-wind";
    const isLay = (id === "lay-on-hands") && (activity.type === "heal");
    if ( !isSecondWind && !isLay ) return;
    if ( isApproved(activity.uuid) ) return;
    chooseHealing(activity, isLay).catch(err => console.error(`${MODULE_ID} | ${item.name} failed`, err));
    return false;
  });
}

async function chooseHealing(activity, isLay) {
  const item = activity.item;
  const actor = activity.actor;
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: item.name },
    content: `<p>${loc("Class.HealChoice", { name: esc(item.name) })}</p>`,
    buttons: [
      { action: "hp", label: loc("TempHP.ProtectHP"), icon: "fa-solid fa-heart", default: true },
      { action: "stress", label: loc("TempHP.ProtectStress"), icon: "fa-solid fa-brain" }
    ],
    rejectClose: false
  });
  if ( !choice ) return;
  if ( choice === "hp" ) {
    const real = actor.items.get(item.id)?.system?.activities?.get(activity.id) ?? activity;
    // Short approval window, kept open briefly so an aid gate (Paranoid, Masochistic) can re-run it.
    choiceApproved.set(real.uuid, Date.now() + 10000);
    return real.use();
  }

  const uses = item.system.uses;
  const left = uses?.max ? (uses.value ?? (uses.max - uses.spent)) : Infinity;
  if ( left <= 0 ) return ui.notifications.warn(loc("Class.NoUses", { name: item.name }));

  if ( !isLay ) {
    // Second Wind: 1d10 + Fighter level, Stress instead of HP.
    await item.update({ "system.uses.spent": (uses.spent ?? 0) + 1 });
    return heal(actor, `1d10 + ${classLevels(actor, "fighter")}`, loc("Class.Reason.SecondWind"));
  }

  // Lay on Hands: spend pool points on Stress, for the targeted character (or yourself).
  const target = [...(game.user.targets ?? [])].map(t => t.actor).find(tracksStress) ?? actor;
  const n = await askNumber(item.name, loc("Class.LayOnHands.Ask", { name: esc(target.name), max: left }), Math.min(left, 5), left);
  if ( !n ) return;
  await item.update({ "system.uses.spent": (uses.spent ?? 0) + n });
  await addStress(target, -n, { reason: loc("Class.Reason.LayOnHands", { name: actor.name }) });
}

/* -------------------------------------------- */
/*  After use                                   */
/* -------------------------------------------- */

/** The last attack roll per actor, for Sneak Attack: { advantage, hit, time }. */
const lastAttack = new Map();

async function afterUse(activity, usageConfig={}) {
  if ( !enabled() ) return;
  const item = activity?.item;
  const actor = activity?.actor;
  if ( !item || !tracksStress(actor) ) return;
  const id = ident(item);
  const activityName = slug(activity.name);
  const targets = [...(game.user.targets ?? [])].map(t => t.actor).filter(Boolean);

  // Warlock: casting with a Pact Magic slot heals Stress equal to the slot level (not Mystic Arcanum).
  if ( (item.type === "spell") && (usageConfig.spell?.slot === "pact") && (usageConfig.consume?.spellSlot !== false) ) {
    const level = Number(actor.system.spells?.pact?.level) || 0;
    if ( level ) await addStress(actor, -level, { reason: loc("Class.Reason.Pact", { n: level }) });
  }

  // Soothe: 1d4 + spellcasting modifier, +1d4 per slot level above 1st.
  if ( id === "soothe" ) {
    const dice = 1 + (Number(usageConfig.scaling) || 0);
    const data = item.getRollData?.() ?? {};
    const reason = loc("Reason.Spell", { spell: item.name });
    for ( const t of (targets.length ? targets : [actor]).filter(tracksStress) ) {
      await heal(t, `${dice}d4 + ${Number(data.mod) || 0}`, reason);
    }
    return;
  }

  // Calm Emotions: the caster may suppress afflictions for the spell's duration.
  if ( id === "calm-emotions" ) {
    for ( const t of targets.filter(a => tracksStress(a) && (getData(a).state === "afflicted") && !getData(a).suppressed) ) {
      const yes = await foundry.applications.api.DialogV2.confirm({
        window: { title: item.name },
        content: `<p>${loc("Class.Calm.Ask", { name: esc(t.name), condition: loc(`Condition.${getData(t).condition}.Name`) })}</p>`,
        rejectClose: false
      });
      if ( yes ) {
        if ( t.isOwner ) await suppress(t, actor.uuid);
        else requestGM("suppress", { actorUuid: t.uuid, casterUuid: actor.uuid });
      }
    }
    return;
  }

  // Cleric: Divine Intervention (2024: every use) drops Stress to 0 and tests Resolve, keeping only Virtues.
  if ( ["divine-intervention", "greater-divine-intervention"].includes(id) ) {
    await setStress(actor, 0, { reason: item.name, chat: true });
    await resolveCheck(actor, { virtueOnly: true });
    return;
  }

  // Cleric: Turn Undead heals 1d6 Stress per undead that fails the save.
  if ( activityName === "turn-undead" ) {
    const undead = targets.filter(a => a.system?.details?.type?.value === "undead").length;
    return card(actor, `<p>${loc("Class.TurnUndead.Text", { name: esc(actor.name) })}</p>
      <button type="button" class="sr-turned-button" data-actor="${actor.uuid}" data-count="${undead || 1}">
      <i class="fa-solid fa-skull" inert></i> ${loc("Class.TurnUndead.Button")}</button>`, { cls: "sr-virtue" });
  }

  // Bard: a Bardic Inspiration die can heal Stress instead.
  if ( id === "bardic-inspiration" ) {
    const die = scaleDie(actor, "bard", "inspiration");
    const pcs = targets.filter(a => tracksStress(a) && (a !== actor));
    if ( !pcs.length ) return;
    const reason = loc("Class.Reason.Bardic", { name: actor.name });
    return card(actor, `<div class="sr-bardic"><p>${loc("Class.Bardic.Text", { name: esc(actor.name), die })}</p>
      ${pcs.map(a => healButton(a, loc("Class.Bardic.Button", { name: a.name, die }), `1${die}`, reason)).join("")}</div>`,
    { cls: "sr-virtue" });
  }

  // Monk: Patient Defense with a Focus Point heals the Martial Arts die.
  if ( activityName.startsWith("patient-defense") && ((activity.consumption?.targets?.length ?? 0) > 0)
    && (usageConfig.consume?.resources !== false) ) {
    const die = scaleDie(actor, "monk", "martial-arts", "d6");
    return heal(actor, `1${die}`, loc("Class.Reason.Patient"));
  }

  // Rogue: Sneak Attack from an attack roll with Advantage heals Proficiency Bonus.
  if ( id === "sneak-attack" ) {
    const last = lastAttack.get(actor.uuid);
    lastAttack.delete(actor.uuid);
    if ( last?.advantage && last.hit && ((Date.now() - last.time) < 120000) ) {
      await addStress(actor, -prof(actor), { reason: loc("Class.Reason.Sneak") });
    }
    return;
  }

  // Sorcerer: Calming Spell (2 Sorcery Points): each targeted ally heals Stress equal to your CHA modifier.
  if ( id === "calming-spell" ) {
    const font = actor.items.find(i => ["font-of-magic", "sorcery-points"].includes(ident(i)) && i.system.uses?.max);
    const left = font ? (font.system.uses.value ?? (font.system.uses.max - font.system.uses.spent)) : 0;
    if ( left < 2 ) return ui.notifications.warn(loc("Class.Calming.NoPoints"));
    const pcs = targets.filter(tracksStress);
    if ( !pcs.length ) return ui.notifications.warn(loc("Class.Calming.NoTargets"));
    await font.update({ "system.uses.spent": font.system.uses.spent + 2 });
    const n = Math.max(1, mod(actor, "cha"));
    for ( const t of pcs ) await addStress(t, -n, { reason: loc("Class.Reason.Calming", { name: actor.name }) });
    return;
  }

  // Wizard: Arcane Recovery heals 1d4 Stress per spell slot level recovered.
  if ( id === "arcane-recovery" ) {
    const max = Math.ceil(classLevels(actor, "wizard") / 2) || 1;
    const n = await askNumber(item.name, loc("Class.ArcaneRecovery.Ask"), max, max);
    if ( n ) await heal(actor, `${n}d4`, loc("Class.Reason.ArcaneRecovery", { n }));
    return;
  }

  // Blood Hunter: Crimson Rite heals twice the Hemocraft die.
  if ( id === "crimson-rite" ) {
    const level = classLevels(actor, "blood-hunter");
    const fallback = level >= 17 ? "d10" : level >= 11 ? "d8" : level >= 5 ? "d6" : "d4";
    const die = scaleDie(actor, "blood-hunter", "hemocraft-die", fallback);
    return heal(actor, `2 * 1${die}`, loc("Class.Reason.Crimson"));
  }
}

/* -------------------------------------------- */
/*  Rage ends                                   */
/* -------------------------------------------- */

function rageActor(effect) {
  if ( slug(effect.name) !== "rage" ) return null;
  const parent = effect.parent;
  const actor = parent?.documentName === "Actor" || (parent && parent.items) ? parent : parent?.actor;
  return tracksStress(actor) && classLevels(actor, "barbarian") ? actor : null;
}

async function rageEnded(actor) {
  if ( !enabled() ) return;
  const n = classLevels(actor, "barbarian");
  await addStress(actor, -n, { reason: loc("Class.Reason.RageEnd", { n }) });
}

function registerRage() {
  Hooks.on("updateActiveEffect", (effect, changes, options, userId) => {
    if ( (userId !== game.user.id) || (changes.disabled !== true) ) return;
    const actor = rageActor(effect);
    if ( actor ) rageEnded(actor);
  });
  Hooks.on("deleteActiveEffect", (effect, options, userId) => {
    if ( (userId !== game.user.id) || effect.disabled ) return;
    const actor = rageActor(effect);
    if ( actor ) rageEnded(actor);
  });
}

/* -------------------------------------------- */
/*  Rests: Song of Rest, Dark Commune           */
/* -------------------------------------------- */

/** A party Bard (not this actor) who can sing during a short rest: { bard, die }. */
export function partyBard(actor) {
  const bard = partyMembers().find(a => (a !== actor) && classLevels(a, "bard") && findFeat(a, "bardic-inspiration"));
  return bard ? { bard, die: scaleDie(bard, "bard", "inspiration") } : null;
}

/** The Bard spends one Bardic Inspiration for the whole short rest (once per rest). */
export async function songOfRest(bard) {
  const now = game.time.worldTime;
  if ( bard.getFlag(MODULE_ID, "songOfRest") === now ) return;
  await bard.setFlag(MODULE_ID, "songOfRest", now);
  const item = findFeat(bard, "bardic-inspiration");
  const uses = item?.system?.uses;
  if ( uses?.max ) await item.update({ "system.uses.spent": Math.min(uses.max, (uses.spent ?? 0) + 1) });
  await card(bard, `<p>${loc("Class.SongOfRest.Sung", { name: esc(bard.name) })}</p>`, { cls: "sr-virtue" });
}

export function requestSongOfRest(bard) {
  if ( bard.isOwner ) return songOfRest(bard);
  return requestGM("songOfRest", { actorUuid: bard.uuid });
}

/** Can this Warlock use Dark Commune tonight? */
export function canDarkCommune(actor) {
  return !!findFeat(actor, "dark-commune") && ((Number(actor.system.spells?.pact?.value) || 0) > 0);
}

/** Dark Commune: you and the allies resting gain Stress equal to your CHA modifier. */
export async function darkCommune(actor) {
  const n = Math.max(1, mod(actor, "cha"));
  await card(actor, `<p>${loc("Class.DarkCommune.Text", { name: esc(actor.name), n })}</p>`, { cls: "sr-affliction" });
  const resting = new Set([actor, ...partyMembers()]);
  for ( const a of resting ) await addStress(a, n, { reason: loc("Class.Reason.DarkCommune", { name: actor.name }) });
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerClasses() {
  riders.reduceStress = reduceStress;
  registerHandler("suppress", (actor, { casterUuid }) => suppress(actor, casterUuid));
  registerHandler("songOfRest", actor => songOfRest(actor));
  registerButtons();
  registerChoices();
  registerRage();
  registerCalm();

  Hooks.on("dnd5e.rollAttackV2", (rolls, { subject }) => {
    const actor = subject?.actor;
    const roll = rolls?.[0];
    if ( !actor || !roll ) return;
    lastAttack.set(actor.uuid, { advantage: !!roll.hasAdvantage, hit: roll.isFailure !== true, time: Date.now() });
  });

  Hooks.on("dnd5e.postUseActivity", (activity, usageConfig) => {
    afterUse(activity, usageConfig).catch(err => console.error(`${MODULE_ID} | Class rider failed`, err));
  });
}
