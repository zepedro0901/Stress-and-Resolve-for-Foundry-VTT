import { MODULE_ID } from "../constants.mjs";
import { getData, getLimit, tracksStress } from "../stress.mjs";

const loc = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);

const COLORS = {
  affliction: { main: 0xff3b2f, deep: 0x7a0f0a, glow: 0xff2a1a, text: "#ff6b5e" },
  virtue: { main: 0xffd24a, deep: 0xb8860b, glow: 0xffe08a, text: "#ffe08a" },
  bar: { fill: 0x8e4fd6, over: 0xd23c2c, bg: 0x000000, notch: 0xffffff, temp: 0x5fd3f3 }
};

/**
 * Canvas visuals on character tokens:
 * - a Stress bar above the token (scale 0 → 2× Limit, with a notch at the Limit),
 * - a pulsing aura, rotating thorns (affliction) or sun rays (virtue), and a big title,
 * - a burst of rings and sparks when a character becomes afflicted or virtuous.
 */
export class TokenFX {
  static #overlays = new Set();
  static #bursts = new Set();
  static #tickerBound = null;

  static register() {
    Hooks.on("drawToken", token => this.#attach(token));
    Hooks.on("refreshToken", token => this.refresh(token));
    Hooks.on("destroyToken", token => this.#detach(token));
    Hooks.on("hoverToken", token => this.refresh(token));
    Hooks.on("controlToken", token => this.refresh(token));
    Hooks.on("canvasReady", () => this.#startTicker());
    Hooks.on("canvasTearDown", () => { this.#overlays.clear(); this.#bursts.clear(); });
    Hooks.on("updateActor", actor => this.refreshActor(actor));
    Hooks.on("createActiveEffect", effect => { if ( effect.parent instanceof Actor ) this.refreshActor(effect.parent); });
    Hooks.on("deleteActiveEffect", effect => { if ( effect.parent instanceof Actor ) this.refreshActor(effect.parent); });
  }

  /** Redraw every token of an actor on the current scene. */
  static refreshActor(actor) {
    if ( !canvas.ready || !tracksStress(actor) ) return;
    for ( const token of actor.getActiveTokens(false, false) ) this.refresh(token, { force: true });
  }

  static tokensFor(actor) {
    if ( !canvas.ready ) return [];
    return actor.getActiveTokens(false, false);
  }

  /* -------------------------------------------- */

  static #attach(token) {
    const actor = token.document?.actor;
    if ( !tracksStress(actor) ) return;
    this.#detach(token);
    const root = new PIXI.Container();
    root.name = "sr-overlay";
    root.eventMode = "none";
    root.aura = root.addChild(new PIXI.Container());
    root.halo = root.aura.addChild(new PIXI.Graphics());
    root.spin = root.aura.addChild(new PIXI.Graphics());
    root.glow = root.aura.addChild(new PIXI.Graphics());
    root.bar = root.addChild(new PIXI.Graphics());
    root.bursts = root.addChild(new PIXI.Container());
    const Text = foundry.canvas.containers?.PreciseText ?? PIXI.Text;
    root.kicker = root.addChild(new Text("", CONFIG.canvasTextStyle.clone()));
    root.title = root.addChild(new Text("", CONFIG.canvasTextStyle.clone()));
    for ( const t of [root.kicker, root.title] ) t.anchor.set(0.5, 1);
    root.signature = null;
    token.srOverlay = root;
    token.addChildAt(root, 0);
    this.#overlays.add(token);
    this.refresh(token, { force: true });
  }

  static #detach(token) {
    const root = token.srOverlay;
    this.#overlays.delete(token);
    if ( root && !root.destroyed ) root.destroy({ children: true });
    token.srOverlay = null;
  }

  /* -------------------------------------------- */

  static refresh(token, { force=false }={}) {
    const root = token?.srOverlay;
    const actor = token?.document?.actor;
    if ( !root || root.destroyed || !tracksStress(actor) ) return;

    const data = getData(actor);
    const limit = getLimit(actor);
    const barMode = game.settings.get(MODULE_ID, "tokenBar");
    const showBar = (barMode === "always") || ((barMode === "hover") && (token.hover || token.controlled));
    const showAura = game.settings.get(MODULE_ID, "tokenAura") && !!data.state && !data.suppressed;
    const signature = [data.value, data.tempStress, limit, data.state, data.condition, data.suppressed, token.w, token.h, showBar, showAura,
      canvas.dimensions.uiScale].join("|");
    if ( !force && (signature === root.signature) ) return;
    root.signature = signature;

    const s = canvas.dimensions.uiScale ?? 1;
    const w = token.w;
    const h = token.h;
    const bh = 6 * s;
    const barY = -bh - (4 * s);

    // Stress bar
    root.bar.clear();
    root.bar.visible = showBar;
    if ( showBar ) {
      const pct = Math.clamp(data.value / (2 * limit), 0, 1);
      const color = data.value >= limit ? COLORS.bar.over : COLORS.bar.fill;
      root.bar.beginFill(COLORS.bar.bg, 0.6).lineStyle(s, 0x000000, 1).drawRoundedRect(0, 0, w, bh, 2 * s).endFill();
      if ( pct > 0 ) root.bar.beginFill(color, 1).lineStyle(s, 0x000000, 1).drawRoundedRect(0, 0, pct * w, bh, 2 * s).endFill();
      // Temporary HP protecting Stress: a light-blue shield segment after the fill.
      if ( data.tempStress > 0 ) {
        const start = pct * w;
        const tw = Math.min(w - start, (data.tempStress / (2 * limit)) * w);
        if ( tw > 0 ) root.bar.beginFill(COLORS.bar.temp, 0.9).lineStyle(s, 0x000000, 1).drawRoundedRect(start, 0, tw, bh, 2 * s).endFill();
      }
      // Notch at the Stress Limit (half way: Resolve), the right edge is Mortality.
      root.bar.lineStyle(Math.max(1, 1.5 * s), COLORS.bar.notch, 0.9).moveTo(w / 2, -s).lineTo(w / 2, bh + s);
      root.bar.position.set(0, barY);
    }

    // Aura and title
    const kind = data.state === "virtuous" ? "virtue" : "affliction";
    root.aura.visible = root.kicker.visible = root.title.visible = showAura;
    root.kind = showAura ? kind : null;
    root.glow.clear();
    root.spin.clear();
    root.halo.clear();
    if ( showAura ) {
      const r = Math.max(w, h) / 2;
      root.aura.position.set(w / 2, h / 2);
      root.radius = r;
      this.#drawAura(root, kind, r);

      const c = COLORS[kind];
      const size = Math.clamp(w * 0.28, 16, 80);
      const titleStyle = root.title.style;
      Object.assign(titleStyle, {
        fontFamily: ["Modesto Condensed", "Signika", "serif"],
        fontSize: size,
        fontWeight: "bold",
        fill: c.text,
        stroke: "#000000",
        strokeThickness: Math.max(3, size * 0.14),
        letterSpacing: size * 0.06,
        dropShadow: true,
        dropShadowColor: c.text,
        dropShadowBlur: size * 0.35,
        dropShadowDistance: 0,
        dropShadowAlpha: 0.8
      });
      root.title.text = loc(`Condition.${data.condition}.Name`).toLocaleUpperCase(game.i18n.lang);
      const kickerStyle = root.kicker.style;
      Object.assign(kickerStyle, {
        fontFamily: ["Signika", "sans-serif"],
        fontSize: Math.max(10, size * 0.42),
        fill: "#ffffff",
        stroke: "#000000",
        strokeThickness: 3,
        letterSpacing: size * 0.08,
        dropShadow: false
      });
      root.kicker.text = loc(kind === "virtue" ? "Token.Virtuous" : "Token.Afflicted").toLocaleUpperCase(game.i18n.lang);
      const top = showBar ? barY - (3 * s) : -(4 * s);
      root.title.position.set(w / 2, top);
      root.kicker.position.set(w / 2, top - (size * 0.95));
    }
  }

  static #drawAura(root, kind, r) {
    const c = COLORS[kind];
    const p = (ang, rad) => [Math.cos(ang) * rad, Math.sin(ang) * rad];

    // Soft halo: a wide ring, blurred
    const halo = root.halo;
    halo.lineStyle(r * 0.34, c.glow, 0.6).drawCircle(0, 0, r * 1.14);
    halo.lineStyle(r * 0.12, c.main, 0.8).drawCircle(0, 0, r * 1.06);
    const blur = Math.max(4, r * 0.14);
    if ( !halo.filters?.length ) halo.filters = [new PIXI.BlurFilter(blur, 4)];
    else halo.filters[0].blur = blur;

    // Crisp ring
    const g = root.glow;
    g.lineStyle(r * 0.045, c.main, 1).drawCircle(0, 0, r * 1.04);
    g.lineStyle(Math.max(1, r * 0.014), 0xffffff, 0.75).drawCircle(0, 0, r * 1.04);

    const sp = root.spin;
    if ( kind === "affliction" ) {
      // Thorns: jagged spikes of uneven length, with a second ring of short barbs
      const n = 22;
      for ( let i = 0; i < n; i++ ) {
        const a = (i / n) * Math.PI * 2;
        const len = r * (i % 2 ? 1.28 : 1.48) + (r * 0.05 * Math.sin(i * 7.3));
        const half = Math.PI / n * 0.6;
        sp.lineStyle(Math.max(1, r * 0.014), c.main, 1).beginFill(c.deep, 0.95)
          .drawPolygon([...p(a - half, r * 1.06), ...p(a + (half * 0.35), len), ...p(a + half, r * 1.06)]).endFill();
      }
      for ( let i = 0; i < n; i++ ) {
        const a = ((i + 0.5) / n) * Math.PI * 2;
        const half = Math.PI / n * 0.3;
        sp.lineStyle(0).beginFill(c.main, 0.9)
          .drawPolygon([...p(a - half, r * 1.07), ...p(a, r * 1.17), ...p(a + half, r * 1.07)]).endFill();
      }
    } else {
      // Sun rays, long and short
      const n = 20;
      for ( let i = 0; i < n; i++ ) {
        const a = (i / n) * Math.PI * 2;
        const len = r * (i % 2 ? 1.38 : 1.7);
        const half = Math.PI / n * (i % 2 ? 0.3 : 0.42);
        sp.lineStyle(0).beginFill(i % 2 ? c.main : c.glow, i % 2 ? 0.6 : 0.8)
          .drawPolygon([...p(a - half, r * 1.07), ...p(a, len), ...p(a + half, r * 1.07)]).endFill();
      }
    }
  }

  /* -------------------------------------------- */
  /*  Animation                                   */
  /* -------------------------------------------- */

  static #startTicker() {
    if ( this.#tickerBound ) canvas.app.ticker.remove(this.#tickerBound);
    this.#tickerBound = () => this.#tick();
    canvas.app.ticker.add(this.#tickerBound);
  }

  static #tick() {
    const t = performance.now() / 1000;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    for ( const token of this.#overlays ) {
      const root = token.srOverlay;
      if ( !root || root.destroyed || token.destroyed ) { this.#overlays.delete(token); continue; }
      if ( !root.kind || reduce ) continue;
      if ( root.kind === "affliction" ) {
        root.spin.rotation = -t * 0.35;
        const flicker = Math.random() < 0.03 ? 0.55 : 1;
        root.halo.alpha = (0.7 + (0.3 * Math.sin(t * 4.2))) * flicker;
        root.glow.alpha = flicker;
        root.aura.scale.set(1 + (0.025 * Math.sin(t * 4.2)));
        root.title.alpha = flicker < 1 ? 0.7 : 1;
      } else {
        root.spin.rotation = t * 0.22;
        root.spin.alpha = 0.75 + (0.25 * Math.sin(t * 2));
        root.halo.alpha = 0.8 + (0.2 * Math.sin(t * 2));
        root.glow.alpha = 1;
        root.aura.scale.set(1 + (0.02 * Math.sin(t * 2)));
        root.title.alpha = 1;
      }
    }
    for ( const b of this.#bursts ) {
      if ( b.destroyed ) { this.#bursts.delete(b); continue; }
      const p = (performance.now() - b.start) / b.duration;
      if ( p >= 1 ) { b.destroy({ children: true }); this.#bursts.delete(b); continue; }
      b.update(p);
    }
  }

  /**
   * A burst of expanding rings and sparks on a token.
   * @param {Token} token
   * @param {"affliction"|"virtue"|"mortality"} kind
   */
  static burst(token, kind) {
    const root = token?.srOverlay;
    if ( !root || root.destroyed ) return;
    const c = kind === "virtue" ? COLORS.virtue : COLORS.affliction;
    const r = Math.max(token.w, token.h) / 2;
    const b = new PIXI.Container();
    b.position.set(token.w / 2, token.h / 2);
    const rings = [0, 1, 2].map(() => b.addChild(new PIXI.Graphics()));
    const sparks = Array.from({ length: 36 }, () => {
      const g = b.addChild(new PIXI.Graphics());
      g.beginFill(Math.random() < 0.5 ? c.main : c.glow, 1).drawCircle(0, 0, r * (0.025 + (Math.random() * 0.03))).endFill();
      g.angle0 = Math.random() * Math.PI * 2;
      g.speed = r * (1.6 + (Math.random() * 2.2));
      return g;
    });
    b.start = performance.now();
    b.duration = 1600;
    b.update = p => {
      rings.forEach((g, i) => {
        const q = Math.clamp((p * 1.4) - (i * 0.18), 0, 1);
        g.clear();
        if ( q <= 0 || q >= 1 ) return;
        g.lineStyle(r * 0.12 * (1 - q), i === 1 ? 0xffffff : c.main, 1 - q).drawCircle(0, 0, r * (1 + (q * 2.6)));
      });
      const ease = 1 - Math.pow(1 - p, 3);
      for ( const g of sparks ) {
        g.position.set(Math.cos(g.angle0) * (r + (g.speed * ease)), Math.sin(g.angle0) * (r + (g.speed * ease)));
        g.alpha = 1 - p;
      }
    };
    root.bursts.addChild(b);
    this.#bursts.add(b);
  }
}
