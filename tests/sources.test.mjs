/**
 * 0.8.0: feared attackers, lingering conditions, an ally's death, killing blows.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

let rolls = [];
const chat = [];
const hooks = {};
let dialogAnswer = null;
const uuids = {};
const settings = { chatOnChange: true, variantResolve: false, debug: false, psychicStress: true, tempHpChoice: true,
  spellRiders: true, classRiders: true, critStress: true, automateEffects: true, nearbyRange: 30,
  fearTargetStress: true, conditionStress: true, allyDeathStress: true, killingBlowRelief: true };
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
globalThis.canvas = { scene: { id: "s1", grid: { size: 100, distance: 5 }, tokens: [] } };
globalThis.ui = { notifications: { warn: m => chat.push({ warn: m }) } };
const dialog = async () => dialogAnswer;
globalThis.foundry = { applications: { api: { DialogV2: { wait: dialog, prompt: dialog, confirm: dialog } } },
  utils: { escapeHTML: s => s, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.CONFIG = { Dice: {}, statusEffects: [] };
globalThis.ChatMessage = { create: d => { chat.push(d); return d; }, getSpeaker: () => ({}), getWhisperRecipients: () => ["gm"] };
globalThis.Roll = class {
  constructor(formula) { this.formula = formula; }
  async evaluate() {
    const m = this.formula.match(/^(\d*)d(\d+)$/);
    const n = m ? (Number(m[1]) || 1) : 0;
    let total = 0;
    for ( let i = 0; i < n; i++ ) total += rolls.length ? rolls.shift() : 1;
    this.total = total;
    return this;
  }
  async toMessage(d) { chat.push({ roll: this.total, ...d }); }
};
globalThis.Actor = class {};
globalThis.Item = class {};
globalThis.fromUuidSync = uuid => uuids[uuid] ?? null;

function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for ( const p of parts.slice(0, -1) ) o = (o[p] ??= {});
  o[parts.at(-1)] = value;
}

let idn = 0;
function makeActor(name, { type="character", level=3, cr=null, effects=[], hpFormula="" }={}) {
  const id = `a${++idn}`;
  const a = Object.assign(new Actor(), {
    id, uuid: `Actor.${id}`, name, type, isOwner: true, flags: {}, statuses: new Set(), effects, items: [],
    hasPlayerOwner: type === "character", prototypeToken: { disposition: type === "character" ? 1 : -1 },
    classes: { c0: { id: "c0", system: { levels: level, hd: { denomination: "d10", spent: 0, value: level } } } },
    system: {
      details: { level, cr, originalClass: "c0" },
      abilities: { wis: { mod: 0 } },
      attributes: { prof: 2, hp: { value: 20, max: 20, temp: 0, formula: hpFormula }, death: { success: 0, failure: 0 } }
    },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) { setPath(this.flags, `${scope}.${key}`, value); },
    async unsetFlag(scope, key) { delete this.flags[scope]?.[key]; },
    async update(changes) {
      for ( const [k, v] of Object.entries(changes) ) {
        if ( k.startsWith("flags.") ) setPath(this.flags, k.slice(6), v);
        else setPath(this, k, v);
      }
    },
    async toggleStatusEffect(sid, { active }) { active ? this.statuses.add(sid) : this.statuses.delete(sid); }
  });
  uuids[a.uuid] = a;
  return a;
}
const condition = (status, origin, flags={}) => ({
  name: status, disabled: false, statuses: new Set([status]), origin, flags,
  getFlag(scope, key) { return this.flags[scope]?.[key]; },
  async setFlag(scope, key, value) { (this.flags[scope] ??= {})[key] = value; }
});
const place = (actor, x) => canvas.scene.tokens.push({ actor, actorId: actor.id, x: x * 100, y: 0, width: 1, height: 1,
  disposition: actor.prototypeToken.disposition, parent: canvas.scene });

const S = await import("../scripts/stress.mjs");
const A = await import("../scripts/adaptations.mjs");
const Src = await import("../scripts/sources.mjs");
A.registerAdaptations();
Src.registerSources();
const stress = a => S.getData(a).value;
const tick = () => new Promise(r => setTimeout(r, 10));

beforeEach(() => { rolls = []; chat.length = 0; dialogAnswer = null; canvas.scene.tokens = []; game.actors = [];
  game.user.targets = new Set(); });

test("Targeted by a feared creature: + its CR; by anyone else: nothing", async () => {
  const dragon = makeActor("Dragon", { type: "npc", cr: 4 });
  const goblin = makeActor("Goblin", { type: "npc", cr: 0.25 });
  const pc = makeActor("Lena", { effects: [condition("frightened", dragon.uuid)] });
  assert.deepEqual(Src.fearedCreatures(pc).map(a => a.name), ["Dragon"]);
  game.user.targets = new Set([{ actor: pc }]);
  Hooks.call("dnd5e.postUseActivity", { actor: dragon, item: { name: "Bite" } }, {}, {});
  await tick();
  assert.equal(stress(pc), 4);
  Hooks.call("dnd5e.postUseActivity", { actor: goblin, item: { name: "Scimitar" } }, {}, {});
  await tick();
  assert.equal(stress(pc), 4);
});

test("Lingering conditions: the CR of whoever inflicted each; natively deaf characters skip Deafened", async () => {
  const spider = makeActor("Spider", { type: "npc", cr: 1 });
  const pc = makeActor("Dismas", { effects: [
    condition("poisoned", `${spider.uuid}.Item.bite`),
    condition("blinded", null, { "stress-and-resolve": { cr: 2 } }),
    condition("deafened", spider.uuid)
  ] });
  // Item origins resolve to their actor.
  uuids[`${spider.uuid}.Item.bite`] = Object.assign(new Item(), { actor: spider });
  await pc.setFlag("stress-and-resolve", "nativeDeaf", true);
  await Src.lingering(pc);
  assert.equal(stress(pc), 3);
});

test("A lingering condition with no known source asks the GM once and remembers the answer", async () => {
  const blind = condition("blinded", null);
  const pc = makeActor("Audrey", { effects: [blind] });
  dialogAnswer = 2;
  await Src.lingering(pc);
  assert.equal(stress(pc), 2);
  assert.equal(blind.flags["stress-and-resolve"].cr, 2);
  dialogAnswer = 9;
  await Src.lingering(pc);
  assert.equal(stress(pc), 4, "the stored CR is reused");
});

test("An ally dies: watchers on the scene roll 1d8 per Hit Die; absent characters get a GM button (half)", async () => {
  const dead = makeActor("Reynauld", { level: 3 });
  const watcher = makeActor("Dismas");
  const away = makeActor("Paracelsus");
  game.actors = [dead, watcher, away];
  place(dead, 0);
  place(watcher, 3);
  rolls = [4, 5, 6];
  await Src.allyDied(dead);
  assert.equal(stress(watcher), 15);
  assert.equal(stress(away), 0);
  const button = chat.find(m => String(m.content).includes("sr-learn-button"));
  assert.ok(button);
  assert.deepEqual(button.whisper, ["gm"]);
  rolls = [4, 5, 6];
  await Src.learnOfDeath(away, "Reynauld", 3);
  assert.equal(stress(away), 7);
  // Only once.
  rolls = [8, 8, 8];
  await Src.allyDied(dead);
  assert.equal(stress(watcher), 15);
});

test("An enemy's death isn't mourned; a friendly NPC's is, by its HP dice", async () => {
  const pc = makeActor("Dismas");
  const orc = makeActor("Orc", { type: "npc", cr: 0.5, hpFormula: "2d8 + 6" });
  const guard = makeActor("Guard", { type: "npc", cr: 0.125, hpFormula: "2d8 + 2" });
  guard.prototypeToken.disposition = 1;
  game.actors = [pc];
  place(pc, 0); place(orc, 1); place(guard, 2);
  assert.equal(Src.hitDice(orc), 2);
  await Src.allyDied(orc);
  assert.equal(stress(pc), 0);
  rolls = [3, 3];
  await Src.allyDied(guard);
  assert.equal(stress(pc), 6);
});

test("Killing blow on a feared creature removes twice its CR", async () => {
  const ogre = makeActor("Ogre", { type: "npc", cr: 2 });
  const pc = makeActor("Boudica", { effects: [condition("frightened", ogre.uuid)] });
  await pc.setFlag("stress-and-resolve", "value", 9);
  ogre.system.attributes.hp.value = 5;
  ChatMessage.getSpeakerActor = () => pc;
  const options = { originatingMessage: { speaker: {}, rolls: [], getAssociatedItem: () => null } };
  Hooks.call("dnd5e.preApplyDamage", ogre, 8, { "system.attributes.hp.value": 0 }, options);
  ogre.system.attributes.hp.value = 0;
  Hooks.callAll("dnd5e.applyDamage", ogre, 8, options);
  await tick();
  assert.equal(stress(pc), 5);
});

test("parseCR reads fractions", () => {
  assert.equal(Src.parseCR("1/2"), 0.5);
  assert.equal(Src.parseCR("3"), 3);
  assert.equal(Src.parseCR(""), null);
});
