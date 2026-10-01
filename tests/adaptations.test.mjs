/**
 * 0.5.0: temporary HP layers, Psychic Stress, Contact Other Plane, and the spell and feat riders.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- Fake Foundry ----
let rolls = [];
const formulas = [];
const chat = [];
const hooks = {};
let dialogAnswer = null;
const settings = { chatOnChange: true, variantResolve: false, debug: false, psychicStress: true, tempHpChoice: true,
  spellRiders: true };
globalThis.Hooks = {
  on: (n, f) => (hooks[n] ??= []).push(f),
  call: (n, ...a) => { for ( const f of hooks[n] ?? [] ) if ( f(...a) === false ) return false; return true; },
  callAll: (n, ...a) => (hooks[n] ?? []).forEach(f => f(...a))
};
globalThis.game = {
  settings: { get: (_, k) => settings[k] },
  i18n: { localize: k => k, format: (k, d) => `${k} ${JSON.stringify(d)}` },
  time: { worldTime: 0 },
  user: { isGM: true, id: "gm", targets: new Set() },
  users: Object.assign([{ id: "gm", isGM: true, active: true }], { activeGM: { id: "gm" } }),
  actors: [],
  combat: null
};
globalThis.canvas = { scene: { id: "s1", tokens: [] } };
globalThis.ui = { notifications: { warn: m => chat.push({ warn: m }) } };
const dialog = async () => dialogAnswer;
globalThis.foundry = {
  applications: { api: { DialogV2: { wait: dialog, prompt: dialog, confirm: dialog } } },
  utils: { escapeHTML: s => s }
};
globalThis.CONFIG = { Dice: {} };
globalThis.ChatMessage = { create: d => { chat.push(d); return d; }, getSpeaker: () => ({}), getWhisperRecipients: () => ["gm"] };
globalThis.Roll = class {
  constructor(formula, data={}) { this.formula = formula; this.data = data; formulas.push(formula); }
  async evaluate() {
    const m = this.formula.match(/^(\d+)(?![\dd])/);
    const fixed = m ? Number(m[1]) : null;
    const die = fixed ?? (rolls.length ? rolls.shift() : 1);
    this.total = die + (this.formula.includes("@wis") ? (this.data.wis ?? 0) : 0);
    return this;
  }
  async toMessage(d) { chat.push({ roll: this.total, ...d }); }
};
globalThis.fromUuidSync = () => null;

function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for ( const p of parts.slice(0, -1) ) o = (o[p] ??= {});
  o[parts.at(-1)] = value;
}

let idn = 0;
function makeActor({ level=1, hd="d10", wis=2, prof=2, items=[], effects=[], hpMax=40 }={}) {
  const id = `a${++idn}`;
  const cls = { id: "c1", name: "Class", system: { levels: level, hd: { denomination: hd, spent: 0, value: level } } };
  cls.update = async u => { cls.system.hd.spent = u["system.hd.spent"]; cls.system.hd.value = level - cls.system.hd.spent; };
  const actor = {
    id, uuid: `Actor.${id}`, type: "character", name: `Hero ${id}`, isOwner: true, flags: {}, statuses: new Set(),
    classes: { c1: cls }, items, effects, updates: [],
    system: {
      details: { level, originalClass: "c1" },
      abilities: { wis: { mod: wis }, int: { mod: 4 } },
      attributes: { prof, hp: { value: 20, max: hpMax, temp: 0 }, death: { success: 0, failure: 0 } }
    },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) { setPath(this.flags, `${scope}.${key}`, value); },
    async update(changes, options) {
      this.updates.push({ changes, options });
      for ( const [k, v] of Object.entries(changes) ) {
        if ( k.startsWith("flags.") ) setPath(this.flags, k.slice(6), v);
        else setPath(this, k, v);
      }
    },
    async toggleStatusEffect(sid, { active }) { active ? this.statuses.add(sid) : this.statuses.delete(sid); }
  };
  return actor;
}
const feat = (name, uses) => ({ type: "feat", name, system: { identifier: "", uses: uses ?? {} },
  async update(u) { this.system.uses.spent = u["system.uses.spent"]; this.system.uses.value = this.system.uses.max - this.system.uses.spent; } });
const effect = name => ({ name, disabled: false, deleted: false, async delete() { this.deleted = true; } });

const S = await import("../scripts/stress.mjs");
const A = await import("../scripts/adaptations.mjs");
const T = await import("../scripts/temp-hp.mjs");
A.registerAdaptations();
const flag = (a, k) => a.flags["stress-and-resolve"]?.[k];

beforeEach(() => { rolls = []; formulas.length = 0; chat.length = 0; dialogAnswer = null; settings.variantResolve = false; });

/* ---- Recognising spells and feats ---- */

test("Names become dnd5e identifiers", () => {
  assert.equal(A.slug("Leomund's Tiny Hut"), "leomunds-tiny-hut");
  assert.equal(A.slug("Heroes’ Feast"), "heroes-feast");
  assert.equal(A.ident({ name: "Death Ward", system: { identifier: "" } }), "death-ward");
  assert.equal(A.ident({ name: "Anything", system: { identifier: "beacon-of-hope" } }), "beacon-of-hope");
});

/* ---- Temporary HP ---- */

test("Temp HP updates are read and held back, flat or nested", () => {
  const flat = { "system.attributes.hp.temp": 8, "system.attributes.hp.value": 3 };
  assert.equal(T.readTemp(flat), 8);
  T.stripTemp(flat);
  assert.deepEqual(flat, { "system.attributes.hp.value": 3 });
  const nested = { system: { attributes: { hp: { temp: 5, value: 2 } } } };
  assert.equal(T.readTemp(nested), 5);
  T.stripTemp(nested);
  assert.deepEqual(nested, { system: { attributes: { hp: { value: 2 } } } });
  assert.equal(T.readTemp({ name: "x" }), undefined);
});

test("Only a higher value is a new layer; damage eating temp HP is not", () => {
  assert.equal(T.isTempGain(0, 7), true);
  assert.equal(T.isTempGain(5, 9), true);
  assert.equal(T.isTempGain(9, 4), false);
  assert.equal(T.isTempGain(3, 0), false);
});

test("Choosing Stress moves the layer off HP; choosing HP clears the Stress layer", async () => {
  const a = makeActor();
  a.system.attributes.hp.temp = 4;
  await T.applyTempChoice(a, 10, "stress");
  assert.equal(a.system.attributes.hp.temp, 0);
  assert.equal(flag(a, "tempStress"), 10);
  assert.equal(a.updates.at(-1).options["stress-and-resolve"].temp, true, "the update bypasses the prompt");
  await T.applyTempChoice(a, 6, "hp");
  assert.equal(a.system.attributes.hp.temp, 6);
  assert.equal(flag(a, "tempStress"), 0);
  await T.applyTempChoice(a, 12, "keep");
  assert.equal(a.system.attributes.hp.temp, 6);
});

test("The Stress layer soaks Stress first", async () => {
  const a = makeActor(); // Limit 10
  await a.setFlag("stress-and-resolve", "tempStress", 5);
  await S.addStress(a, 3);
  assert.equal(S.getData(a).value, 0);
  assert.equal(S.getData(a).tempStress, 2);
  await S.addStress(a, 6);
  assert.equal(S.getData(a).value, 4);
  assert.equal(S.getData(a).tempStress, 0);
});

test("Stress typed in by hand ignores the layer; a long rest clears it", async () => {
  const a = makeActor();
  await a.setFlag("stress-and-resolve", "tempStress", 5);
  await S.setStress(a, 4);
  assert.equal(S.getData(a).value, 4);
  assert.equal(S.getData(a).tempStress, 5);
  await S.onLongRest(a, { safe: false });
  assert.equal(S.getData(a).tempStress, 0);
});

/* ---- Psychic damage ---- */

test("Psychic damage adds Stress equal to the damage taken, once it is applied", async () => {
  const a = makeActor();
  const options = {};
  const damages = [{ type: "psychic", value: 7 }, { type: "fire", value: 5 }];
  Hooks.call("dnd5e.calculateDamage", a, damages, options); // preview: nothing yet
  assert.equal(S.getData(a).value, 0);
  Hooks.callAll("dnd5e.applyDamage", a, 12, options);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(S.getData(a).value, 7);
  assert.equal(A.psychicTotal([{ type: "psychic", value: 0 }, { type: "psychic", value: -3 }]), 0);
});

test("Contact Other Plane on its caster: Stress to the Limit and a random affliction, no Psychic Stress", async () => {
  const a = makeActor(); // Limit 10
  await a.setFlag("stress-and-resolve", "value", 3);
  const options = { originatingMessage: { getAssociatedItem: () => ({ name: "Contact Other Plane", system: {}, actor: a }) } };
  Hooks.call("dnd5e.calculateDamage", a, [{ type: "psychic", value: 21 }], options);
  rolls = [45]; // Hopeless
  Hooks.callAll("dnd5e.applyDamage", a, 21, options);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(formulas.at(-1), "1d70");
  assert.equal(S.getData(a).value, 10);
  assert.equal(S.getData(a).state, "afflicted");
  assert.equal(S.getData(a).condition, "hopeless");
});

test("Contact Other Plane uses the signature affliction with Variant Resolve", async () => {
  settings.variantResolve = true;
  const a = makeActor();
  await a.setFlag("stress-and-resolve", "signature", { affliction: "abusive" });
  await A.contactOtherPlane(a);
  assert.equal(S.getData(a).condition, "abusive");
  assert.equal(S.getData(a).value, 10);
});

/* ---- Beacon of Hope ---- */

test("Better Resolve result: a virtue beats an affliction, else the higher roll", () => {
  const aff = { total: 5, type: "affliction", key: "paranoid" };
  const vir = { total: 80, type: "virtue", key: "courageous" };
  assert.equal(S.betterResolve(aff, vir), vir);
  assert.equal(S.betterResolve(vir, aff), vir);
  assert.equal(S.betterResolve(aff, { total: 55, type: "affliction", key: "abusive" }).total, 55);
});

test("Beacon of Hope: Resolve is rolled twice and the better result kept", async () => {
  const a = makeActor({ effects: [effect("Beacon of Hope")] });
  rolls = [5, 90]; // Paranoid, then Vigorous
  await S.addStress(a, 10);
  assert.equal(S.getData(a).state, "virtuous");
  assert.equal(S.getData(a).condition, "vigorous");
});

/* ---- Heart attack prevention ---- */

test("Death Ward stops the heart attack once: 1 HP, Stress to the Limit, the ward ends", async () => {
  const ward = effect("Death Ward");
  const a = makeActor({ effects: [ward] });
  rolls = [5];
  await S.addStress(a, 20);
  assert.equal(a.system.attributes.hp.value, 1);
  assert.equal(a.system.attributes.death.failure, 0);
  assert.equal(S.getData(a).value, 10);
  assert.equal(S.getData(a).state, "afflicted");
  assert.equal(ward.deleted, true);
});

test("Boon of Recovery (if the player uses it): half HP instead of the heart attack, one use", async () => {
  const boon = feat("Boon of Recovery", { max: 1, spent: 0, value: 1 });
  const a = makeActor({ items: [boon], hpMax: 40 });
  rolls = [5];
  dialogAnswer = "0";
  await S.addStress(a, 20);
  assert.equal(a.system.attributes.hp.value, 21);
  assert.equal(boon.system.uses.spent, 1);
  // Used up: the next Mortality is a heart attack.
  await S.addStress(a, 10);
  assert.equal(a.system.attributes.hp.value, 0);
  assert.equal(a.system.attributes.death.failure, 2);
});

test("Declining the boon means the heart attack happens", async () => {
  const a = makeActor({ items: [feat("Boon of Misty Escape")] });
  rolls = [5];
  dialogAnswer = "no";
  await S.addStress(a, 20);
  assert.equal(a.system.attributes.hp.value, 0);
});

test("A virtuous character saved by Death Ward drops to 0 Stress and loses the virtue", async () => {
  const a = makeActor({ effects: [effect("Death Ward")] });
  rolls = [80];
  await S.addStress(a, 10); // Courageous, 5
  await S.addStress(a, 15);
  assert.equal(S.getData(a).state, null);
  assert.equal(S.getData(a).value, 0);
  assert.equal(a.system.attributes.hp.value, 1);
});

/* ---- Stress Dice ---- */

test("Boon of Bountiful Health: Stress Dice roll their maximum", async () => {
  const a = makeActor({ items: [feat("Boon of Bountiful Health")] }); // d10 hit die → d8 Stress Die
  await a.setFlag("stress-and-resolve", "value", 15);
  await S.spendStressDie(a, "d10");
  assert.equal(formulas.at(-1), "8 + @wis");
  assert.equal(S.getData(a).value, 5);
});

test("Chef's meal and Battle Medic bonuses on a Stress Die", async () => {
  const a = makeActor({ level: 3 });
  await a.setFlag("stress-and-resolve", "value", 15);
  await S.spendStressDie(a, "d10", { shortRest: true, bonus: "1d8" });
  assert.equal(formulas.at(-1), "1d8 + @wis + 1d8");
  await S.spendStressDie(a, "d10", { bonus: "3", noWis: true });
  assert.equal(formulas.at(-1), "1d8 + 3");
});

/* ---- Spells cast ---- */

async function cast(name, caster, targets=[]) {
  game.user.targets = new Set(targets.map(actor => ({ actor })));
  const activity = { item: { name, system: {} , actor: caster }, actor: caster };
  Hooks.call("dnd5e.postUseActivity", activity, {}, {});
  await new Promise(r => setTimeout(r, 10));
}

test("Heroes' Feast and Power Word Heal set Stress to 0; Power Word Heal ends the affliction", async () => {
  const cleric = makeActor();
  const a = makeActor();
  rolls = [5];
  await S.addStress(a, 12);
  await cast("Power Word Heal", cleric, [a]);
  assert.equal(S.getData(a).value, 0);
  assert.equal(S.getData(a).state, null);
  const b = makeActor();
  await b.setFlag("stress-and-resolve", "value", 7);
  await cast("Heroes' Feast", cleric, [b]);
  assert.equal(S.getData(b).value, 0);
});

test("Prayer of Healing heals Stress equal to the spellcasting modifier", async () => {
  const cleric = makeActor();
  cleric.system.attributes.spellcasting = "wis";
  cleric.system.abilities.wis.mod = 4;
  const a = makeActor();
  await a.setFlag("stress-and-resolve", "value", 7);
  await cast("Prayer of Healing", cleric, [a]);
  assert.equal(S.getData(a).value, 3);
});

test("Greater Restoration can end an affliction", async () => {
  const cleric = makeActor();
  const a = makeActor();
  rolls = [5];
  await S.addStress(a, 10);
  dialogAnswer = true;
  await cast("Greater Restoration", cleric, [a]);
  assert.equal(S.getData(a).state, null);
});

test("Tiny Hut makes the next long rest safe while it stands", async () => {
  const wizard = makeActor();
  game.actors = [wizard];
  game.time.worldTime = 1000;
  await cast("Leomund's Tiny Hut", wizard);
  assert.equal(A.activeShelter()?.spell, "Leomund's Tiny Hut");
  game.time.worldTime = 1000 + 9 * 3600;
  assert.equal(A.activeShelter(), null);
  game.actors = [];
  game.time.worldTime = 0;
});

test("Spells cast on the party remind the GM, whispered", async () => {
  const lich = makeActor();
  const a = makeActor();
  await cast("Vision of Elapsing Eons", lich, [a]);
  const msg = chat.find(m => String(m.content).includes("Adapt.OnPC.vision-of-elapsing-eons"));
  assert.ok(msg);
  assert.deepEqual(msg.whisper, ["gm"]);
});

test("Catnap and Battle Medic post Stress Die buttons", async () => {
  const bard = makeActor();
  const a = makeActor();
  await cast("Catnap", bard, [a]);
  assert.ok(chat.some(m => String(m.content).includes(`data-actor="${a.uuid}"`)));
  const medic = makeActor({ items: [feat("Healer")] });
  chat.length = 0;
  await cast("Healer's Kit", medic, [a]);
  const msg = chat.find(m => String(m.content).includes("sr-die-button"));
  assert.match(msg.content, /data-no-wis="true"/);
  assert.match(msg.content, /data-bonus="2"/);
});

/* ---- Dark Gifts ---- */

test("Dark Gift: a natural 1 calls for the save; a fail adds Proficiency Stress", async () => {
  class D20 { constructor(fumble) { this.isFumble = fumble; } }
  CONFIG.Dice.D20Roll = D20;
  const a = makeActor({ items: [feat("Gathered Whispers")], prof: 3 });
  let saved = null;
  a.rollSavingThrow = async config => { saved = config; return [{ isSuccess: false }]; };
  ChatMessage.getSpeakerActor = () => a;
  const message = { speaker: {}, rolls: [new D20(true)], system: { type: "ability" }, getFlag: () => null };
  Hooks.callAll("createChatMessage", message, {}, "gm");
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(saved, { ability: "wis", target: 16 });
  assert.equal(S.getData(a).value, 3);

  // Death saves don't count.
  saved = null;
  Hooks.callAll("createChatMessage", { ...message, system: { type: "death" } }, {}, "gm");
  await new Promise(r => setTimeout(r, 10));
  assert.equal(saved, null);
});

/* ---- Critical hits and Stress sources ---- */

test("Critical hits: the victim gains half the damage taken, the attacker removes half", async () => {
  settings.critStress = true;
  const victim = makeActor();
  const attacker = makeActor();
  await attacker.setFlag("stress-and-resolve", "value", 6);
  ChatMessage.getSpeakerActor = () => attacker;
  const options = { originatingMessage: { speaker: {}, rolls: [{ isCritical: true }], getAssociatedItem: () => null } };
  Hooks.callAll("dnd5e.applyDamage", victim, 9, options);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(S.getData(victim).value, 4);
  assert.equal(S.getData(attacker).value, 2);
  assert.ok(chat.some(m => String(m.content).includes("Reason.CritTaken")));
});

test("A critical with Psychic damage adds both, one after the other", async () => {
  settings.critStress = true;
  const victim = makeActor();
  ChatMessage.getSpeakerActor = () => null;
  const options = { originatingMessage: { speaker: {}, rolls: [{ options: { isCritical: true } }], getAssociatedItem: () => null } };
  Hooks.call("dnd5e.calculateDamage", victim, [{ type: "psychic", value: 4 }], options);
  Hooks.callAll("dnd5e.applyDamage", victim, 4, options);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(S.getData(victim).value, 6);
});

test("Every gain reaches the GM with its source, whispered when Stress chat is off", async () => {
  settings.chatOnChange = false;
  try {
    const a = makeActor();
    await S.addStress(a, 2, { reason: "A hideous sight." });
    const msg = chat.find(m => String(m.content).includes("Chat.Gain"));
    assert.deepEqual(msg.whisper, ["gm"]);
    assert.match(msg.content, /Chat\.Source.*A hideous sight\./s);
    chat.length = 0;
    await S.addStress(a, 1);
    assert.match(chat.find(m => String(m.content).includes("Chat.Gain")).content, /Reason\.Unknown/);
    chat.length = 0;
    await S.addStress(a, -1);
    assert.equal(chat.length, 0, "losses stay silent when Stress chat is off");
  } finally {
    settings.chatOnChange = true;
  }
});
