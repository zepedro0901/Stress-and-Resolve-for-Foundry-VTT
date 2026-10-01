export const MODULE_ID = "stress-and-resolve";

/** Seconds in the three days an affliction may last before Indefinite Madness. */
export const MADNESS_DELAY = 3 * 24 * 60 * 60;

/**
 * Afflictions and virtues. `img` uses Foundry core icons so no third-party art is shipped.
 * Status ids are prefixed to avoid clashing with system or other module statuses.
 */
export const AFFLICTIONS = {
  paranoid:    { img: "icons/svg/eye.svg" },
  selfish:     { img: "icons/svg/cancel.svg" },
  irrational:  { img: "icons/svg/daze.svg" },
  fearful:     { img: "icons/svg/terror.svg" },
  hopeless:    { img: "icons/svg/downgrade.svg" },
  abusive:     { img: "icons/svg/sword.svg" },
  masochistic: { img: "icons/svg/blood.svg" },
  rapturous:   { img: "icons/svg/angel.svg" },
  refracted:   { img: "icons/svg/radiation.svg" }
};

export const VIRTUES = {
  powerful:   { img: "icons/svg/upgrade.svg" },
  courageous: { img: "icons/svg/holy-shield.svg" },
  stalwart:   { img: "icons/svg/shield.svg" },
  vigorous:   { img: "icons/svg/regen.svg" },
  focused:    { img: "icons/svg/target.svg" }
};

/** The status effect id used for a given affliction or virtue key. */
export const statusId = key => `sr-${key}`;
