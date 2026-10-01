import { MODULE_ID } from "../constants.mjs";
import { fixedGain } from "../math.mjs";
import { getData, getLimit, postCard, stressFacesFor, tracksStress } from "../stress.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);

/**
 * Stress Limit growth on level up: roll the class's Stress Die or take half +1, like hit points.
 * Levels without a stored choice default to half +1, so existing characters work immediately.
 */
export function registerLevelHooks() {
  Hooks.on("preUpdateItem", (item, changes, options) => {
    if ( (item.type !== "class") || !foundry.utils.hasProperty(changes, "system.levels") ) return;
    options[MODULE_ID] = { oldLevels: item.system.levels };
  });

  Hooks.on("updateItem", (item, changes, options, userId) => {
    if ( (userId !== game.user.id) || (item.type !== "class") || !options[MODULE_ID] ) return;
    const delta = (item.system.levels ?? 0) - options[MODULE_ID].oldLevels;
    onLevelChange(item.parent, item, delta);
  });

  Hooks.on("createItem", (item, options, userId) => {
    if ( (userId !== game.user.id) || (item.type !== "class") ) return;
    // A new class at level 1 on an existing character is a multiclass level-up.
    const level = item.parent?.system?.details?.level ?? 1;
    if ( level > 1 ) onLevelChange(item.parent, item, item.system.levels ?? 1);
  });

  Hooks.on("deleteItem", (item, options, userId) => {
    if ( (userId !== game.user.id) || (item.type !== "class") ) return;
    onLevelChange(item.parent, item, -(item.system.levels ?? 0));
  });
}

async function onLevelChange(actor, cls, delta) {
  if ( !tracksStress(actor) || !delta ) return;
  const level = actor.system.details.level;
  const gains = [...getData(actor).gains];

  // Level down: forget gains above the new level.
  if ( delta < 0 ) {
    gains.length = Math.min(gains.length, Math.max(0, level - 1));
    return actor.setFlag(MODULE_ID, "gains", gains);
  }

  const faces = stressFacesFor(actor, cls);
  for ( let lvl = level - delta + 1; lvl <= level; lvl++ ) {
    if ( lvl < 2 ) continue;
    const gain = await promptGain(actor, faces, lvl);
    // Fill any gaps (e.g. module installed mid-campaign) with half +1.
    while ( gains.length < lvl - 2 ) gains.push(fixedGain(faces));
    gains[lvl - 2] = gain;
  }
  await actor.setFlag(MODULE_ID, "gains", gains);
  await postCard(actor, loc("Chat.LimitIncreased", { name: actor.name, limit: getLimit(actor) }));
}

/** Ask the owner to roll or take the fixed value. Closing the dialog takes the fixed value. */
async function promptGain(actor, faces, level) {
  const fixed = fixedGain(faces);
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: loc("Level.Title", { name: actor.name, level }) },
    content: `<p>${loc("Level.Body", { die: `d${faces}`, fixed })}</p>`,
    buttons: [
      { action: "roll", label: loc("Level.Roll", { die: `d${faces}` }), icon: "fa-solid fa-dice", default: true },
      { action: "fixed", label: loc("Level.Fixed", { fixed }), icon: "fa-solid fa-equals" }
    ],
    rejectClose: false
  });
  if ( choice !== "roll" ) return fixed;
  const roll = await new Roll(`1d${faces}`).evaluate();
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: loc("Level.Flavor", { level })
  });
  return roll.total;
}
