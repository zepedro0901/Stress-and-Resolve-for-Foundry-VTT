import { AFFLICTIONS, MODULE_ID, VIRTUES } from "../constants.mjs";
import { getData, getLimit, tracksStress } from "../stress.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);
const { ApplicationV2 } = foundry.applications.api;

/** Everyone can see the party's Stress, afflictions and virtues. */
export class PartyStress extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "sr-party-stress",
    classes: ["stress-and-resolve", "sr-party-app"],
    position: { width: 340, height: "auto" },
    window: { icon: "fa-solid fa-brain", resizable: true }
  };

  static #instance;

  static open() {
    this.#instance ??= new PartyStress();
    this.#instance.render({ force: true });
  }

  static refresh() {
    if ( this.#instance?.rendered ) this.#instance.render();
  }

  get title() {
    return loc("Party.Title");
  }

  /** Player characters that belong to a player. */
  static members() {
    return game.actors.filter(a => tracksStress(a) && a.hasPlayerOwner)
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  }

  async _renderHTML() {
    const rows = PartyStress.members().map(actor => {
      const data = getData(actor);
      const limit = getLimit(actor);
      const pct = Math.clamp(Math.round(100 * data.value / limit), 0, 100);
      const over = data.value >= 2 * limit ? "sr-mortal" : data.value >= limit ? "sr-over" : "";
      const cond = data.state ? `<span class="sr-badge sr-${data.state === "virtuous" ? "virtue" : "affliction"}">
        <img src="${(AFFLICTIONS[data.condition] ?? VIRTUES[data.condition])?.img}" alt="">
        ${loc(`Condition.${data.condition}.Name`)}${data.suppressed ? ` (${loc("Class.Calm.Short")})` : ""}</span>` : "";
      return `
        <li class="sr-party-row">
          <img class="sr-portrait" src="${actor.img}" alt="">
          <div class="sr-party-body">
            <div class="sr-party-name"><strong>${foundry.utils.escapeHTML(actor.name)}</strong> ${cond}</div>
            <div class="sr-bar ${over}"><div class="sr-fill" style="width: ${pct}%"></div>
              <span>${data.value} / ${limit}${data.tempStress ? ` <em class="sr-temp">+${data.tempStress}</em>` : ""}</span></div>
          </div>
        </li>`;
    });
    return rows.length ? `<ul class="sr-party unlist">${rows.join("")}</ul>`
      : `<p class="hint">${loc("Party.Empty")}</p>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }
}

export function registerPartyHooks() {
  Hooks.on("updateActor", actor => { if ( tracksStress(actor) ) PartyStress.refresh(); });
  Hooks.on("createActiveEffect", () => PartyStress.refresh());
  Hooks.on("deleteActiveEffect", () => PartyStress.refresh());

  // Button in the Actors sidebar.
  Hooks.on("renderActorDirectory", (app, element) => {
    if ( !game.settings.get(MODULE_ID, "partyButton") ) return;
    const root = element instanceof HTMLElement ? element : element?.[0];
    if ( !root || root.querySelector(".sr-party-button") ) return;
    const target = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
    if ( !target ) return;
    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("sr-party-button");
    button.innerHTML = `<i class="fa-solid fa-brain" inert></i> ${loc("Party.Title")}`;
    button.addEventListener("click", () => PartyStress.open());
    target.append(button);
  });
}
