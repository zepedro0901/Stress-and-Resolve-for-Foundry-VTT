import { MODULE_ID } from "../constants.mjs";
import { getData, getLimit, onLongRest, spendStressDie, stressFacesFor, tracksStress } from "../stress.mjs";
import { activeShelter, partyChef } from "../adaptations.mjs";
import { canDarkCommune, darkCommune, partyBard, requestSongOfRest } from "../classes.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);
const SAFE_FIELD = "stressResolveSafe";
const COMMUNE_FIELD = "stressResolveCommune";
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

export function registerRestHooks() {
  // Short rest: add a "Stress Dice" section beside the hit dice.
  Hooks.on("renderShortRestDialog", (app, element) => {
    const actor = app.actor;
    if ( !tracksStress(actor) || element.querySelector(".sr-rest") ) return;
    const options = Object.values(actor.classes ?? {})
      .filter(c => c.system.hd.value > 0)
      .map(c => {
        const faces = stressFacesFor(actor, c);
        const denom = c.system.hd.denomination;
        return `<option value="${denom}">d${faces} — ${c.name} (${loc("Rest.UsesHitDie", { die: denom, n: c.system.hd.value })})</option>`;
      });
    const { value } = getData(actor);
    const chef = game.settings.get(MODULE_ID, "spellRiders") ? partyChef() : null;
    const song = game.settings.get(MODULE_ID, "classRiders") ? partyBard(actor) : null;
    const fieldset = document.createElement("fieldset");
    fieldset.classList.add("sr-rest");
    fieldset.innerHTML = `
      <legend>${loc("Rest.StressDice")}</legend>
      <p class="hint">${loc("Rest.StressNow", { value, limit: getLimit(actor) })}</p>
      ${options.length ? `
      <div class="form-fields">
        <select name="srDenom">${options.join("")}</select>
        <button type="button" class="dice-button sr-spend" data-tooltip="${loc("Rest.Spend")}"
                aria-label="${loc("Rest.Spend")}"><i class="fa-solid fa-brain" inert></i></button>
      </div>
      ${chef ? `<label class="checkbox"><input type="checkbox" name="srChef" checked>
        ${loc("Rest.Chef", { name: esc(chef.name) })}</label>` : ""}
      ${song ? `<label class="checkbox" data-tooltip="${loc("Rest.SongHint", { name: esc(song.bard.name) })}">
        <input type="checkbox" name="srSong"> ${loc("Rest.Song", { name: esc(song.bard.name), die: song.die })}</label>` : ""}` : `<div class="note warn">${loc("Notify.NoHitDice")}</div>`}`;
    fieldset.querySelector(".sr-spend")?.addEventListener("click", async event => {
      event.preventDefault();
      const denom = fieldset.querySelector("select[name=srDenom]").value;
      const ate = chef && fieldset.querySelector("input[name=srChef]")?.checked;
      const sung = song && fieldset.querySelector("input[name=srSong]")?.checked;
      const bonus = [];
      const labels = [];
      if ( ate ) { bonus.push("1d8"); labels.push(loc("Rest.ChefBonus", { name: chef.name })); }
      if ( sung ) {
        bonus.push(`1${song.die}`);
        labels.push(loc("Rest.SongBonus", { name: song.bard.name, die: song.die }));
        await requestSongOfRest(song.bard);
      }
      await spendStressDie(actor, denom, {
        shortRest: true,
        bonus: bonus.join(" + ") || null,
        bonusLabel: labels.join(" ") || null
      });
      app.render();
    });
    const anchor = element.querySelector("form section") ?? element.querySelector("form") ?? element;
    anchor.append(fieldset);
  });

  // Long rest: ask whether it happened somewhere safe.
  Hooks.on("renderLongRestDialog", (app, element) => {
    if ( !tracksStress(app.actor) || element.querySelector(".sr-rest") ) return;
    const shelter = game.settings.get(MODULE_ID, "spellRiders") ? activeShelter() : null;
    const checked = app.config[SAFE_FIELD] ?? (shelter ? true : game.settings.get(MODULE_ID, "safeRestDefault"));
    const group = document.createElement("div");
    group.classList.add("form-group", "sr-rest");
    group.innerHTML = `
      <label class="checkbox">
        <input type="checkbox" name="${SAFE_FIELD}" ${checked ? "checked" : ""}>
        ${loc("Rest.Safe")}
      </label>
      <p class="hint">${shelter ? loc("Rest.Shelter", {
        spell: foundry.utils.escapeHTML(shelter.spell), name: foundry.utils.escapeHTML(shelter.caster)
      }) : loc("Rest.SafeHint")}</p>
      ${game.settings.get(MODULE_ID, "classRiders") && canDarkCommune(app.actor) ? `
      <label class="checkbox">
        <input type="checkbox" name="${COMMUNE_FIELD}" ${app.config[COMMUNE_FIELD] ? "checked" : ""}>
        ${loc("Rest.Commune")}
      </label>
      <p class="hint">${loc("Rest.CommuneHint")}</p>` : ""}`;
    const anchor = element.querySelector("form section") ?? element.querySelector("form") ?? element;
    anchor.append(group);
  });

  Hooks.on("dnd5e.restCompleted", async (actor, result, config) => {
    // This hook only fires on the client that performed the rest, so it runs once.
    if ( !tracksStress(actor) || (config.type !== "long") || !actor.isOwner ) return;
    const shelter = game.settings.get(MODULE_ID, "spellRiders") ? activeShelter() : null;
    const safe = config[SAFE_FIELD] ?? (shelter ? true : game.settings.get(MODULE_ID, "safeRestDefault"));
    await onLongRest(actor, { safe: !!safe });
    // Dark Commune is paid after the rest's own recovery, so its Stress stays.
    if ( config[COMMUNE_FIELD] && game.settings.get(MODULE_ID, "classRiders") ) await darkCommune(actor);
  });
}
