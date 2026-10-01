/**
 * Pure rules maths, free of Foundry globals so it can be unit tested in Node.
 */

/**
 * Stress Die faces from a class hit die: d6→d12, d8→d10, d10→d8, d12→d6.
 * @param {number|string} hitDie  Hit die faces, or a denomination like "d8".
 * @returns {number}
 */
export function stressDieFaces(hitDie) {
  const faces = typeof hitDie === "string" ? Number(hitDie.replace(/^d/, "")) : Number(hitDie);
  if ( !Number.isFinite(faces) || faces <= 0 ) return 8;
  return Math.max(2, 18 - faces);
}

/** "Half +1" fixed Stress Limit gain for a Stress Die. */
export function fixedGain(stressFaces) {
  return Math.floor(stressFaces / 2) + 1;
}

/**
 * Stress Limit.
 * Level 1: max Stress Die + WIS. Each later level: the gain (rolled or half+1) + WIS.
 * @param {object} data
 * @param {number} data.level            Total character level.
 * @param {number} data.firstFaces       Stress Die faces of the first class.
 * @param {number} data.wisMod           Wisdom modifier.
 * @param {number[]} [data.gains]        Stored gains for levels 2..level (index 0 = level 2).
 * @param {number} [data.defaultFaces]   Stress Die used to fill missing gains with half+1.
 * @param {boolean} [data.tough]         Tough feat applied to the Stress Limit (+2 per level).
 * @returns {number}
 */
export function stressLimit({ level, firstFaces, wisMod, gains=[], defaultFaces, tough=false }) {
  level = Math.max(1, Math.floor(level || 1));
  let limit = firstFaces + wisMod;
  for ( let lvl = 2; lvl <= level; lvl++ ) {
    const stored = gains[lvl - 2];
    const gain = Number.isFinite(stored) ? stored : fixedGain(defaultFaces ?? firstFaces);
    limit += gain + wisMod;
  }
  if ( tough ) limit += 2 * level;
  return Math.max(1, limit);
}

/**
 * Normalise an incoming Stress change. Gains are rounded and never below 1.
 * @param {number} amount
 * @returns {number}
 */
export function normaliseStress(amount) {
  amount = Number(amount);
  if ( !Number.isFinite(amount) || amount === 0 ) return 0;
  if ( amount > 0 ) return Math.max(1, Math.round(amount));
  return Math.min(-1, Math.round(amount));
}

/** The Resolve table (d100). */
export const RESOLVE_TABLE = [
  { max: 10,  type: "affliction", key: "paranoid" },
  { max: 20,  type: "affliction", key: "selfish" },
  { max: 30,  type: "affliction", key: "irrational" },
  { max: 40,  type: "affliction", key: "fearful" },
  { max: 50,  type: "affliction", key: "hopeless" },
  { max: 60,  type: "affliction", key: "abusive" },
  { max: 70,  type: "affliction", key: "masochistic" },
  { max: 76,  type: "virtue", key: "powerful" },
  { max: 82,  type: "virtue", key: "courageous" },
  { max: 88,  type: "virtue", key: "stalwart" },
  { max: 94,  type: "virtue", key: "vigorous" },
  { max: 100, type: "virtue", key: "focused" }
];

/**
 * Look up a d100 result, applying Variant Resolve signatures when given.
 * @param {number} total
 * @param {object} [signature]  { affliction, virtue } keys; Rapturous replaces both.
 * @returns {{type: string, key: string}}
 */
export function resolveResult(total, signature=null) {
  const row = RESOLVE_TABLE.find(r => total <= r.max) ?? RESOLVE_TABLE.at(-1);
  const result = { type: row.type, key: row.key };
  if ( signature ) {
    if ( signature.affliction === "rapturous" || signature.virtue === "rapturous" ) {
      return { type: "affliction", key: "rapturous" };
    }
    if ( (result.type === "affliction") && signature.affliction ) result.key = signature.affliction;
    if ( (result.type === "virtue") && signature.virtue ) result.key = signature.virtue;
  }
  return result;
}

/**
 * What happens after Stress changes.
 * @param {object} data
 * @param {number} data.stress     Stress after the change.
 * @param {number} data.limit      Stress Limit.
 * @param {string|null} data.state "afflicted", "virtuous" or null.
 * @param {boolean} data.gained    Whether this change was a gain.
 * @param {boolean} [data.heartAttack] A heart attack is already pending.
 * @returns {"resolve"|"mortality"|"clearAffliction"|null}
 */
export function nextStep({ stress, limit, state, gained, heartAttack=false }) {
  if ( gained ) {
    if ( !state && (stress >= limit) ) return "resolve";
    if ( state && !heartAttack && (stress >= 2 * limit) ) return "mortality";
    return null;
  }
  if ( (stress <= 0) && (state === "afflicted") ) return "clearAffliction";
  return null;
}

/**
 * Distance in scene units between two token documents, centre to centre, using 5e's
 * 5-5-5 diagonal rule (distance = the larger of the horizontal and vertical offsets).
 * @param {{x:number, y:number, width:number, height:number}} a  Token (x, y in pixels; size in grid squares).
 * @param {{x:number, y:number, width:number, height:number}} b
 * @param {{size:number, distance:number}} grid                   Grid size in pixels and units per square.
 * @returns {number}
 */
export function tokenDistance(a, b, grid) {
  const centre = t => ({ x: t.x + ((t.width ?? 1) * grid.size / 2), y: t.y + ((t.height ?? 1) * grid.size / 2) });
  const ca = centre(a);
  const cb = centre(b);
  // Edge-to-edge for large creatures: subtract half of each token's extra size beyond one square.
  const extra = (((a.width ?? 1) - 1) + ((b.width ?? 1) - 1)) * grid.size / 2;
  const extraY = (((a.height ?? 1) - 1) + ((b.height ?? 1) - 1)) * grid.size / 2;
  const dx = Math.max(0, Math.abs(ca.x - cb.x) - extra);
  const dy = Math.max(0, Math.abs(ca.y - cb.y) - extraY);
  return Math.round(Math.max(dx, dy) / grid.size) * grid.distance;
}
