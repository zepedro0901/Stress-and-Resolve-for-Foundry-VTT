import { AFFLICTIONS, MADNESS_DELAY, MODULE_ID, VIRTUES, statusId } from "./constants.mjs";
import { nextStep, normaliseStress, resolveResult, stressDieFaces, stressLimit } from "./math.mjs";
import { requestGM } from "./socket.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */

/** Only player characters track Stress. */
export function tracksStress(actor) {
  return actor?.type === "character";
}

/** Stored module data for an actor, with defaults. */
export function getData(actor) {
  const flags = actor.flags?.[MODULE_ID] ?? {};
  return {
    value: Number(flags.value) || 0,
    gains: Array.isArray(flags.gains) ? flags.gains : [],
    state: flags.state ?? null,          // "afflicted" | "virtuous" | null
    condition: flags.condition ?? null,  // affliction or virtue key
    since: flags.since ?? null,          // world time the condition began
    heartAttack: !!flags.heartAttack,
    signature: flags.signature ?? {},
    tough: !!flags.tough,
    subCondition: flags.subCondition ?? null,  // Refracted: this turn's affliction
    rerolls: Number(flags.rerolls) || 0,       // damage dice rerolls available (Powerful, Rapturous)
    maxNext: !!flags.maxNext,                  // Powerful: next attack or spell deals maximum damage
    fearedBy: Array.isArray(flags.fearedBy) ? flags.fearedBy : [], // Fearful: enemies already feared
    tempStress: Math.max(0, Number(flags.tempStress) || 0),         // temporary HP protecting Stress
    suppressed: !!flags.suppressed                                  // Calm Emotions: affliction suppressed
  };
}

/** Whether an actor currently has an affliction or virtue (including Refracted's turn affliction). */
export function hasCondition(actor, key) {
  if ( !tracksStress(actor) ) return false;
  const data = getData(actor);
  if ( data.suppressed ) return false;
  return (data.condition === key) || (data.subCondition === key);
}

/** Current affliction keys, including Refracted's turn affliction. */
export function activeAfflictions(actor) {
  const data = getData(actor);
  if ( (data.state !== "afflicted") || data.suppressed ) return [];
  return [data.condition, data.subCondition].filter(Boolean);
}

/** The class item whose hit die sets the level-1 Stress Die. */
export function firstClass(actor) {
  const classes = actor.classes ?? {};
  const originalId = actor.system?.details?.originalClass;
  return Object.values(classes).find(c => c.id === originalId) ?? Object.values(classes)[0] ?? null;
}

/** Stress Die faces for a class item (or the first class). */
export function stressFacesFor(actor, cls=null) {
  cls ??= firstClass(actor);
  return stressDieFaces(cls?.system?.hd?.denomination ?? "d8");
}

export function getLimit(actor) {
  const data = getData(actor);
  const faces = stressFacesFor(actor);
  return stressLimit({
    level: actor.system?.details?.level ?? 1,
    firstFaces: faces,
    defaultFaces: faces,
    wisMod: actor.system?.abilities?.wis?.mod ?? 0,
    gains: data.gains,
    tough: data.tough
  });
}

/* -------------------------------------------- */
/*  Changing Stress                             */
/* -------------------------------------------- */

/**
 * Add (positive) or remove (negative) Stress, then run resolve, mortality or recovery as needed.
 * Players acting on actors they don't own are routed through the GM.
 * @param {Actor} actor
 * @param {number} amount
 * @param {object} [options]
 * @param {string} [options.reason]   Short text shown in chat.
 * @param {boolean} [options.chat]    Override the chat setting.
 * @returns {Promise<number|null>}    New Stress value.
 */
export async function addStress(actor, amount, options={}) {
  if ( !tracksStress(actor) ) return null;
  // Remember who caused the change, even when the GM's client applies it.
  options = { ...options, byUser: options.byUser ?? game.user?.name ?? null };
  if ( !actor.isOwner ) return requestGM("addStress", { actorUuid: actor.uuid, amount, options });

  let delta = normaliseStress(amount);
  if ( !delta ) return getData(actor).value;

  // Condition modifiers on Stress received (not on values typed in by hand).
  const notes = [];
  if ( (delta > 0) && !options.raw ) {
    if ( hasCondition(actor, "hopeless") ) {
      const extra = (await new Roll("1d4").evaluate()).total;
      delta += extra;
      notes.push(loc("Reason.Hopeless", { n: extra }));
    }
    if ( hasCondition(actor, "stalwart") ) {
      const prof = actor.system?.attributes?.prof ?? 0;
      delta = Math.max(1, delta - prof);
      notes.push(loc("Reason.Stalwart", { n: prof }));
    }
  }
  // Class riders (Rage, Aura of Courage, Favored Enemy, Craftsman's Calm) reduce Stress received.
  if ( (delta > 0) && !options.raw && riders.reduceStress ) {
    try {
      const out = riders.reduceStress(actor, delta, options);
      delta = out.delta;
      notes.push(...out.notes);
    } catch(err) {
      console.error(`${MODULE_ID} | Stress reduction failed`, err);
    }
  }
  const before = getData(actor);

  // Temporary hit points protecting Stress soak the gain first.
  let absorbed = 0;
  if ( (delta > 0) && !options.raw && before.tempStress ) {
    absorbed = Math.min(before.tempStress, delta);
    delta -= absorbed;
    await actor.setFlag(MODULE_ID, "tempStress", before.tempStress - absorbed);
    notes.push(loc("Reason.TempAbsorbed", { n: absorbed, left: before.tempStress - absorbed }));
  }
  // Every gain names its source; anything without one says who changed it.
  const source = options.reason
    || ((amount > 0) ? loc("Reason.Unknown", { user: options.byUser ?? "?" }) : null);
  const reason = [source, ...notes].filter(Boolean).join(" ");
  const chat = options.chat ?? game.settings.get(MODULE_ID, "chatOnChange");
  if ( absorbed && !delta ) {
    await gainCard(actor, loc("Chat.TempAbsorbed", { name: actor.name, n: absorbed }), reason, chat);
    return before.value;
  }
  const value = Math.max(0, before.value + delta);
  await actor.setFlag(MODULE_ID, "value", value);

  if ( value > before.value ) {
    // Gains always reach the GM: in public chat, or whispered when Stress chat messages are off.
    await gainCard(actor, loc("Chat.Gain", { name: actor.name, amount: value - before.value, value, limit: getLimit(actor) }),
      reason, chat);
  } else if ( chat && (value !== before.value) ) {
    try {
      await postCard(actor, loc("Chat.Loss", {
        name: actor.name, amount: before.value - value, value, limit: getLimit(actor)
      }), reason);
    } catch(err) {
      console.error(`${MODULE_ID} | Could not post a chat card`, err);
    }
  }

  await checkThresholds(actor, delta > 0);
  return getData(actor).value;
}

/** Set Stress to an exact number (sheet input, config dialog). */
export async function setStress(actor, value, options={}) {
  const current = getData(actor).value;
  return addStress(actor, Math.max(0, Math.round(Number(value) || 0)) - current, { ...options, raw: true });
}

/** Run the next rules step after a change, repeating while something happens. */
async function checkThresholds(actor, gained) {
  // A heart attack is only "pending" while the character is still at 0 HP. Clear stale markers
  // (e.g. HP restored in a way no hook saw) so they can't block the next Mortality.
  if ( getData(actor).heartAttack && ((actor.system?.attributes?.hp?.value ?? 0) > 0) ) {
    await actor.setFlag(MODULE_ID, "heartAttack", false);
  }
  for ( let i = 0; i < 3; i++ ) {
    const data = getData(actor);
    const limit = getLimit(actor);
    const step = nextStep({ stress: data.value, limit, state: data.state, gained, heartAttack: data.heartAttack });
    log(`${actor.name}: Stress ${data.value}/${limit}, state ${data.state ?? "none"} → ${step ?? "nothing"}`);
    if ( !step ) break;
    // Each step is isolated so a failing visual (chat, token icon) can't stop the next rule.
    try {
      if ( step === "resolve" ) await resolveCheck(actor);
      else if ( step === "mortality" ) await mortality(actor);
      else if ( step === "clearAffliction" ) await clearCondition(actor, { reason: loc("Reason.StressZero") });
    } catch(err) {
      console.error(`${MODULE_ID} | ${step} failed for ${actor.name}`, err);
    }
    // Guard against loops if a step couldn't change state.
    const after = getData(actor);
    if ( (after.state === data.state) && (after.heartAttack === data.heartAttack) && (after.value === data.value) ) break;
  }
}

function log(message) {
  if ( game.settings.get(MODULE_ID, "debug") ) console.log(`${MODULE_ID} | ${message}`);
}

/* -------------------------------------------- */
/*  Resolve                                     */
/* -------------------------------------------- */

/**
 * Roll a Resolve check and apply the result.
 * @param {Actor} actor
 * @param {object} [options]
 * @param {boolean} [options.virtueOnly]  Ignore non-Virtue results (Divine Intervention).
 */
export async function resolveCheck(actor, { virtueOnly=false }={}) {
  if ( !actor.isOwner ) return requestGM("resolveCheck", { actorUuid: actor.uuid, virtueOnly });
  const data = getData(actor);
  if ( data.state ) return null;

  const signature = game.settings.get(MODULE_ID, "variantResolve") ? data.signature : null;
  let roll = await new Roll("1d100").evaluate();
  let result = resolveResult(roll.total, signature);
  // Beacon of Hope (and similar riders): roll twice and keep the better result for the character.
  let note = "";
  if ( riders.resolveTwice?.(actor) ) {
    const second = await new Roll("1d100").evaluate();
    const other = resolveResult(second.total, signature);
    const pick = betterResolve({ total: roll.total, ...result }, { total: second.total, ...other });
    note = loc("Chat.ResolveTwice", { a: roll.total, b: second.total, kept: pick.total, source: riders.resolveTwice(actor) });
    if ( pick.total === second.total ) { roll = second; result = other; }
  }
  const ignored = virtueOnly && (result.type !== "virtue");
  const name = loc(`Condition.${result.key}.Name`);

  // Rules first: apply the result before any chat or visuals, so nothing cosmetic can block it.
  if ( !ignored ) {
    const extra = result.type === "virtue" ? { [`flags.${MODULE_ID}.value`]: Math.floor(getLimit(actor) / 2) } : {};
    await setCondition(actor, result.type === "virtue" ? "virtuous" : "afflicted", result.key, extra);
  }

  try {
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `<div class="sr-card sr-${result.type}">
        <h3>${loc("Chat.ResolveTested", { name: actor.name })}</h3>
        ${note ? `<p class="sr-reason">${note}</p>` : ""}
        ${ignored ? `<p>${loc("Chat.ResolveIgnored", { result: name })}</p>` : `
        <p class="sr-result">${loc(result.type === "virtue" ? "Chat.BecomesVirtuous" : "Chat.BecomesAfflicted", { result: name })}</p>
        <p class="sr-desc">${loc(`Condition.${result.key}.Short`)}</p>`}
      </div>`
    });
  } catch(err) {
    console.error(`${MODULE_ID} | Could not post the Resolve roll`, err);
  }
  return result;
}

/**
 * The better of two Resolve results for the character: a virtue beats an affliction;
 * otherwise the higher roll (a later row on the table).
 */
export function betterResolve(a, b) {
  if ( (a.type === "virtue") !== (b.type === "virtue") ) return a.type === "virtue" ? a : b;
  return b.total > a.total ? b : a;
}

/**
 * Spell and feat riders the adaptations module fills in (kept as a registry to avoid a circular import).
 * - resolveTwice(actor) → source name when the actor rolls Resolve twice (Beacon of Hope), else null.
 * - preventHeartAttack(actor, state) → async, true when a spell or feat stopped the heart attack.
 * - stressDie(actor, { shortRest }) → { max: boolean, extra: string[] } modifiers for a Stress Die.
 * - reduceStress(actor, delta, options) → { delta, notes } class reductions to a Stress gain.
 */
export const riders = { resolveTwice: null, preventHeartAttack: null, stressDie: null, reduceStress: null };

/**
 * Apply an affliction or virtue: flags (one update, which every client sees and animates)
 * plus a status effect on the token.
 */
export async function setCondition(actor, state, key, extraUpdate={}) {
  await clearStatus(actor);
  await actor.update({
    [`flags.${MODULE_ID}.state`]: state,
    [`flags.${MODULE_ID}.condition`]: key,
    [`flags.${MODULE_ID}.since`]: game.time.worldTime,
    [`flags.${MODULE_ID}.suppressed`]: null,
    ...extraUpdate
  });
  await addStatus(actor, key);
}

/**
 * Hooks the effects module fills in, so condition mechanics (Active Effect changes) follow the status.
 * Kept as a registry to avoid a circular import.
 */
export const mechanics = { apply: null, clear: null };

/** Add a condition's status icon and its mechanical changes. */
export async function addStatus(actor, key) {
  try {
    await actor.toggleStatusEffect(statusId(key), { active: true });
  } catch(err) {
    console.error(`${MODULE_ID} | Could not add the ${key} status icon`, err);
  }
  try {
    await mechanics.apply?.(actor, key);
  } catch(err) {
    console.error(`${MODULE_ID} | Could not apply ${key} effects`, err);
  }
}

/** Refracted: set (or clear, with null) the affliction for this turn. */
export async function setSubCondition(actor, key) {
  const current = getData(actor).subCondition;
  if ( current ) await removeStatus(actor, current);
  await actor.setFlag(MODULE_ID, "subCondition", key ?? null);
  if ( key ) await addStatus(actor, key);
}

/** Remove the current affliction or virtue. */
export async function clearCondition(actor, { reason=null, chat=true }={}) {
  if ( !actor.isOwner ) return requestGM("clearCondition", { actorUuid: actor.uuid, reason, chat });
  const data = getData(actor);
  if ( !data.state ) return;
  await clearStatus(actor);
  await actor.update({
    [`flags.${MODULE_ID}.state`]: null,
    [`flags.${MODULE_ID}.condition`]: null,
    [`flags.${MODULE_ID}.subCondition`]: null,
    [`flags.${MODULE_ID}.suppressed`]: null,
    [`flags.${MODULE_ID}.since`]: null
  });
  try {
    await mechanics.clear?.(actor);
  } catch(err) {
    console.error(`${MODULE_ID} | Could not clear condition effects`, err);
  }
  if ( chat ) {
    await postCard(actor, loc("Chat.ConditionEnds", {
      name: actor.name, condition: loc(`Condition.${data.condition}.Name`)
    }), reason);
  }
}

async function clearStatus(actor) {
  for ( const key of [...Object.keys(AFFLICTIONS), ...Object.keys(VIRTUES)] ) await removeStatus(actor, key);
}

async function removeStatus(actor, key) {
  if ( !actor.statuses?.has(statusId(key)) ) return;
  try {
    await actor.toggleStatusEffect(statusId(key), { active: false });
  } catch(err) {
    console.error(`${MODULE_ID} | Could not remove the ${key} status icon`, err);
  }
}

/* -------------------------------------------- */
/*  Mortality                                   */
/* -------------------------------------------- */

export async function mortality(actor) {
  if ( !actor.isOwner ) return requestGM("mortality", { actorUuid: actor.uuid });
  let data = getData(actor);
  // Facing Mortality without a condition (GM button): Resolve is tested first.
  if ( !data.state ) {
    await resolveCheck(actor);
    data = getData(actor);
  }
  if ( !data.state ) return;
  // Death Ward, Boon of Recovery, Boon of Misty Escape can stop the heart attack.
  try {
    if ( await riders.preventHeartAttack?.(actor, data.state) ) return;
  } catch(err) {
    console.error(`${MODULE_ID} | Heart attack prevention failed`, err);
  }
  // House rule: a virtuous character also has the heart attack; Stress resets to 0 and the virtue ends.
  if ( data.state === "virtuous" ) {
    await actor.setFlag(MODULE_ID, "value", 0);
    await clearCondition(actor, { chat: false });
    await actor.update({
      "system.attributes.hp.value": 0,
      "system.attributes.death.failure": 2,
      "system.attributes.death.success": 0,
      [`flags.${MODULE_ID}.heartAttack`]: true
    });
    return safeCard(actor, loc("Chat.MortalityVirtuous", { name: actor.name }), "sr-affliction");
  }
  if ( data.state === "afflicted" ) {
    await actor.update({
      "system.attributes.hp.value": 0,
      "system.attributes.death.failure": 2,
      "system.attributes.death.success": 0,
      [`flags.${MODULE_ID}.heartAttack`]: true
    });
    log(`${actor.name}: heart attack applied (HP ${actor.system.attributes.hp.value}, failures ${actor.system.attributes.death.failure})`);
    return safeCard(actor, loc("Chat.HeartAttack", { name: actor.name }), "sr-affliction");
  }
}

async function safeCard(actor, text, cls) {
  try {
    return await postCard(actor, text, null, cls);
  } catch(err) {
    console.error(`${MODULE_ID} | Could not post a chat card`, err);
  }
}

/** After a heart attack, being stabilised or healed drops Stress to the Limit. */
export async function recoverFromHeartAttack(actor) {
  if ( !getData(actor).heartAttack ) return;
  const limit = getLimit(actor);
  await actor.update({
    [`flags.${MODULE_ID}.heartAttack`]: false,
    [`flags.${MODULE_ID}.value`]: Math.min(getData(actor).value, limit)
  });
  await postCard(actor, loc("Chat.HeartAttackRecovered", { name: actor.name, limit }));
}

/* -------------------------------------------- */
/*  Stress Dice                                 */
/* -------------------------------------------- */

/**
 * Spend one hit die of the given size to reduce Stress by the matching Stress Die + WIS.
 * @param {Actor} actor
 * @param {string} denomination  Hit die size, e.g. "d10".
 */
export async function spendStressDie(actor, denomination, { shortRest=false, bonus=null, bonusLabel=null, noWis=false }={}) {
  const cls = Object.values(actor.classes ?? {}).find(c =>
    (c.system.hd.denomination === denomination) && (c.system.hd.value > 0));
  if ( !cls ) {
    ui.notifications.warn(loc("Notify.NoHitDice"));
    return null;
  }
  const faces = stressFacesFor(actor, cls);
  const mods = (await riders.stressDie?.(actor, { shortRest })) ?? { max: false, extra: [], notes: [] };
  const parts = [mods.max ? String(faces) : `1d${faces}`];
  if ( !noWis ) parts.push("@wis");
  if ( bonus ) parts.push(String(bonus));
  parts.push(...(mods.extra ?? []));
  const roll = await new Roll(parts.join(" + "), { wis: actor.system.abilities.wis.mod }).evaluate();
  await cls.update({ "system.hd.spent": cls.system.hd.spent + 1 });
  const notes = [bonusLabel, ...(mods.notes ?? [])].filter(Boolean);
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `<div class="sr-card"><h3>${loc("Chat.StressDie", { name: actor.name })}</h3>
      ${notes.length ? `<p class="sr-reason">${notes.join(" ")}</p>` : ""}</div>`
  });
  await addStress(actor, -Math.max(0, roll.total), { chat: true, reason: loc("Reason.StressDie") });
  return roll;
}

/* -------------------------------------------- */
/*  Rests                                       */
/* -------------------------------------------- */

/**
 * Long rest effects. Any long rest ends a virtue. A safe long rest also clears Stress and afflictions.
 */
export async function onLongRest(actor, { safe=false }={}) {
  const data = getData(actor);
  if ( (data.state === "afflicted") && data.since !== null
    && (game.time.worldTime - data.since >= MADNESS_DELAY) && !safe ) {
    ChatMessage.create({
      content: `<div class="sr-card sr-affliction">${loc("Chat.MadnessReminder", { name: actor.name })}</div>`,
      whisper: ChatMessage.getWhisperRecipients("GM"),
      speaker: ChatMessage.getSpeaker({ actor })
    });
  }
  if ( data.tempStress ) await actor.setFlag(MODULE_ID, "tempStress", 0);
  if ( data.state === "virtuous" ) await clearCondition(actor, { reason: loc("Reason.LongRest") });
  if ( safe ) {
    if ( data.state === "afflicted" ) await clearCondition(actor, { reason: loc("Reason.SafeRest") });
    if ( data.value > 0 ) {
      await actor.setFlag(MODULE_ID, "value", 0);
      await postCard(actor, loc("Chat.SafeRest", { name: actor.name }));
    }
  }
}

/* -------------------------------------------- */
/*  Chat                                        */
/* -------------------------------------------- */

export function postCard(actor, text, reason=null, cls="", { whisperGM=false, source=false }={}) {
  const label = source ? `<strong>${loc("Chat.Source")}</strong> ` : "";
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="sr-card ${cls}"><p>${text}</p>${reason ? `<p class="sr-reason">${label}${reason}</p>` : ""}</div>`,
    ...(whisperGM ? { whisper: ChatMessage.getWhisperRecipients("GM") } : {})
  });
}

/** A Stress gain card with its source: public when chat messages are on, otherwise whispered to the GM. */
async function gainCard(actor, text, reason, isPublic) {
  try {
    await postCard(actor, text, reason, "sr-gain", { whisperGM: !isPublic, source: true });
  } catch(err) {
    console.error(`${MODULE_ID} | Could not post a chat card`, err);
  }
}
