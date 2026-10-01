import { AFFLICTIONS, MODULE_ID, VIRTUES, statusId } from "./constants.mjs";
import * as math from "./math.mjs";
import * as stress from "./stress.mjs";
import { initSocket, registerHandler } from "./socket.mjs";
import { registerDeathHooks } from "./hooks/death.mjs";
import { registerLevelHooks } from "./hooks/level.mjs";
import { registerRestHooks } from "./hooks/rest.mjs";
import { registerSheetHooks } from "./ui/sheet.mjs";
import { PartyStress, registerPartyHooks } from "./ui/party.mjs";
import { StressConfig } from "./ui/config-dialog.mjs";
import { TokenFX } from "./ui/token-fx.mjs";
import { Reveal } from "./ui/reveal.mjs";
import { registerEffects } from "./effects.mjs";
import { registerTempHP } from "./temp-hp.mjs";
import { promptStressDie, registerAdaptations } from "./adaptations.mjs";
import { registerClasses, suppress, unsuppress } from "./classes.mjs";
import { allyDied, registerSources } from "./sources.mjs";

Hooks.once("init", () => {
  registerSettings();
  registerStatuses();
  registerSheetHooks();
  registerLevelHooks();
  registerRestHooks();
  registerDeathHooks();
  registerPartyHooks();
  TokenFX.register();
  Reveal.register();
  registerEffects();
  registerTempHP();
  registerAdaptations();
  registerClasses();
  registerSources();
});

Hooks.once("ready", () => {
  initSocket();
  registerHandler("addStress", (actor, { amount, options }) => stress.addStress(actor, amount, options));
  registerHandler("resolveCheck", (actor, options) => stress.resolveCheck(actor, options));
  registerHandler("clearCondition", (actor, options) => stress.clearCondition(actor, options));
  registerHandler("mortality", actor => stress.mortality(actor));

  // Public API for macros and other modules: game.modules.get("stress-and-resolve").api
  game.modules.get(MODULE_ID).api = {
    addStress: stress.addStress,
    setStress: stress.setStress,
    getStress: actor => stress.getData(actor).value,
    getLimit: stress.getLimit,
    getData: stress.getData,
    resolveCheck: stress.resolveCheck,
    clearCondition: stress.clearCondition,
    spendStressDie: stress.spendStressDie,
    promptStressDie,
    suppressAffliction: suppress,
    /** Run the "an ally dies" Stress for an actor (e.g. after a death you resolved by hand). */
    allyDied,
    unsuppressAffliction: unsuppress,
    openParty: () => PartyStress.open(),
    openConfig: actor => new StressConfig({ document: actor }).render({ force: true }),
    mortality: stress.mortality,
    /** Preview the reveal locally: kind is "affliction", "virtue" or "mortality". */
    previewReveal: (actor, kind="affliction", key="paranoid") => Reveal.enqueue({ actor, kind, key }),
    math
  };
});

function registerSettings() {
  const world = (key, type, def, extra={}) => game.settings.register(MODULE_ID, key, {
    name: `SR.Settings.${key}.Name`,
    hint: `SR.Settings.${key}.Hint`,
    scope: "world",
    config: true,
    type,
    default: def,
    ...extra
  });
  world("chatOnChange", Boolean, true);
  world("variantResolve", Boolean, false, { requiresReload: false });
  world("safeRestDefault", Boolean, false);
  world("partyButton", Boolean, true, { onChange: () => ui.actors?.render() });

  // Affliction and virtue effects
  world("automateEffects", Boolean, true);
  world("nearbyRange", Number, 30, { range: { min: 5, max: 120, step: 5 } });
  world("gateAid", Boolean, true);
  world("fearStress", Boolean, true);
  world("turnReminders", Boolean, true);

  // Stress sources and spell/feat riders
  world("psychicStress", Boolean, true);
  world("zeroHpStress", Boolean, true);
  world("critStress", Boolean, true);
  world("fearTargetStress", Boolean, true);
  world("conditionStress", Boolean, true);
  world("allyDeathStress", Boolean, true);
  world("killingBlowRelief", Boolean, true);
  world("tempHpChoice", Boolean, true);
  world("spellRiders", Boolean, true);
  world("classRiders", Boolean, true);

  // Token visuals
  const redrawTokens = () => canvas.ready && canvas.tokens.placeables.forEach(t => TokenFX.refresh(t, { force: true }));
  world("tokenBar", String, "always", {
    choices: { always: "SR.Settings.tokenBar.Always", hover: "SR.Settings.tokenBar.Hover", never: "SR.Settings.tokenBar.Never" },
    onChange: redrawTokens
  });
  world("tokenAura", Boolean, true, { onChange: redrawTokens });

  // Reveal animation
  const client = (key, type, def, extra={}) => world(key, type, def, { scope: "client", ...extra });
  client("revealAnimation", Boolean, true);
  client("revealCamera", Boolean, true);
  client("revealVolume", Number, 0.8, { range: { min: 0, max: 1, step: 0.05 } });
  world("revealDuration", Number, 4, { range: { min: 2, max: 10, step: 0.5 } });
  const sound = file => `modules/${MODULE_ID}/sounds/${file}`;
  world("soundAffliction", String, sound("affliction.ogg"), { filePicker: "audio" });
  world("soundVirtue", String, sound("virtue.ogg"), { filePicker: "audio" });
  world("soundHeartAttack", String, sound("heart-attack.ogg"), { filePicker: "audio" });

  client("debug", Boolean, false);
}

/** Afflictions and virtues become token status effects (dnd5e merges these during setup). */
function registerStatuses() {
  const add = (key, img) => {
    CONFIG.DND5E.statusEffects[statusId(key)] = { name: `SR.Condition.${key}.Name`, img };
  };
  for ( const [key, { img }] of Object.entries(AFFLICTIONS) ) add(key, img);
  for ( const [key, { img }] of Object.entries(VIRTUES) ) add(key, img);
}
