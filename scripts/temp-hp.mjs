/**
 * Temporary hit points: one layer at a time, protecting either HP or Stress.
 *
 * When a character gains temporary HP (any source: spells, feats, the sheet, a damage card), the
 * gain is held back and the character's player chooses what it protects. The Stress layer lives in
 * flags.stress-and-resolve.tempStress and soaks Stress gains first (see addStress).
 */
import { MODULE_ID } from "./constants.mjs";
import { getData, tracksStress } from "./stress.mjs";
import { registerHandler, requestUser } from "./socket.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);
const TEMP = "system.attributes.hp.temp";

/** Read the new temporary HP from an update, flat or nested. */
export function readTemp(changes) {
  if ( TEMP in changes ) return changes[TEMP];
  return changes.system?.attributes?.hp?.temp;
}

/** Remove the temporary HP change from an update, flat or nested. */
export function stripTemp(changes) {
  if ( TEMP in changes ) delete changes[TEMP];
  const hp = changes.system?.attributes?.hp;
  if ( hp && ("temp" in hp) ) delete hp.temp;
}

/**
 * Is this update a new layer of temporary HP (rather than damage eating into the current one)?
 * @param {number} current  Temporary HP on the HP layer now.
 * @param {number} next     Temporary HP after the update.
 */
export function isTempGain(current, next) {
  next = Number(next) || 0;
  return next > (Number(current) || 0);
}

/** The player who should choose: the character's own player if online, else any owner online, else this user. */
function chooser(actor) {
  const players = game.users.filter(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
  return players.find(u => u.character?.id === actor.id) ?? players[0] ?? game.user;
}

/** Apply a choice: "hp", "stress" or "keep". */
export async function applyTempChoice(actor, amount, choice) {
  if ( choice === "keep" ) return postChoice(actor, amount, choice);
  const update = choice === "stress"
    ? { [TEMP]: 0, [`flags.${MODULE_ID}.tempStress`]: amount }
    : { [TEMP]: amount, [`flags.${MODULE_ID}.tempStress`]: 0 };
  await actor.update(update, { [MODULE_ID]: { temp: true } });
  return postChoice(actor, amount, choice);
}

async function postChoice(actor, amount, choice) {
  try {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="sr-card sr-temp-card"><p>${loc(`TempHP.Chose.${choice}`, { name: actor.name, n: amount })}</p></div>`
    });
  } catch(err) {
    console.error(`${MODULE_ID} | Could not post a chat card`, err);
  }
}

/** Ask what the new temporary HP protects. Closing the dialog keeps the system's default (HP). */
export async function promptTempChoice(actor, amount) {
  const hpTemp = Number(actor.system.attributes.hp.temp) || 0;
  const { tempStress } = getData(actor);
  const current = hpTemp ? loc("TempHP.CurrentHP", { n: hpTemp })
    : tempStress ? loc("TempHP.CurrentStress", { n: tempStress }) : loc("TempHP.CurrentNone");
  const buttons = [
    { action: "hp", label: loc("TempHP.ProtectHP"), icon: "fa-solid fa-heart", default: true },
    { action: "stress", label: loc("TempHP.ProtectStress"), icon: "fa-solid fa-brain" }
  ];
  if ( hpTemp || tempStress ) buttons.push({ action: "keep", label: loc("TempHP.Keep"), icon: "fa-solid fa-hand" });
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: loc("TempHP.Title", { name: actor.name }), icon: "fa-solid fa-shield-heart" },
    content: `<p>${loc("TempHP.Body", { name: foundry.utils.escapeHTML(actor.name), n: amount })}</p>
      <p>${current}</p><p class="hint">${loc("TempHP.Hint")}</p>`,
    buttons,
    rejectClose: false
  });
  return applyTempChoice(actor, amount, choice ?? "hp");
}

export function registerTempHP() {
  registerHandler("tempChoice", (actor, { amount }) => promptTempChoice(actor, amount));

  Hooks.on("preUpdateActor", (actor, changes, options, userId) => {
    if ( (userId !== game.user.id) || !tracksStress(actor) || options?.[MODULE_ID]?.temp ) return;
    if ( !game.settings.get(MODULE_ID, "tempHpChoice") ) return;
    const next = readTemp(changes);
    if ( next === undefined ) return;
    if ( !isTempGain(actor.system.attributes.hp.temp, next) ) return;
    // Hold the new layer back until someone chooses what it protects.
    stripTemp(changes);
    const amount = Number(next);
    const user = chooser(actor);
    setTimeout(() => {
      if ( user.id === game.user.id ) promptTempChoice(actor, amount);
      else requestUser(user.id, "tempChoice", { actorUuid: actor.uuid, amount });
    }, 0);
  });
}
