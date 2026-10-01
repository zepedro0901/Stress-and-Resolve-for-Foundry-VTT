/**
 * Stress riders for 2024 spells and feats (the "Recommended" rows of the Spell and Feat Stress Audit),
 * plus the PDF's Psychic damage and Contact Other Plane rules.
 *
 * Spells and feats are recognised by their dnd5e identifier (or, failing that, their name slugified),
 * so they work with the SRD, the Player's Handbook module and hand-made items alike.
 */
import { MODULE_ID } from "./constants.mjs";
import { resolveResult } from "./math.mjs";
import {
  addStress, clearCondition, getData, getLimit, riders, setCondition, setStress, spendStressDie, stressFacesFor,
  tracksStress
} from "./stress.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const setting = key => game.settings.get(MODULE_ID, key);
const HOUR = 3600;

/* -------------------------------------------- */
/*  Recognising spells, feats and effects       */
/* -------------------------------------------- */

/** "Leomund's Tiny Hut" → "leomunds-tiny-hut". */
export function slug(text) {
  return String(text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function ident(item) {
  return item?.system?.identifier || slug(item?.name);
}

/** Identifiers, including the SRD 5.2 names without the wizard's name. */
export const SPELLS = {
  safe: {
    "leomunds-tiny-hut": 8 * HOUR, "tiny-hut": 8 * HOUR,
    "mordenkainens-magnificent-mansion": 24 * HOUR, "magnificent-mansion": 24 * HOUR,
    "galders-tower": 24 * HOUR,
    "mighty-fortress": 7 * 24 * HOUR,
    "temple-of-the-gods": 24 * HOUR
  },
  catnap: ["catnap"],
  greaterRestoration: ["greater-restoration"],
  heroesFeast: ["heroes-feast"],
  prayerOfHealing: ["prayer-of-healing"],
  powerWordHeal: ["power-word-heal"],
  beacon: ["beacon-of-hope"],
  deathWard: ["death-ward"],
  contactOtherPlane: ["contact-other-plane"],
  /** Spells enemies cast on the party: the GM gets a reminder of the suggested table rule. */
  onPC: ["befuddlement", "dream", "fractured-awareness", "reality-break", "vision-of-elapsing-eons"]
};

/** Dark Gifts whose natural-1 drawback is rolled automatically. Second Skin stays with the table. */
export const DARK_GIFTS = {
  "aberrant-anatomy": "con",
  "echoing-soul": "con",
  "gathered-whispers": "wis",
  "living-shadow": "wis",
  "symbiotic-being": "cha",
  "watchers": "wis"
};

export function findFeat(actor, ids) {
  ids = [].concat(ids);
  return actor?.items?.find(i => (i.type === "feat") && ids.includes(ident(i))) ?? null;
}

/** An active effect on the actor that comes from one of these spells (by name or origin). */
export function findEffect(actor, ids) {
  ids = [].concat(ids);
  const effects = actor?.allApplicableEffects ? [...actor.allApplicableEffects()] : [...(actor?.effects ?? [])];
  return effects.find(e => {
    if ( e.disabled || e.isSuppressed ) return false;
    if ( ids.includes(slug(e.name)) ) return true;
    const origin = e.origin ? fromUuidSync(e.origin.split(".Activity.")[0], { strict: false }) : null;
    return !!origin && ids.includes(ident(origin));
  }) ?? null;
}

/** Player characters in the party (owned by a player) and on the current scene. */
export function partyMembers() {
  const out = new Map();
  for ( const a of game.actors ?? [] ) if ( tracksStress(a) && a.hasPlayerOwner ) out.set(a.uuid, a);
  for ( const t of canvas?.scene?.tokens ?? [] ) if ( tracksStress(t.actor) ) out.set(t.actor.uuid, t.actor);
  return [...out.values()];
}

function targetActors() {
  const seen = new Map();
  for ( const t of game.user.targets ?? [] ) if ( t.actor ) seen.set(t.actor.uuid, t.actor);
  return [...seen.values()];
}

export async function card(actor, html, { cls="", whisperGM=false }={}) {
  try {
    return await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="sr-card ${cls}">${html}</div>`,
      ...(whisperGM ? { whisper: ChatMessage.getWhisperRecipients("GM") } : {})
    });
  } catch(err) {
    console.error(`${MODULE_ID} | Could not post a chat card`, err);
  }
}

/* -------------------------------------------- */
/*  Psychic damage and Contact Other Plane      */
/* -------------------------------------------- */

/** Total Psychic damage in a calculated damage list (after immunity, resistance and vulnerability). */
export function psychicTotal(damages) {
  return Math.trunc((damages ?? []).reduce((sum, d) => sum + ((d.type === "psychic") && (d.value > 0) ? d.value : 0), 0));
}

function registerPsychic() {
  // calculateDamage also runs for previews, so only remember the amount here…
  Hooks.on("dnd5e.calculateDamage", (actor, damages, options) => {
    if ( !tracksStress(actor) || !options ) return;
    (options[MODULE_ID] ??= {})[actor.uuid] = psychicTotal(damages);
  });
  // A killing blow: remember that this damage takes a living creature to 0 HP.
  Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) => {
    if ( !options ) return;
    const before = Number(actor.system?.attributes?.hp?.value) || 0;
    const after = updates?.["system.attributes.hp.value"];
    if ( (before > 0) && (after !== undefined) && (after <= 0) ) ((options[MODULE_ID] ??= {}).killed ??= {})[actor.uuid] = true;
  });
  // …and add Stress once the damage is really applied. Psychic and critical-hit Stress run in sequence.
  Hooks.on("dnd5e.applyDamage", (actor, amount, options) => {
    onDamageApplied(actor, amount, options ?? {}).catch(err => console.error(`${MODULE_ID} | Damage Stress failed`, err));
  });
}

function damageSource(options) {
  const message = options.originatingMessage;
  let item = null;
  try { item = message?.getAssociatedItem?.() ?? null; } catch(err) { /* no associated item */ }
  let attacker = item?.actor ?? null;
  if ( !attacker && message?.speaker ) {
    try { attacker = ChatMessage.getSpeakerActor?.(message.speaker) ?? null; } catch(err) { /* none */ }
  }
  const critical = !!message?.rolls?.some(r => r?.isCritical === true || r?.options?.isCritical === true);
  return { item, attacker, critical };
}

/** Half the damage, rounded down: the PDF's critical-hit amount. */
export const critAmount = amount => Math.floor(Math.max(0, Number(amount) || 0) / 2);

async function onDamageApplied(actor, amount, options) {
  const psychic = options[MODULE_ID]?.[actor.uuid];
  if ( options[MODULE_ID] ) delete options[MODULE_ID][actor.uuid];
  const { item, attacker, critical } = damageSource(options);
  const by = attacker?.name ?? item?.name ?? loc("Reason.UnknownSource");

  if ( psychic && tracksStress(actor) ) {
    if ( item && setting("spellRiders") && SPELLS.contactOtherPlane.includes(ident(item))
      && (item.actor?.uuid === actor.uuid) ) await contactOtherPlane(actor);
    else if ( setting("psychicStress") ) {
      await addStress(actor, psychic, { reason: loc("Reason.Psychic", { n: psychic, source: by }), sourceUuid: attacker?.uuid ?? null });
    }
  }

  // Killing blow on a creature you're frightened of: remove twice its CR.
  if ( options[MODULE_ID]?.killed?.[actor.uuid] ) {
    delete options[MODULE_ID].killed[actor.uuid];
    const cr = Number(actor.system?.details?.cr);
    if ( tracksStress(attacker) && setting("killingBlowRelief") && Number.isFinite(cr) && (cr > 0)
      && fearsCreature(attacker, actor) ) {
      await addStress(attacker, -(2 * cr), { reason: loc("Reason.KillingBlow", { enemy: actor.name, n: 2 * cr }) });
    }
  }

  if ( !critical || !setting("critStress") ) return;
  const half = critAmount(amount);
  if ( !half ) return;
  // The victim of a critical hit suffers half the damage taken as Stress…
  if ( tracksStress(actor) ) {
    await addStress(actor, half, { reason: loc("Reason.CritTaken", { n: amount, source: by }), sourceUuid: attacker?.uuid ?? null });
  }
  // …and a character who scores one removes half the damage dealt.
  if ( tracksStress(attacker) && (attacker.uuid !== actor.uuid) ) {
    await addStress(attacker, -half, { reason: loc("Reason.CritScored", { n: amount, target: actor.name }) });
  }
}

/**
 * Contact Other Plane (PDF): a failed save brings Stress up to the Limit and gives a random affliction
 * (the signature one with Variant Resolve). Its Psychic damage adds no further Stress.
 */
export async function contactOtherPlane(actor) {
  const data = getData(actor);
  const limit = getLimit(actor);
  const value = Math.max(data.value, limit);
  if ( data.state === "afflicted" ) {
    if ( value !== data.value ) await actor.setFlag(MODULE_ID, "value", value);
    return card(actor, `<p>${loc("Adapt.ContactOtherPlane.Already", { name: esc(actor.name), limit })}</p>`, { cls: "sr-affliction" });
  }
  // A random affliction: the seven afflictions fill rows 1–70 of the Resolve table.
  const signature = setting("variantResolve") ? data.signature : null;
  const roll = await new Roll("1d70").evaluate();
  const result = resolveResult(roll.total, signature);
  const key = result.type === "affliction" ? result.key : "paranoid";
  if ( data.state === "virtuous" ) await clearCondition(actor, { chat: false });
  await setCondition(actor, "afflicted", key, { [`flags.${MODULE_ID}.value`]: value });
  return card(actor, `<p>${loc("Adapt.ContactOtherPlane.Text", {
    name: esc(actor.name), limit, condition: loc(`Condition.${key}.Name`)
  })}</p>`, { cls: "sr-affliction" });
}

/* -------------------------------------------- */
/*  Spending Stress Dice outside a rest         */
/* -------------------------------------------- */

/** Let the owner pick which hit die to spend (if more than one size is available), then spend it. */
export async function promptStressDie(actor, options={}) {
  if ( !actor?.isOwner ) return ui.notifications.warn(loc("Adapt.NotOwner"));
  const classes = Object.values(actor.classes ?? {}).filter(c => c.system.hd.value > 0);
  if ( !classes.length ) return ui.notifications.warn(loc("Notify.NoHitDice"));
  const sizes = [...new Set(classes.map(c => c.system.hd.denomination))];
  let denom = sizes[0];
  if ( sizes.length > 1 ) {
    const opts = classes.map(c => `<option value="${c.system.hd.denomination}">d${stressFacesFor(actor, c)} — ${esc(c.name)}
      (${loc("Rest.UsesHitDie", { die: c.system.hd.denomination, n: c.system.hd.value })})</option>`);
    denom = await foundry.applications.api.DialogV2.prompt({
      window: { title: loc("Rest.StressDice") },
      content: `<div class="form-group"><label>${loc("Rest.StressDice")}</label><select name="denom">${opts.join("")}</select></div>`,
      ok: { label: loc("Rest.Spend"), callback: (event, button) => button.form.elements.denom.value },
      rejectClose: false
    });
    if ( !denom ) return null;
  }
  return spendStressDie(actor, denom, options);
}

/** A chat button that spends a Stress Die for one character (or, with "self", the clicking player's own). */
function dieButton(actor, label, data={}) {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ");
  return `<button type="button" class="sr-die-button" data-actor="${actor ? actor.uuid : "self"}" ${attrs}>
    <i class="fa-solid fa-brain" inert></i> ${esc(label)}</button>`;
}

function registerDieButtons() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    for ( const button of html.querySelectorAll(".sr-die-button") ) {
      const uuid = button.dataset.actor;
      const actor = uuid === "self" ? null : fromUuidSync(uuid, { strict: false });
      if ( actor && !actor.isOwner ) { button.disabled = true; continue; }
      button.addEventListener("click", async event => {
        event.preventDefault();
        const who = actor ?? canvas?.tokens?.controlled?.[0]?.actor ?? game.user.character;
        if ( !tracksStress(who) ) return ui.notifications.warn(loc("Adapt.PickCharacter"));
        const { bonus, bonusLabel, noWis } = button.dataset;
        await promptStressDie(who, { bonus: bonus || null, bonusLabel: bonusLabel || null, noWis: noWis === "true" });
      });
    }
  });
}

/* -------------------------------------------- */
/*  Spells cast                                 */
/* -------------------------------------------- */

async function onUseActivity(activity) {
  const item = activity?.item;
  const caster = activity?.actor;
  if ( !item || !caster || !setting("spellRiders") ) return;
  const id = ident(item);
  const targets = targetActors();
  const pcs = targets.filter(tracksStress);
  const reason = loc("Reason.Spell", { spell: item.name });

  // Safe shelters: the next long rest while it stands counts as safe.
  if ( id in SPELLS.safe ) {
    await caster.setFlag(MODULE_ID, "shelter", {
      spell: item.name, sceneId: canvas?.scene?.id ?? null, time: game.time.worldTime, duration: SPELLS.safe[id]
    });
    return card(caster, `<p>${loc("Adapt.Shelter.Cast", { name: esc(caster.name), spell: esc(item.name) })}</p>`, { cls: "sr-virtue" });
  }

  if ( SPELLS.catnap.includes(id) ) {
    const buttons = pcs.length ? pcs.map(a => dieButton(a, loc("Adapt.SpendFor", { name: a.name })))
      : [dieButton(null, loc("Adapt.SpendOwn"))];
    return card(caster, `<p>${loc("Adapt.Catnap", { spell: esc(item.name) })}</p>${buttons.join("")}`, { cls: "sr-virtue" });
  }

  if ( SPELLS.heroesFeast.includes(id) ) {
    const eaters = pcs.length ? pcs : partyMembers();
    for ( const a of eaters ) await setStress(a, 0, { reason, chat: true });
    return;
  }

  if ( SPELLS.powerWordHeal.includes(id) ) {
    for ( const a of pcs ) {
      await setStress(a, 0, { reason, chat: true });
      if ( getData(a).state === "afflicted" ) await clearCondition(a, { reason });
    }
    return;
  }

  if ( SPELLS.prayerOfHealing.includes(id) ) {
    const ability = item.system?.ability || caster.system?.attributes?.spellcasting || "wis";
    const mod = Math.max(0, caster.system?.abilities?.[ability]?.mod ?? 0);
    if ( !mod ) return;
    for ( const a of pcs ) await addStress(a, -mod, { reason });
    return;
  }

  if ( SPELLS.greaterRestoration.includes(id) ) {
    for ( const a of pcs.filter(t => getData(t).state === "afflicted") ) {
      const condition = loc(`Condition.${getData(a).condition}.Name`);
      const yes = await foundry.applications.api.DialogV2.confirm({
        window: { title: item.name },
        content: `<p>${loc("Adapt.GreaterRestoration", { name: esc(a.name), condition })}</p>`,
        rejectClose: false
      });
      if ( yes ) await clearCondition(a, { reason });
    }
    return;
  }

  if ( SPELLS.onPC.includes(id) && (pcs.length || !targets.length) ) {
    const names = pcs.map(a => esc(a.name)).join(", ") || loc("Adapt.OnPC.Someone");
    return card(caster, `<h3><i class="fa-solid fa-triangle-exclamation" inert></i> ${esc(item.name)}</h3>
      <p>${loc("Adapt.OnPC.Intro", { spell: esc(item.name), names })}</p>
      <p>${loc(`Adapt.OnPC.${id}`)}</p>`, { cls: "sr-reminder sr-affliction", whisperGM: true });
  }

  // Healer (Battle Medic): the patient may spend a Stress Die instead, rolled by the healer + Proficiency.
  if ( ["healers-kit", "healer"].includes(id) && findFeat(caster, "healer") ) {
    const prof = caster.system?.attributes?.prof ?? 0;
    const patients = pcs.filter(a => a !== caster);
    const label = loc("Adapt.BattleMedic.Bonus", { name: caster.name, n: prof });
    const data = { bonus: prof, "bonus-label": label, "no-wis": "true" };
    const buttons = patients.length ? patients.map(a => dieButton(a, loc("Adapt.SpendFor", { name: a.name }), data))
      : [dieButton(null, loc("Adapt.SpendOwn"), data)];
    return card(caster, `<p>${loc("Adapt.BattleMedic.Text", { name: esc(caster.name) })}</p>${buttons.join("")}`, { cls: "sr-virtue" });
  }
}

/* -------------------------------------------- */
/*  Safe rest                                   */
/* -------------------------------------------- */

/** A shelter spell still standing on this scene, if any: { spell, caster }. */
export function activeShelter() {
  const now = game.time.worldTime;
  const sceneId = canvas?.scene?.id ?? null;
  for ( const actor of game.actors ?? [] ) {
    const s = actor.getFlag?.(MODULE_ID, "shelter");
    if ( !s ) continue;
    if ( (now - s.time) > s.duration ) continue;
    if ( s.sceneId && sceneId && (s.sceneId !== sceneId) ) continue;
    return { spell: s.spell, caster: actor.name };
  }
  return null;
}

/** A party member with the Chef feat, if any. */
export function partyChef() {
  return partyMembers().find(a => findFeat(a, "chef")) ?? null;
}

/* -------------------------------------------- */
/*  Resolve, heart attack and Stress Dice       */
/* -------------------------------------------- */

function resolveTwice(actor) {
  if ( !setting("spellRiders") ) return null;
  return findEffect(actor, SPELLS.beacon)?.name ?? null;
}

function usesLeft(item) {
  const uses = item.system?.uses;
  if ( !uses?.max ) return true;
  return (uses.value ?? (uses.max - (uses.spent ?? 0))) > 0;
}

async function spendUse(item) {
  const uses = item.system?.uses;
  if ( uses?.max ) await item.update({ "system.uses.spent": (uses.spent ?? 0) + 1 });
}

/**
 * Death Ward stops the heart attack on its own. Boon of Recovery and Boon of Misty Escape can, if the
 * player wants to spend them. The character drops to 1 HP instead of 0 (Recovery also heals half their
 * HP maximum); an afflicted character's Stress falls to the Limit, a virtuous one's to 0 and the virtue ends.
 */
async function preventHeartAttack(actor, state) {
  if ( !setting("spellRiders") ) return false;
  const hpMax = actor.system.attributes.hp.max ?? 1;
  let source = null;
  let hp = 1;
  let extra = "";

  const ward = findEffect(actor, SPELLS.deathWard);
  if ( ward ) {
    source = ward.name;
    await ward.delete();
  } else {
    const boons = [
      { item: findFeat(actor, "boon-of-recovery"), hp: Math.min(hpMax, 1 + Math.floor(hpMax / 2)), extra: "" },
      { item: findFeat(actor, "boon-of-misty-escape"), hp: 1, extra: loc("Adapt.HeartAttack.Misty") }
    ].filter(b => b.item && usesLeft(b.item));
    if ( !boons.length ) return false;
    const pick = await foundry.applications.api.DialogV2.wait({
      window: { title: loc("Adapt.HeartAttack.Title", { name: actor.name }), icon: "fa-solid fa-heart-crack" },
      content: `<p>${loc("Adapt.HeartAttack.Ask", { name: esc(actor.name) })}</p>`,
      buttons: [
        ...boons.map((b, i) => ({ action: String(i), label: b.item.name })),
        { action: "no", label: loc("Adapt.HeartAttack.No"), default: true }
      ],
      rejectClose: false
    });
    const boon = boons[Number(pick)];
    if ( !boon ) return false;
    await spendUse(boon.item);
    source = boon.item.name;
    hp = boon.hp;
    extra = boon.extra;
  }

  const limit = getLimit(actor);
  if ( state === "virtuous" ) {
    await actor.setFlag(MODULE_ID, "value", 0);
    await clearCondition(actor, { chat: false });
  } else {
    await actor.setFlag(MODULE_ID, "value", Math.min(getData(actor).value, limit));
  }
  await actor.update({ "system.attributes.hp.value": hp, [`flags.${MODULE_ID}.heartAttack`]: false });
  await card(actor, `<p>${loc(state === "virtuous" ? "Adapt.HeartAttack.SavedVirtuous" : "Adapt.HeartAttack.Saved", {
    name: esc(actor.name), source: esc(source), hp, limit
  })}${extra ? ` ${extra}` : ""}</p>`, { cls: "sr-virtue" });
  return true;
}

function stressDie(actor) {
  if ( !setting("spellRiders") ) return { max: false, extra: [], notes: [] };
  const boon = findFeat(actor, "boon-of-bountiful-health");
  return { max: !!boon, extra: [], notes: boon ? [loc("Adapt.Bountiful", { feat: boon.name })] : [] };
}

/* -------------------------------------------- */
/*  Feats: Musician, Dark Gifts                 */
/* -------------------------------------------- */

/** Musician (Encouraging Song): as the rest ends, up to Proficiency Bonus allies recover 1d4 Stress. */
async function encouragingSong(actor) {
  const feat = findFeat(actor, "musician");
  if ( !feat ) return;
  const prof = actor.system.attributes?.prof ?? 2;
  const allies = partyMembers().filter(a => a !== actor);
  if ( !allies.length ) return;
  const rows = allies.map((a, i) => `<label class="checkbox"><input type="checkbox" name="${a.id}" ${i < prof ? "checked" : ""}>
    ${esc(a.name)} (${getData(a).value} / ${getLimit(a)})</label>`);
  const chosen = await foundry.applications.api.DialogV2.prompt({
    window: { title: feat.name, icon: "fa-solid fa-music" },
    content: `<p>${loc("Adapt.Musician.Ask", { n: prof })}</p><div class="sr-checklist">${rows.join("")}</div>`,
    ok: { label: loc("Adapt.Musician.Play"),
      callback: (event, button) => allies.filter(a => button.form.elements[a.id]?.checked).map(a => a.id) },
    rejectClose: false
  });
  if ( !Array.isArray(chosen) || !chosen.length ) return;
  for ( const a of allies.filter(x => chosen.includes(x.id)).slice(0, prof) ) {
    const r = await new Roll("1d4").evaluate();
    await addStress(a, -r.total, { reason: loc("Reason.Musician", { name: actor.name }) });
  }
}

/** Dark Gifts: a natural 1 on a D20 Test (not a death save) calls for the gift's save; a fail adds Proficiency Stress. */
async function darkGift(message) {
  const actor = ChatMessage.getSpeakerActor(message.speaker);
  if ( !tracksStress(actor) || message.getFlag?.(MODULE_ID, "giftSave") ) return;
  if ( message.system?.type === "death" ) return;
  const D20 = CONFIG.Dice.D20Roll;
  const roll = message.rolls?.find(r => D20 && (r instanceof D20));
  if ( !roll?.isFumble ) return;
  const gifts = actor.items.filter(i => (i.type === "feat") && (ident(i) in DARK_GIFTS));
  if ( !gifts.length ) return;
  const prof = actor.system.attributes?.prof ?? 2;
  for ( const gift of gifts ) {
    const id = ident(gift);
    let passed = false;
    try {
      const rolls = await actor.rollSavingThrow({ ability: DARK_GIFTS[id], target: 13 + prof }, { configure: false },
        { data: { flavor: loc("Adapt.DarkGift.Flavor", { gift: gift.name }), flags: { [MODULE_ID]: { giftSave: true } } } });
      passed = !!rolls?.[0]?.isSuccess;
    } catch(err) {
      console.error(`${MODULE_ID} | Dark Gift save failed to roll`, err);
    }
    if ( passed ) continue;
    await card(actor, `<h3>${esc(gift.name)}</h3><p>${loc(`Adapt.DarkGift.${id}`, { name: esc(actor.name) })}</p>`, { cls: "sr-affliction" });
    await addStress(actor, prof, { reason: loc("Reason.DarkGift", { gift: gift.name }) });
    if ( id === "watchers" ) await watchersParanoia(actor);
  }
}

/** Watchers: failing the paranoia save twice in the same fight makes the character Paranoid. */
async function watchersParanoia(actor) {
  const combatId = game.combat?.started ? game.combat.id : null;
  if ( !combatId ) return;
  const prior = actor.getFlag(MODULE_ID, "watchers");
  const n = (prior?.combatId === combatId ? prior.n : 0) + 1;
  await actor.setFlag(MODULE_ID, "watchers", { combatId, n });
  if ( (n >= 2) && !getData(actor).state ) {
    await setCondition(actor, "afflicted", "paranoid");
    await card(actor, `<p>${loc("Adapt.DarkGift.WatchersParanoid", { name: esc(actor.name) })}</p>`, { cls: "sr-affliction" });
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

/** Filled by sources.mjs (kept as a hook to avoid a circular import). */
export const fearCheck = { fears: null };
const fearsCreature = (actor, creature) => !!fearCheck.fears?.(actor, creature);

export function registerAdaptations() {
  riders.resolveTwice = resolveTwice;
  riders.preventHeartAttack = preventHeartAttack;
  riders.stressDie = stressDie;

  registerPsychic();
  registerDieButtons();

  Hooks.on("dnd5e.postUseActivity", activity => {
    onUseActivity(activity).catch(err => console.error(`${MODULE_ID} | Spell rider failed`, err));
  });

  Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
    if ( !tracksStress(actor) || !actor.isOwner || !setting("spellRiders") ) return;
    encouragingSong(actor).catch(err => console.error(`${MODULE_ID} | Musician failed`, err));
  });

  Hooks.on("createChatMessage", (message, options, userId) => {
    if ( (userId !== game.user.id) || !setting("spellRiders") ) return;
    darkGift(message).catch(err => console.error(`${MODULE_ID} | Dark Gift failed`, err));
  });
}
