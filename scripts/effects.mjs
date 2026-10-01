/**
 * Affliction and virtue mechanics, and fear Stress.
 *
 * - Static effects become Active Effect changes on the condition's status effect.
 * - Start/end-of-turn effects run on the active GM's client from the combat turn change.
 * - Roll-time effects (advantage, maximised damage, rerolls) use dnd5e roll hooks.
 * - Refusing or withholding aid cancels an activity before anything is spent, then re-runs it on a pass.
 */
import { MODULE_ID, statusId } from "./constants.mjs";
import { resolveResult, tokenDistance } from "./math.mjs";
import {
  activeAfflictions, addStress, getData, hasCondition, mechanics, postCard, setSubCondition, tracksStress
} from "./stress.mjs";
import { registerHandler, requestGM } from "./socket.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const name = key => loc(`Condition.${key}.Name`);
const setting = key => game.settings.get(MODULE_ID, key);
const DEX_SAVE = "system.abilities.dex.save.roll.mode";

/* -------------------------------------------- */
/*  Static effects (Active Effect changes)      */
/* -------------------------------------------- */

/** Changes applied while a condition is active. Values use the dnd5e 6 change format. */
const CHANGES = {
  hopeless: () => [
    { key: "system.attributes.movement.bonus", type: "add", value: "-10" }
  ],
  masochistic: () => [
    { key: "system.attributes.death.roll.mode", type: "add", value: -1 }
  ],
  rapturous: () => [
    { key: "system.rolls.attack.mode", type: "add", value: 1 },
    { key: "system.attributes.init.roll.mode", type: "add", value: 1 },
    { key: DEX_SAVE, type: "add", value: -1 },
    { key: "system.traits.dm.amount.ALL", type: "override", value: "-@attributes.prof" }
  ],
  courageous: () => [
    { key: "system.traits.ci.value", type: "add", value: "frightened" }
  ],
  stalwart: () => [
    { key: "system.traits.ci.value", type: "add", value: "charmed" }
  ],
  vigorous: () => [
    { key: "system.rolls.ability.save.mode", type: "add", value: 1 }
  ],
  focused: actor => {
    // Crit one lower than now: 20 → 19, or 19 → 18 if already expanded.
    const weapon = Number(actor.flags?.dnd5e?.weaponCriticalThreshold) || 20;
    const spell = Number(actor.flags?.dnd5e?.spellCriticalThreshold) || 20;
    return [
      { key: "flags.dnd5e.weaponCriticalThreshold", type: "override", value: Math.max(2, weapon - 1) },
      { key: "flags.dnd5e.spellCriticalThreshold", type: "override", value: Math.max(2, spell - 1) },
      { key: DEX_SAVE, type: "add", value: 1 },
      { key: "system.bonuses.spell.dc", type: "add", value: "1" }
    ];
  }
};

/** Put the right changes on an effect, whichever schema this core version uses. */
function changesUpdate(effect, changes) {
  return effect.system?.schema?.fields?.changes ? { "system.changes": changes } : { changes };
}

async function applyMechanics(actor, key) {
  const make = CHANGES[key];
  if ( !make ) return;
  const effect = actor.effects.find(e => e.statuses?.has(statusId(key)));
  if ( effect ) await effect.update(changesUpdate(effect, make(actor)));
}

async function clearMechanics(actor) {
  await actor.update({
    [`flags.${MODULE_ID}.rerolls`]: 0,
    [`flags.${MODULE_ID}.maxNext`]: false,
    [`flags.${MODULE_ID}.fearedBy`]: []
  });
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function isResponsibleGM() {
  return game.user.isGM && (game.users.activeGM?.id === game.user.id);
}

function tokenDocFor(actor, scene) {
  if ( actor.isToken ) return actor.token;
  return scene?.tokens.find(t => t.actorId === actor.id) ?? null;
}

function disposition(actor, scene) {
  return tokenDocFor(actor, scene)?.disposition ?? actor.prototypeToken?.disposition ?? 0;
}

function isAlly(a, b, scene=canvas.scene) {
  return (a !== b) && (disposition(a, scene) === disposition(b, scene));
}

/**
 * The scene and token where an actor stands. The given scene first (the combat's), then the viewed scene,
 * then any scene of the active combat's combatants: an encounter not linked to a scene has no `combat.scene`.
 */
export function locateToken(actor, scene) {
  const candidates = [scene, canvas?.scene, ...(game.combat?.combatants ?? []).map(c => c.token?.parent)];
  for ( const s of candidates ) {
    if ( !s?.tokens ) continue;
    const token = tokenDocFor(actor, s);
    if ( token ) return { scene: s, token };
  }
  return { scene: null, token: null };
}

/** Opposite sides: one friendly and the other hostile. Neutral or secret tokens count as the same side. */
const opposed = (a, b) => (a * b) < 0;

/** Player characters within the "nearby" range of an actor's token. */
export function nearbyAllies(actor, scene) {
  const { scene: where, token: origin } = locateToken(actor, scene);
  if ( !origin ) {
    log(`${actor.name}: no token found on the combat or viewed scene, so no nearby allies`);
    return [];
  }
  const range = Number(setting("nearbyRange")) || 30;
  const grid = { size: where.grid.size, distance: where.grid.distance };
  const seen = new Set([actor.uuid]);
  const allies = [];
  for ( const t of where.tokens ) {
    const other = t.actor;
    if ( !other || seen.has(other.uuid) || !tracksStress(other) ) continue;
    const distance = tokenDistance(origin, t, grid);
    const ok = !opposed(t.disposition ?? 0, origin.disposition ?? 0) && (distance <= range);
    log(`${actor.name} → ${other.name}: ${distance} ${where.grid.units ?? "ft"}, disposition ${t.disposition}/${origin.disposition} → ${ok ? "nearby" : "not nearby"}`);
    if ( !ok ) continue;
    seen.add(other.uuid);
    allies.push(other);
  }
  return allies;
}

function log(message) {
  if ( game.settings.get(MODULE_ID, "debug") ) console.log(`${MODULE_ID} | ${message}`);
}

/** Friendly combatants (any creature) sharing a combat with the actor, including the actor. */
function friendlyCombatants(combat, actor) {
  const disp = locateToken(actor, combat.scene).token?.disposition ?? disposition(actor, combat.scene);
  const out = new Set();
  for ( const c of combat.combatants ) {
    if ( c.actor && (c.token?.disposition ?? disposition(c.actor, combat.scene)) === disp ) out.add(c.actor);
  }
  return [...out];
}

function inCombat(actor) {
  const combat = game.combat;
  return !!(combat?.started && combat.combatants.some(c => c.actor === actor || c.actorId === actor.id));
}

const halfLevelProf = actor => Math.floor((actor.system.details?.level ?? 1) / 2) + (actor.system.attributes?.prof ?? 0);

async function roll(formula, data={}) {
  return new Roll(formula, data).evaluate();
}

async function card(actor, html, cls="") {
  try {
    return await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="sr-card ${cls}">${html}</div>`
    });
  } catch(err) {
    console.error(`${MODULE_ID} | Could not post a chat card`, err);
  }
}

async function rollCard(actor, r, title, text="", cls="") {
  try {
    await r.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `<div class="sr-card ${cls}"><h3>${title}</h3>${text ? `<p>${text}</p>` : ""}</div>`
    });
  } catch(err) {
    console.error(`${MODULE_ID} | Could not post a roll`, err);
  }
}

/* -------------------------------------------- */
/*  Temporary effects                           */
/* -------------------------------------------- */

/**
 * Create a temporary effect this module removes itself.
 * @param {Actor} actor
 * @param {object} data
 * @param {object} expire  { combatantId, when: "turnStart"|"turnEnd" } or { next: "attackOrSave" }
 */
async function addTemp(actor, { name: label, img, changes }, expire) {
  const data = { name: label, img, disabled: false, flags: { [MODULE_ID]: { temp: expire } } };
  const effect = (await actor.createEmbeddedDocuments("ActiveEffect", [data]))?.[0];
  if ( effect && changes?.length ) await effect.update(changesUpdate(effect, changes));
  return effect;
}

async function expireTemps(combat, combatantId, when) {
  for ( const c of combat.combatants ) {
    const actor = c.actor;
    if ( !actor ) continue;
    const ids = actor.effects.filter(e => {
      const t = e.getFlag(MODULE_ID, "temp");
      return t && (t.combatantId === combatantId) && (t.when === when);
    }).map(e => e.id);
    if ( ids.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  }
}

async function clearAllTemps(combat) {
  for ( const c of combat.combatants ) {
    const actor = c.actor;
    if ( !actor ) continue;
    const ids = actor.effects.filter(e => e.getFlag(MODULE_ID, "temp")?.combatantId).map(e => e.id);
    if ( ids.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  }
}

/* -------------------------------------------- */
/*  Turn processing (active GM only)            */
/* -------------------------------------------- */

let queue = Promise.resolve();
const enqueue = fn => { queue = queue.then(fn).catch(err => console.error(`${MODULE_ID} | Turn effects failed`, err)); };

async function onTurnStart(combat, combatantId) {
  if ( !combatantId ) return;
  await expireTemps(combat, combatantId, "turnStart");
  const combatant = combat.combatants.get(combatantId);
  const actor = combatant?.actor;
  if ( !tracksStress(actor) || combatant.isDefeated ) return;
  const data = getData(actor);
  if ( !data.state || data.suppressed ) return;

  // Refracted: a new Resolve roll each turn; an affliction lasts until the next turn starts.
  if ( data.condition === "refracted" ) {
    const r = await roll("1d100");
    const result = resolveResult(r.total);
    const sub = result.type === "affliction" ? result.key : null;
    await setSubCondition(actor, sub);
    await rollCard(actor, r, loc("Fx.Refracted.Title", { name: esc(actor.name) }),
      sub ? loc("Fx.Refracted.Afflicted", { result: name(sub) }) : loc("Fx.Refracted.Nothing", { result: name(result.key) }),
      "sr-affliction");
  }

  let lostTurn = false;
  for ( const key of activeAfflictions(actor) ) {
    if ( key === "irrational" ) lostTurn = (await irrational(actor, combat)) === 6;
    if ( key === "fearful" ) await fearful(actor, combat, combatantId);
  }

  if ( data.state === "virtuous" ) await virtueTurnStart(actor, data.condition, combat, combatantId);
  if ( hasCondition(actor, "rapturous") ) await grantReroll(actor, 1, { atLeast: true });
  await turnReminder(actor, { lostTurn });
}

/** Rules Foundry can't enforce reliably, per condition. The table handles these. */
const MANUAL_RULES = new Set(["paranoid", "selfish", "masochistic", "rapturous", "courageous"]);

/**
 * Whisper the GM and the character's players a reminder of the rules they must apply themselves this turn.
 * @param {Actor} actor
 * @param {object} [options]
 * @param {boolean} [options.lostTurn]  Irrational rolled a 6: the character loses the rest of the turn.
 */
export async function turnReminder(actor, { lostTurn=false }={}) {
  if ( !setting("turnReminders") ) return;
  const data = getData(actor);
  if ( data.suppressed ) return;
  const keys = [...new Set([data.condition, data.subCondition].filter(Boolean))];
  if ( !keys.length ) return;
  const item = (k, text) => `<li><strong>${name(k)}:</strong> ${text}</li>`;
  const auto = keys.map(k => item(k, loc(`Fx.Reminder.Auto.${k}`)));
  const manual = keys.filter(k => MANUAL_RULES.has(k)).map(k => item(k, loc(`Fx.Reminder.${k}`)));
  if ( lostTurn ) manual.unshift(item("irrational", loc("Fx.Reminder.irrational")));
  const owners = game.users.filter(u => u.isGM || actor.testUserPermission?.(u, "OWNER")).map(u => u.id);
  try {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: owners,
      content: `<div class="sr-card sr-reminder sr-${data.state === "virtuous" ? "virtue" : "affliction"}">
        <h3><i class="fa-solid fa-triangle-exclamation" inert></i> ${loc("Fx.Reminder.Title", { name: esc(actor.name) })}</h3>
        ${manual.length ? `<h4>${loc("Fx.Reminder.ManualHeading")}</h4><ul>${manual.join("")}</ul>` : ""}
        <h4>${loc("Fx.Reminder.AutoHeading")}</h4><ul class="sr-auto">${auto.join("")}</ul></div>`
    });
  } catch(err) {
    console.error(`${MODULE_ID} | Could not post the turn reminder`, err);
  }
}

/** Extra end-of-turn rules other files add (e.g. lingering conditions), run before the affliction aura. */
export const turnEndRules = [];

async function onTurnEnd(combat, combatantId) {
  if ( !combatantId ) return;
  await expireTemps(combat, combatantId, "turnEnd");
  const combatant = combat.combatants.get(combatantId);
  const actor = combatant?.actor;
  if ( !tracksStress(actor) ) return;
  for ( const rule of turnEndRules ) {
    try {
      if ( !combatant.isDefeated ) await rule(actor, combat);
    } catch(err) {
      console.error(`${MODULE_ID} | End-of-turn rule failed`, err);
    }
  }

  // Unused rerolls don't carry past the end of this character's turn.
  if ( getData(actor).rerolls ) await actor.setFlag(MODULE_ID, "rerolls", 0);

  // Afflicted characters cause 1d4 Stress to nearby allies at the end of their turn.
  const afflictions = activeAfflictions(actor).filter(k => k !== "refracted");
  if ( !afflictions.length || combatant.isDefeated ) return;
  const allies = nearbyAllies(actor, combat.scene).filter(a => !hasCondition(a, "vigorous"));
  const r = await roll("1d4");
  await rollCard(actor, r, loc("Fx.Aura.Title", { name: esc(actor.name), condition: name(afflictions[0]) }),
    allies.length ? loc("Fx.Aura.Targets", { names: allies.map(a => esc(a.name)).join(", ") }) : loc("Fx.Aura.None"),
    "sr-affliction");
  for ( const ally of allies ) {
    await addStress(ally, r.total, { reason: loc("Reason.Aura", { name: actor.name, condition: name(afflictions[0]) }) });
  }
}

/* Irrational: d6 each turn. */
async function irrational(actor, combat) {
  const r = await roll("1d6");
  const title = loc("Fx.Irrational.Title", { name: esc(actor.name) });
  if ( r.total <= 3 ) {
    await rollCard(actor, r, title, loc("Fx.Irrational.Normal"), "sr-affliction");
    return r.total;
  }
  if ( r.total <= 5 ) {
    const s = await roll("1d6");
    const allies = nearbyAllies(actor, combat.scene);
    await rollCard(actor, r, title, loc("Fx.Irrational.Rant", { n: s.total }), "sr-affliction");
    for ( const target of [actor, ...allies] ) {
      await addStress(target, s.total, { reason: loc("Reason.Irrational", { name: actor.name }) });
    }
    return r.total;
  }
  // 6: attacks themself for 1d8 of their weapon's damage type, and loses the turn.
  const weapon = actor.items.find(i => (i.type === "weapon") && i.system.equipped)
    ?? actor.items.find(i => i.type === "weapon");
  const types = weapon?.system?.damage?.base?.types;
  const type = (types && [...types][0]) || "bludgeoning";
  const d = await roll("1d8");
  await rollCard(actor, r, title, loc("Fx.Irrational.Self", {
    weapon: esc(weapon?.name ?? loc("Fx.Irrational.Unarmed")), n: d.total,
    type: CONFIG.DND5E.damageTypes[type]?.label ?? type
  }), "sr-affliction");
  await actor.applyDamage([{ value: d.total, type }]);
  return 6;
}

/* Fearful: frightened of a random enemy each turn; the same enemy twice doubles the Stress. */
async function fearful(actor, combat, combatantId) {
  const origin = locateToken(actor, combat.scene).token;
  const enemies = combat.combatants.filter(c => c.actor && !c.isDefeated && c.token
    && (c.token.disposition !== (origin?.disposition ?? 1)) && (c.token.disposition !== 0) && c.actor !== actor);
  if ( !enemies.length ) return;
  const enemy = enemies[Math.floor(Math.random() * enemies.length)];
  const cr = Number(enemy.actor.system?.details?.cr) || 0;
  const history = getData(actor).fearedBy;
  const twice = history.includes(enemy.actor.uuid);
  const amount = twice ? cr * 2 : cr;
  await actor.setFlag(MODULE_ID, "fearedBy", [...new Set([...history, enemy.actor.uuid])]);

  // Frightened until the start of their next turn, marked so the generic fear rule doesn't add Stress again.
  try {
    const data = await ActiveEffect.implementation.fromStatusEffect("frightened");
    const source = data.toObject?.() ?? data;
    source.origin = enemy.actor.uuid;
    foundry.utils.setProperty(source, `flags.${MODULE_ID}.fearful`, true);
    foundry.utils.setProperty(source, `flags.${MODULE_ID}.temp`, { combatantId, when: "turnStart" });
    await actor.createEmbeddedDocuments("ActiveEffect", [source]);
  } catch(err) {
    console.error(`${MODULE_ID} | Could not apply Frightened`, err);
  }
  await card(actor, `<h3>${loc("Fx.Fearful.Title", { name: esc(actor.name) })}</h3>
    <p>${loc(twice ? "Fx.Fearful.Again" : "Fx.Fearful.Text", { enemy: esc(enemy.name), cr: formatCR(cr) })}</p>`,
  "sr-affliction");
  await addStress(actor, amount, { reason: loc("Reason.Fear", { enemy: enemy.name }), sourceUuid: enemy.actor.uuid });
}

/* Virtues: start-of-turn benefits and the d4 roll. */
async function virtueTurnStart(actor, key, combat, combatantId) {
  if ( key === "vigorous" ) {
    const t = await roll("1d12");
    await actor.applyTempHP(t.total);
    await rollCard(actor, t, loc("Fx.Vigorous.TempTitle", { name: esc(actor.name) }), loc("Fx.Vigorous.Temp", { n: t.total }), "sr-virtue");
  }
  if ( key === "powerful" ) {
    await grantReroll(actor, 1, { atLeast: true });
    for ( const ally of nearbyAllies(actor, combat.scene) ) await grantReroll(ally, 1);
  }
  if ( !["powerful", "courageous", "stalwart", "vigorous", "focused"].includes(key) ) return;

  const d4 = await roll("1d4");
  const title = loc("Fx.Virtue.Title", { name: esc(actor.name), virtue: name(key) });
  if ( d4.total !== 4 ) return rollCard(actor, d4, title, loc("Fx.Virtue.Miss"), "sr-virtue");

  const prof = actor.system.attributes?.prof ?? 0;
  if ( key === "powerful" ) {
    await actor.setFlag(MODULE_ID, "maxNext", true);
    return rollCard(actor, d4, title, loc("Fx.Powerful.Max"), "sr-virtue");
  }
  if ( key === "courageous" ) {
    const n = halfLevelProf(actor);
    await rollCard(actor, d4, title, loc("Fx.Courageous.Heal", { n }), "sr-virtue");
    for ( const target of [actor, ...nearbyAllies(actor, combat.scene)] ) {
      await addStress(target, -n, { reason: loc("Reason.Virtue", { name: actor.name, virtue: name(key) }) });
    }
    return;
  }
  if ( key === "stalwart" ) {
    const n = halfLevelProf(actor);
    await rollCard(actor, d4, title, loc("Fx.Stalwart.Heal", { n }), "sr-virtue");
    return addStress(actor, -n, { reason: loc("Reason.Virtue", { name: actor.name, virtue: name(key) }) });
  }
  if ( key === "vigorous" ) {
    await rollCard(actor, d4, title, loc("Fx.Vigorous.Shield", { n: prof }), "sr-virtue");
    for ( const target of friendlyCombatants(combat, actor) ) {
      await addTemp(target, {
        name: loc("Fx.Vigorous.EffectName", { name: actor.name }), img: "icons/svg/regen.svg",
        changes: [{ key: "system.traits.dm.amount.ALL", type: "override", value: String(-prof) }]
      }, { combatantId, when: "turnStart" });
    }
    return;
  }
  if ( key === "focused" ) {
    await rollCard(actor, d4, title, loc("Fx.Focused.Allies"), "sr-virtue");
    for ( const target of friendlyCombatants(combat, actor).filter(a => a !== actor) ) {
      await addTemp(target, {
        name: loc("Fx.Focused.EffectName", { name: actor.name }), img: "icons/svg/target.svg",
        changes: [
          { key: "flags.dnd5e.weaponCriticalThreshold", type: "downgrade", value: 19 },
          { key: "flags.dnd5e.spellCriticalThreshold", type: "downgrade", value: 19 }
        ]
      }, { combatantId, when: "turnStart" });
    }
  }
}

async function grantReroll(actor, n, { atLeast=false }={}) {
  if ( !tracksStress(actor) ) return;
  const current = Number(actor.getFlag(MODULE_ID, "rerolls")) || 0;
  const next = atLeast ? Math.max(current, n) : current + n;
  if ( next !== current ) await actor.setFlag(MODULE_ID, "rerolls", next);
}

function formatCR(cr) {
  return ({ 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" })[cr] ?? String(cr);
}

/* -------------------------------------------- */
/*  Rolls                                       */
/* -------------------------------------------- */

function actorFromSubject(subject) {
  if ( !subject ) return null;
  if ( subject instanceof Actor ) return subject;
  return subject.actor ?? subject.parent?.actor ?? null;
}

function registerRollHooks() {
  // Rapturous: attacks against them have advantage.
  Hooks.on("dnd5e.preRollAttackV2", config => {
    if ( !setting("automateEffects") ) return;
    const targets = [...game.user.targets].map(t => t.actor).filter(Boolean);
    if ( !targets.some(a => hasCondition(a, "rapturous")) ) return;
    for ( const r of config.rolls ?? [] ) { r.options ??= {}; r.options.advantage = true; }
  });

  // Hopeless: no advantage on any roll during combat. Runs last (generic hook).
  Hooks.on("dnd5e.preRollV2", config => {
    if ( !setting("automateEffects") ) return;
    const actor = actorFromSubject(config.subject);
    if ( !actor || !hasCondition(actor, "hopeless") || !inCombat(actor) ) return;
    for ( const r of config.rolls ?? [] ) if ( r.options && ("advantage" in r.options) ) r.options.advantage = false;
  });

  // Powerful: the next attack or spell deals maximum damage.
  Hooks.on("dnd5e.postDamageRollConfiguration", (rolls, config) => {
    if ( !setting("automateEffects") ) return;
    const actor = actorFromSubject(config.subject);
    if ( !actor?.isOwner || !actor.getFlag(MODULE_ID, "maxNext") ) return;
    for ( const r of rolls ) {
      const evaluate = r.evaluate.bind(r);
      r.evaluate = (options={}) => evaluate({ ...options, maximize: true });
    }
    actor.setFlag(MODULE_ID, "maxNext", false);
    card(actor, `<p>${loc("Fx.Powerful.Used", { name: esc(actor.name) })}</p>`, "sr-virtue");
  });

  // Abusive: allies who miss an attack take 1d6 Stress; a 6 gives disadvantage on their next attack or save.
  Hooks.on("dnd5e.rollAttackV2", async (rolls, { subject }) => {
    const attacker = subject?.actor;
    if ( !setting("automateEffects") || !tracksStress(attacker) || !attacker.isOwner ) return;
    await consumeNextRollPenalty(attacker);
    if ( !rolls?.[0]?.isFailure || !canvas.scene ) return;
    const abusers = canvas.scene.tokens.map(t => t.actor)
      .filter(a => a && (a !== attacker) && hasCondition(a, "abusive") && isAlly(a, attacker));
    for ( const abuser of abusers ) {
      const r = await roll("1d6");
      await rollCard(abuser, r, loc("Fx.Abusive.Title", { name: esc(abuser.name), target: esc(attacker.name) }),
        r.total === 6 ? loc("Fx.Abusive.Six") : "", "sr-affliction");
      await addStress(attacker, r.total, { reason: loc("Reason.Abusive", { name: abuser.name }) });
      if ( r.total === 6 ) {
        await addTemp(attacker, {
          name: loc("Fx.Abusive.EffectName", { name: abuser.name }), img: "icons/svg/sword.svg",
          changes: [
            { key: "system.rolls.attack.mode", type: "add", value: -1 },
            { key: "system.rolls.ability.save.mode", type: "add", value: -1 }
          ]
        }, { next: "attackOrSave" });
      }
    }
  });

  // Remove "next attack or save" penalties once a save is configured.
  Hooks.on("dnd5e.postRollConfiguration", (rolls, config) => {
    const names = (config.hookNames ?? []).map(n => String(n).toLowerCase());
    if ( !names.some(n => n.includes("save")) ) return;
    const actor = actorFromSubject(config.subject);
    if ( actor?.isOwner ) setTimeout(() => consumeNextRollPenalty(actor), 0);
  });
}

async function consumeNextRollPenalty(actor) {
  const ids = actor.effects.filter(e => e.getFlag(MODULE_ID, "temp")?.next === "attackOrSave").map(e => e.id);
  if ( ids.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
}

/* -------------------------------------------- */
/*  Damage die reroll (Powerful, Rapturous)     */
/* -------------------------------------------- */

function registerRerollButton() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const DamageRoll = CONFIG.Dice.DamageRoll;
    if ( !DamageRoll || !message.rolls?.some(r => r instanceof DamageRoll) ) return;
    const actor = ChatMessage.getSpeakerActor(message.speaker);
    if ( !tracksStress(actor) || !actor.isOwner || !message.isOwner ) return;
    const available = Number(actor.getFlag(MODULE_ID, "rerolls")) || 0;
    if ( available <= 0 ) return;
    const content = html.querySelector(".message-content") ?? html;
    if ( content.querySelector(".sr-reroll") ) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sr-reroll";
    button.innerHTML = `<i class="fa-solid fa-dice" inert></i> ${loc("Fx.Reroll.Button", { n: available })}`;
    button.addEventListener("click", async event => {
      event.preventDefault();
      button.disabled = true;
      await rerollLowestDie(message, actor);
    });
    content.append(button);
  });
}

/** Reroll the lowest active damage die in a message and update its total. */
export async function rerollLowestDie(message, actor) {
  const available = Number(actor.getFlag(MODULE_ID, "rerolls")) || 0;
  if ( available <= 0 ) return;
  const rolls = message.rolls.map(r => Roll.fromData(r.toJSON()));
  let pick = null;
  for ( const r of rolls ) {
    for ( const die of r.dice ) {
      for ( const res of die.results ) {
        if ( !res.active || res.rerolled || res.discarded ) continue;
        if ( !pick || (res.result < pick.res.result) ) pick = { r, die, res };
      }
    }
  }
  if ( !pick ) return;
  const fresh = await roll(`1d${pick.die.faces}`);
  const old = pick.res.result;
  pick.res.active = false;
  pick.res.rerolled = true;
  pick.die.results.push({ result: fresh.total, active: true });
  pick.r._total = pick.r._evaluateTotal();
  await message.update({ rolls: rolls.map(r => r.toJSON()) });
  await actor.setFlag(MODULE_ID, "rerolls", available - 1);
  await card(actor, `<p>${loc("Fx.Reroll.Done", { name: esc(actor.name), die: `d${pick.die.faces}`, old, now: fresh.total })}</p>`, "sr-virtue");
}

/* -------------------------------------------- */
/*  Refusing and withholding aid                */
/* -------------------------------------------- */

const approved = new Set();

function isHelpful(activity) {
  if ( activity.type === "heal" ) return true;
  const effects = activity.effects?.length ?? 0;
  return ["utility", "enchant", "cast"].includes(activity.type) && (effects > 0);
}

function registerAidGate() {
  Hooks.on("dnd5e.preUseActivity", activity => {
    if ( !setting("automateEffects") || !setting("gateAid") ) return;
    if ( approved.delete(activity.uuid) ) return;
    const user = activity.actor;
    if ( !user || !isHelpful(activity) ) return;
    const targets = [...game.user.targets].map(t => t.actor).filter(a => a && (a !== user));
    if ( !targets.length ) return;

    const gates = [];
    if ( hasCondition(user, "selfish") && targets.some(a => isAlly(user, a)) ) {
      gates.push({ roller: user, key: "selfish", blockOutside: false });
    }
    for ( const target of targets ) {
      if ( !isAlly(user, target) ) continue;
      if ( hasCondition(target, "paranoid") ) gates.push({ roller: target, key: "paranoid", blockOutside: true });
      else if ( hasCondition(target, "masochistic") && (activity.type === "heal") ) {
        gates.push({ roller: target, key: "masochistic", blockOutside: true });
      }
    }
    if ( !gates.length ) return;
    runGates(activity, gates);
    return false;
  });
}

async function runGates(activity, gates) {
  for ( const gate of gates ) {
    const { roller, key } = gate;
    if ( gate.blockOutside && !inCombat(roller) ) {
      ui.notifications.warn(loc("Fx.Aid.RefusedOutside", { name: roller.name, condition: name(key) }));
      await card(roller, `<p>${loc("Fx.Aid.RefusedOutside", { name: esc(roller.name), condition: name(key) })}</p>`, "sr-affliction");
      return;
    }
    let passed = false;
    try {
      const rolls = await roller.rollSavingThrow({ ability: "cha", target: 15 }, { configure: false },
        { data: { flavor: loc("Fx.Aid.SaveFlavor", { name: roller.name, condition: name(key) }) } });
      passed = !!rolls?.[0]?.isSuccess;
    } catch(err) {
      console.error(`${MODULE_ID} | Aid save failed to roll`, err);
    }
    if ( !passed ) {
      await card(roller, `<p>${loc(`Fx.Aid.Failed.${key}`, { name: esc(roller.name), item: esc(activity.item?.name) })}</p>`, "sr-affliction");
      return;
    }
  }
  // All saves passed: run the activity again, letting it through this time.
  const real = activity.actor?.items.get(activity.item?.id)?.system?.activities?.get(activity.id);
  if ( !real ) return;
  approved.add(real.uuid);
  try {
    await real.use();
  } finally {
    approved.delete(real.uuid);
  }
}

/* -------------------------------------------- */
/*  Fear: Stress when Frightened                */
/* -------------------------------------------- */

export function sourceActor(effect) {
  let uuid = effect.origin;
  if ( !uuid ) return null;
  if ( uuid.includes(".Activity.") ) uuid = uuid.split(".Activity.")[0];
  const doc = fromUuidSync(uuid, { strict: false });
  if ( !doc ) return null;
  if ( doc instanceof Actor ) return doc;
  if ( doc instanceof Item ) return doc.actor;
  return doc.actor ?? doc.parent?.actor ?? (doc.parent instanceof Actor ? doc.parent : null);
}

function registerFear() {
  Hooks.on("createActiveEffect", async (effect, options, userId) => {
    if ( userId !== game.user.id ) return;
    const actor = effect.parent;
    if ( !(actor instanceof Actor) || !tracksStress(actor) ) return;
    if ( !effect.statuses?.has("frightened") || effect.getFlag(MODULE_ID, "fearful") ) return;
    if ( !setting("fearStress") ) return;
    if ( actor.system.traits?.ci?.value?.has?.("frightened") ) return;

    const source = sourceActor(effect);
    const cr = source?.system?.details?.cr;
    if ( Number.isFinite(Number(cr)) && (source.type !== "character") ) {
      return addStress(actor, Number(cr), { reason: loc("Reason.Fear", { enemy: source.name }), sourceUuid: source.uuid });
    }
    // Unknown source: the GM picks the creature or types a CR.
    if ( game.user.isGM ) return fearPrompt(actor);
    requestGM("fearPrompt", { actorUuid: actor.uuid });
  });
  registerHandler("fearPrompt", actor => fearPrompt(actor));
}

async function fearPrompt(actor) {
  const scene = canvas.scene;
  const creatures = (scene?.tokens ?? []).filter(t => t.actor && (t.actor.type === "npc"))
    .map(t => ({ name: t.name, cr: Number(t.actor.system?.details?.cr) || 0 }))
    .sort((a, b) => b.cr - a.cr);
  const options = creatures.map((c, i) => `<option value="${c.cr}" ${i === 0 ? "selected" : ""}>${esc(c.name)} (CR ${formatCR(c.cr)})</option>`);
  const content = `
    <p>${loc("Fx.FearPrompt.Body", { name: esc(actor.name) })}</p>
    ${options.length ? `<div class="form-group"><label>${loc("Fx.FearPrompt.Creature")}</label>
      <select name="creature">${options.join("")}<option value="">—</option></select></div>` : ""}
    <div class="form-group"><label>${loc("Fx.FearPrompt.CR")}</label>
      <input type="text" name="cr" placeholder="${options.length ? loc("Fx.FearPrompt.Optional") : "1/2"}"></div>`;
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: loc("Fx.FearPrompt.Title") },
    content,
    buttons: [
      { action: "ok", label: loc("Fx.FearPrompt.Apply"), default: true,
        callback: (event, button) => {
          const f = button.form.elements;
          const typed = f.cr?.value?.trim();
          if ( typed ) return typed.includes("/") ? typed.split("/").reduce((a, b) => Number(a) / Number(b)) : Number(typed);
          return f.creature?.value !== "" ? Number(f.creature?.value) : null;
        } },
      { action: "skip", label: loc("Fx.FearPrompt.Skip") }
    ],
    rejectClose: false
  });
  if ( typeof result !== "number" || !Number.isFinite(result) ) return;
  await addStress(actor, result, { reason: loc("Reason.FearUnknown") });
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerEffects() {
  mechanics.apply = applyMechanics;
  mechanics.clear = clearMechanics;

  Hooks.on("combatTurnChange", (combat, prior, current) => {
    if ( !isResponsibleGM() || !setting("automateEffects") ) return;
    enqueue(async () => {
      // A new turn: the previous combatant's turn ended (even if it's the same combatant in a new round).
      const changed = (prior?.combatantId !== current?.combatantId) || (prior?.round !== current?.round)
        || (prior?.turn !== current?.turn);
      if ( prior?.combatantId && changed ) await onTurnEnd(combat, prior.combatantId);
      await onTurnStart(combat, current?.combatantId);
    });
  });
  Hooks.on("deleteCombat", combat => {
    if ( !isResponsibleGM() ) return;
    enqueue(async () => {
      await clearAllTemps(combat);
      for ( const c of combat.combatants ) {
        if ( tracksStress(c.actor) && getData(c.actor).subCondition ) await setSubCondition(c.actor, null);
      }
    });
  });

  registerRollHooks();
  registerRerollButton();
  registerAidGate();
  registerFear();
}
