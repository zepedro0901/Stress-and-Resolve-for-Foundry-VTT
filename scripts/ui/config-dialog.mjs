import { AFFLICTIONS, MODULE_ID, VIRTUES } from "../constants.mjs";
import { fixedGain } from "../math.mjs";
import {
  clearCondition, getData, getLimit, mortality, resolveCheck, setCondition, setStress, stressFacesFor
} from "../stress.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);
const { ApplicationV2 } = foundry.applications.api;

/**
 * Per-character Stress settings: current Stress, Stress Limit gains per level, Tough,
 * signature affliction/virtue (Variant Resolve) and, for the GM, the current condition.
 */
export class StressConfig extends ApplicationV2 {
  constructor(options) {
    super(options);
    this.actor = options.document;
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["stress-and-resolve", "sr-config-app"],
    position: { width: 420, height: "auto" },
    window: { icon: "fa-solid fa-brain", contentClasses: ["standard-form"] },
    form: { handler: StressConfig.#onSubmit, closeOnSubmit: true },
    actions: { rollResolve: StressConfig.#onRollResolve, faceMortality: StressConfig.#onFaceMortality }
  };

  get title() {
    return `${loc("Config.Title")}: ${this.actor.name}`;
  }

  async _renderHTML() {
    const actor = this.actor;
    const data = getData(actor);
    const faces = stressFacesFor(actor);
    const wis = actor.system.abilities.wis.mod;
    const level = actor.system.details.level;
    const isGM = game.user.isGM;
    const variant = game.settings.get(MODULE_ID, "variantResolve");
    const opt = (value, label, selected) =>
      `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
    const name = key => loc(`Condition.${key}.Name`);

    const gainRows = [];
    for ( let lvl = 2; lvl <= level; lvl++ ) {
      const stored = data.gains[lvl - 2];
      gainRows.push(`
        <div class="form-group">
          <label>${loc("Config.LevelGain", { level: lvl })}</label>
          <div class="form-fields">
            <input type="number" name="gains.${lvl - 2}" min="0" step="1"
                   value="${Number.isFinite(stored) ? stored : ""}" placeholder="${fixedGain(faces)}">
          </div>
        </div>`);
    }

    const conditionSelect = isGM ? `
      <div class="form-group">
        <label>${loc("Config.Condition")}</label>
        <div class="form-fields">
          <select name="condition">
            ${opt("", loc("Config.None"), data.condition ?? "")}
            <optgroup label="${loc("Afflictions")}">
              ${Object.keys(AFFLICTIONS).map(k => opt(`afflicted:${k}`, name(k),
                data.state === "afflicted" ? `afflicted:${data.condition}` : "")).join("")}
            </optgroup>
            <optgroup label="${loc("Virtues")}">
              ${Object.keys(VIRTUES).map(k => opt(`virtuous:${k}`, name(k),
                data.state === "virtuous" ? `virtuous:${data.condition}` : "")).join("")}
            </optgroup>
          </select>
          <button type="button" data-action="rollResolve" data-tooltip="${loc("Config.RollResolve")}"
                  aria-label="${loc("Config.RollResolve")}"><i class="fa-solid fa-dice-d20" inert></i></button>
          <button type="button" data-action="faceMortality" data-tooltip="${loc("Config.FaceMortality")}"
                  aria-label="${loc("Config.FaceMortality")}"><i class="fa-solid fa-heart-crack" inert></i></button>
        </div>
      </div>
      <div class="form-group">
        <label>${loc("Config.HeartAttack")}</label>
        <div class="form-fields"><input type="checkbox" name="heartAttack" ${data.heartAttack ? "checked" : ""}></div>
      </div>` : "";

    const signature = variant ? `
      <fieldset>
        <legend>${loc("Config.Signature")}</legend>
        <p class="hint">${loc("Config.SignatureHint")}</p>
        <div class="form-group">
          <label>${loc("Config.SignatureAffliction")}</label>
          <select name="signature.affliction">
            ${opt("", loc("Config.None"), data.signature.affliction ?? "")}
            ${Object.keys(AFFLICTIONS).filter(k => k !== "refracted")
              .map(k => opt(k, name(k), data.signature.affliction ?? "")).join("")}
          </select>
        </div>
        <div class="form-group">
          <label>${loc("Config.SignatureVirtue")}</label>
          <select name="signature.virtue">
            ${opt("", loc("Config.None"), data.signature.virtue ?? "")}
            ${Object.keys(VIRTUES).map(k => opt(k, name(k), data.signature.virtue ?? "")).join("")}
          </select>
        </div>
      </fieldset>` : "";

    return `
      <fieldset>
        <legend>${loc("Stress")}</legend>
        <div class="form-group">
          <label>${loc("Config.Current")}</label>
          <div class="form-fields"><input type="number" name="value" min="0" step="1" value="${data.value}"></div>
        </div>
        ${isGM ? `<div class="form-group">
          <label>${loc("Config.TempStress")}</label>
          <div class="form-fields"><input type="number" name="tempStress" min="0" step="1" value="${data.tempStress}"></div>
          <p class="hint">${loc("Config.TempStressHint")}</p>
        </div>` : ""}
        ${conditionSelect}
      </fieldset>
      <fieldset>
        <legend>${loc("Config.Limit", { limit: getLimit(actor) })}</legend>
        <p class="hint">${loc("Config.LimitHint", { die: `d${faces}`, max: faces, wis, fixed: fixedGain(faces) })}</p>
        ${gainRows.join("")}
        <div class="form-group">
          <label>${loc("Config.Tough")}</label>
          <div class="form-fields"><input type="checkbox" name="tough" ${data.tough ? "checked" : ""}></div>
          <p class="hint">${loc("Config.ToughHint")}</p>
        </div>
      </fieldset>
      ${signature}
      <fieldset>
        <legend>${loc("Config.Native")}</legend>
        <p class="hint">${loc("Config.NativeHint")}</p>
        <div class="form-group">
          <label>${loc("Config.NativeBlind")}</label>
          <div class="form-fields"><input type="checkbox" name="nativeBlind" ${actor.flags?.[MODULE_ID]?.nativeBlind ? "checked" : ""}></div>
        </div>
        <div class="form-group">
          <label>${loc("Config.NativeDeaf")}</label>
          <div class="form-fields"><input type="checkbox" name="nativeDeaf" ${actor.flags?.[MODULE_ID]?.nativeDeaf ? "checked" : ""}></div>
        </div>
      </fieldset>
      <footer class="form-footer">
        <button type="submit"><i class="fa-solid fa-save" inert></i> ${loc("Config.Save")}</button>
      </footer>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  static async #onSubmit(event, form, formData) {
    const actor = this.actor;
    const data = foundry.utils.expandObject(formData.object);
    const gains = [];
    for ( const [i, v] of Object.entries(data.gains ?? {}) ) {
      const n = Number(v);
      gains[Number(i)] = (v === "" || v === null || !Number.isFinite(n)) ? null : n;
    }
    const update = {
      [`flags.${MODULE_ID}.gains`]: gains,
      [`flags.${MODULE_ID}.tough`]: !!data.tough,
      [`flags.${MODULE_ID}.nativeBlind`]: !!data.nativeBlind,
      [`flags.${MODULE_ID}.nativeDeaf`]: !!data.nativeDeaf
    };
    if ( data.signature ) {
      update[`flags.${MODULE_ID}.signature`] = {
        affliction: data.signature.affliction || null,
        virtue: data.signature.virtue || null
      };
    }
    if ( game.user.isGM ) {
      update[`flags.${MODULE_ID}.heartAttack`] = !!data.heartAttack;
      const temp = Math.max(0, Math.floor(Number(data.tempStress) || 0));
      update[`flags.${MODULE_ID}.tempStress`] = temp;
      // One layer of temporary HP at a time.
      if ( temp && actor.system.attributes.hp.temp ) update["system.attributes.hp.temp"] = 0;
    }
    await actor.update(update);

    if ( game.user.isGM && ("condition" in data) ) {
      const current = getData(actor);
      const currentKey = current.state ? `${current.state}:${current.condition}` : "";
      if ( data.condition !== currentKey ) {
        if ( !data.condition ) await clearCondition(actor);
        else {
          const [state, key] = data.condition.split(":");
          await setCondition(actor, state, key);
        }
      }
    }
    // Setting Stress last lets resolve and mortality react to the new Limit.
    await setStress(actor, data.value, { reason: loc("Reason.ManualBy", { user: game.user.name }) });
  }

  static async #onFaceMortality() {
    await mortality(this.actor);
    this.render();
  }

  static async #onRollResolve() {
    await resolveCheck(this.actor);
    this.render();
  }
}
