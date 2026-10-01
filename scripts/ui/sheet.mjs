import { AFFLICTIONS, VIRTUES } from "../constants.mjs";
import { addStress, getData, getLimit, setStress, tracksStress } from "../stress.mjs";
import { StressConfig } from "./config-dialog.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);

/** Add the Stress meter to the default dnd5e character sheet, under Hit Dice. */
export function registerSheetHooks() {
  Hooks.on("renderCharacterActorSheet", (app, element) => {
    const actor = app.actor ?? app.document;
    if ( !tracksStress(actor) ) return;
    const stats = element.querySelector(".sidebar .stats");
    if ( !stats ) return;
    stats.querySelector(".sr-stress-group")?.remove();
    stats.append(buildMeter(actor));
  });
}

function buildMeter(actor) {
  const data = getData(actor);
  const limit = getLimit(actor);
  const pct = Math.clamp(Math.round(100 * data.value / limit), 0, 100);
  const over = data.value >= 2 * limit ? "sr-mortal" : data.value >= limit ? "sr-over" : "";
  const editable = actor.isOwner;

  let badge = "";
  if ( data.state ) {
    const img = (AFFLICTIONS[data.condition] ?? VIRTUES[data.condition])?.img;
    const name = loc(`Condition.${data.condition}.Name`);
    badge = `<span class="sr-badge sr-${data.state === "virtuous" ? "virtue" : "affliction"}"
      data-tooltip="${foundry.utils.escapeHTML(loc(`Condition.${data.condition}.Short`))}">
      ${img ? `<img src="${img}" alt="">` : ""}${name}${data.suppressed ? ` (${loc("Class.Calm.Short")})` : ""}</span>`;
  }

  const group = document.createElement("div");
  group.classList.add("meter-group", "sr-stress-group");
  group.innerHTML = `
    <div class="label roboto-condensed-upper">
      <span>${loc("Stress")}</span>
      ${badge}
      ${editable ? `<button type="button" class="config-button unbutton sr-config" data-tooltip="${loc("Config.Title")}"
        aria-label="${loc("Config.Title")}"><i class="fas fa-cog" inert></i></button>` : ""}
    </div>
    <div class="meter hit-dice progress meter-lg sr-stress ${over}" role="meter" aria-valuemin="0"
         aria-valuenow="${data.value}" aria-valuemax="${limit}" style="--bar-percentage: ${pct}%"
         data-tooltip="${loc("Sheet.Tooltip", { limit, mortal: 2 * limit })}">
      <div class="label">
        <span class="value">${data.value}</span>
        <span class="separator">&sol;</span>
        <span class="max">${limit}</span>
        ${data.tempStress ? `<span class="sr-temp" data-tooltip="${loc("Sheet.TempTooltip", { n: data.tempStress })}">+${data.tempStress}</span>` : ""}
      </div>
      ${editable ? `<input type="text" class="sr-input" value="${data.value}" hidden
        aria-label="${loc("Stress")}" placeholder="0">` : ""}
    </div>`;

  if ( editable ) {
    const meter = group.querySelector(".sr-stress");
    const label = meter.querySelector(".label");
    const input = meter.querySelector(".sr-input");
    meter.addEventListener("click", () => {
      if ( !input.hidden ) return;
      label.hidden = true;
      input.hidden = false;
      input.focus();
      input.select();
    });
    const commit = async () => {
      if ( input.hidden ) return;
      const raw = input.value.trim();
      input.hidden = true;
      label.hidden = false;
      if ( !raw ) return;
      // "+3" / "-2" change Stress; a plain number sets it.
      const reason = loc("Reason.ManualBy", { user: game.user.name });
      if ( /^[+-]/.test(raw) ) await addStress(actor, Number(raw), { reason });
      else await setStress(actor, Number(raw), { reason });
    };
    input.addEventListener("keydown", event => {
      event.stopPropagation();
      if ( event.key === "Enter" ) { event.preventDefault(); input.blur(); }
      if ( event.key === "Escape" ) { input.value = data.value; input.blur(); }
    });
    input.addEventListener("change", event => event.stopPropagation());
    input.addEventListener("blur", commit);
    group.querySelector(".sr-config")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      new StressConfig({ document: actor }).render({ force: true });
    });
  }
  return group;
}
