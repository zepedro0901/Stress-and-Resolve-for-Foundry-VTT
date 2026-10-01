import { AFFLICTIONS, MODULE_ID, VIRTUES } from "../constants.mjs";
import { tracksStress } from "../stress.mjs";
import { TokenFX } from "./token-fx.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

/**
 * The resolve reveal: when a character becomes afflicted or virtuous (or suffers a heart attack),
 * every connected client pans to the token, dims the screen and slams in a title for a few seconds.
 * It runs from the actor update, which every client receives, so it plays even off-turn.
 */
export class Reveal {
  static #queue = [];
  static #playing = false;

  static register() {
    Hooks.on("updateActor", (actor, changes) => {
      if ( !tracksStress(actor) ) return;
      const flags = changes.flags?.[MODULE_ID];
      if ( !flags ) return;
      const data = actor.flags[MODULE_ID] ?? {};
      // A new affliction or virtue always writes `condition`, even when switching between two afflictions.
      if ( flags.condition && ["afflicted", "virtuous"].includes(data.state) ) {
        this.enqueue({ actor, kind: data.state === "virtuous" ? "virtue" : "affliction", key: data.condition });
      }
      else if ( flags.heartAttack === true ) this.enqueue({ actor, kind: "mortality" });
    });
  }

  static enqueue(entry) {
    this.#queue.push(entry);
    if ( !this.#playing ) this.#next();
  }

  static async #next() {
    const entry = this.#queue.shift();
    if ( !entry ) { this.#playing = false; return; }
    this.#playing = true;
    try {
      await this.play(entry);
    } catch(err) {
      console.error(`${MODULE_ID} | Reveal animation failed`, err);
    }
    this.#next();
  }

  /**
   * Play one reveal.
   * @param {object} entry
   * @param {Actor} entry.actor
   * @param {"affliction"|"virtue"|"mortality"} entry.kind
   * @param {string} [entry.key]  Affliction or virtue key.
   */
  static async play({ actor, kind, key }) {
    const enabled = game.settings.get(MODULE_ID, "revealAnimation");
    const token = TokenFX.tokensFor(actor).find(t => t.visible) ?? null;
    if ( !enabled ) {
      if ( token ) TokenFX.burst(token, kind);
      return;
    }

    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = Math.clamp(Number(game.settings.get(MODULE_ID, "revealDuration")) || 4, 2, 10) * 1000;

    // Camera: focus the token, then return to where the player was looking.
    const camera = game.settings.get(MODULE_ID, "revealCamera") && token && !reduce;
    const previous = camera ? { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x } : null;
    if ( camera ) {
      canvas.animatePan({ ...token.center, scale: Math.max(previous.scale, 1), duration: 700 });
    }

    this.#playSound(kind);
    const overlay = this.#buildOverlay(actor, kind, key, duration);
    document.body.append(overlay);

    // Canvas burst and shake when the title lands.
    await wait(700);
    if ( token ) TokenFX.burst(token, kind);
    if ( !reduce ) this.#shake(kind === "virtue" ? 6 : 14, 450);

    await wait(duration - 700);
    overlay.remove();
    if ( camera && previous ) await canvas.animatePan({ ...previous, duration: 700 });
  }

  static #buildOverlay(actor, kind, key, duration) {
    const el = document.createElement("div");
    el.className = `sr-reveal sr-reveal-${kind}`;
    el.style.setProperty("--sr-duration", `${duration}ms`);
    el.setAttribute("aria-live", "assertive");

    let kicker, word, detail = "", img = null;
    if ( kind === "mortality" ) {
      kicker = loc("Reveal.MortalityKicker", { name: esc(actor.name) });
      word = loc("Reveal.HeartAttack");
      detail = loc("Reveal.HeartAttackDetail");
    } else {
      kicker = loc("Reveal.Kicker", { name: esc(actor.name) });
      word = loc(kind === "virtue" ? "Reveal.Virtuous" : "Reveal.Afflicted");
      detail = loc(`Condition.${key}.Name`);
      img = (AFFLICTIONS[key] ?? VIRTUES[key])?.img;
    }

    el.style.setProperty("--sr-chars", String(Math.max(6, [...word].length)));
    el.innerHTML = `
      <div class="sr-reveal-vignette"></div>
      ${kind === "virtue" ? `<div class="sr-reveal-rays"></div>` : `<div class="sr-reveal-cracks"></div>`}
      <div class="sr-reveal-band">
        <img class="sr-reveal-portrait" src="${esc(actor.img)}" alt="">
        <div class="sr-reveal-text">
          <div class="sr-reveal-kicker">${kicker}</div>
          <div class="sr-reveal-word">${esc(word)}</div>
          <div class="sr-reveal-detail">${img ? `<img src="${esc(img)}" alt="">` : ""}<span>${esc(detail)}</span></div>
        </div>
      </div>`;
    return el;
  }

  static #playSound(kind) {
    const key = { affliction: "soundAffliction", virtue: "soundVirtue", mortality: "soundHeartAttack" }[kind];
    const src = game.settings.get(MODULE_ID, key);
    const volume = Number(game.settings.get(MODULE_ID, "revealVolume") ?? 0.8);
    if ( !src || !(volume > 0) ) return;
    const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
    try {
      helper?.play({ src, volume, autoplay: true, loop: false }, false);
    } catch(err) {
      console.warn(`${MODULE_ID} | Could not play ${src}`, err);
    }
  }

  /** Shake the canvas. Uses Foundry's VFX shake when available, else a CSS shake on the board. */
  static #shake(amplitude, ms) {
    try {
      const VFX = foundry.canvas?.vfx?.VFXEffect;
      if ( VFX && CONFIG.Canvas.vfx?.enabled ) {
        const effect = new VFX({
          name: `${MODULE_ID}.shake`,
          components: { shake: { type: "shake", target: "stage", duration: ms, maxDisplacement: amplitude, smoothness: 0.5 } },
          timeline: [{ component: "shake", position: 0 }]
        });
        effect.play({});
        return;
      }
    } catch(err) {
      console.debug(`${MODULE_ID} | VFX shake unavailable, using CSS`, err);
    }
    const board = document.getElementById("board");
    if ( !board ) return;
    board.style.setProperty("--sr-shake", `${amplitude}px`);
    board.classList.remove("sr-shake");
    void board.offsetWidth;
    board.classList.add("sr-shake");
    setTimeout(() => board.classList.remove("sr-shake"), ms);
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
