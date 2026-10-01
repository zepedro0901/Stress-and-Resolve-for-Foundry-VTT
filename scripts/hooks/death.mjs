import { MODULE_ID } from "../constants.mjs";
import { addStress, getData, recoverFromHeartAttack, tracksStress } from "../stress.mjs";

/** Recover from a heart attack when the character is stabilised or healed. */
export function registerDeathHooks() {
  // Dropping to 0 HP adds Stress equal to the character's level (not from a heart attack).
  Hooks.on("preUpdateActor", (actor, changes, options, userId) => {
    if ( (userId !== game.user.id) || !tracksStress(actor) ) return;
    const hp = foundry.utils.getProperty(changes, "system.attributes.hp.value") ?? changes["system.attributes.hp.value"];
    if ( hp === undefined ) return;
    const heartAttack = foundry.utils.getProperty(changes, `flags.${MODULE_ID}.heartAttack`)
      ?? changes[`flags.${MODULE_ID}.heartAttack`];
    (options[MODULE_ID] ??= {}).hpWas = heartAttack ? 0 : (Number(actor.system.attributes.hp.value) || 0);
  });
  Hooks.on("updateActor", (actor, changes, options, userId) => {
    if ( (userId !== game.user.id) || !tracksStress(actor) ) return;
    if ( !game.settings.get(MODULE_ID, "zeroHpStress") ) return;
    const was = options?.[MODULE_ID]?.hpWas;
    if ( !(was > 0) || ((Number(actor.system.attributes.hp.value) || 0) > 0) ) return;
    // Only once per combat encounter.
    const combat = game.combat?.started ? game.combat : null;
    if ( combat ) {
      if ( actor.getFlag(MODULE_ID, "zeroHpCombat") === combat.id ) return;
      actor.setFlag(MODULE_ID, "zeroHpCombat", combat.id);
    }
    const level = Number(actor.system.details?.level) || 1;
    addStress(actor, level, { reason: game.i18n.format("SR.Reason.ZeroHP", { n: level }) });
  });

  Hooks.on("dnd5e.rollDeathSave", (rolls, { subject, outcome }) => {
    if ( !tracksStress(subject) || !["stable", "revive"].includes(outcome) ) return;
    if ( getData(subject).heartAttack ) setTimeout(() => recoverFromHeartAttack(subject), 0);
  });

  Hooks.on("updateActor", (actor, changes, options, userId) => {
    if ( (userId !== game.user.id) || !tracksStress(actor) || !getData(actor).heartAttack ) return;
    const hp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
    if ( hp > 0 ) recoverFromHeartAttack(actor);
  });

  Hooks.on("createActiveEffect", (effect, options, userId) => {
    const actor = effect.parent;
    if ( (userId !== game.user.id) || !(actor instanceof Actor) || !tracksStress(actor) ) return;
    if ( effect.statuses?.has("stable") && getData(actor).heartAttack ) recoverFromHeartAttack(actor);
  });
}
