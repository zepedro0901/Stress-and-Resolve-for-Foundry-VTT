# Stress and Resolve

Stress, Resolve checks, afflictions and virtues for the D&D 5e system on Foundry VTT, based on
**Darkest Dungeons and Dragons v1.4 by zecron8**, used with permission. Built for the 2024 rules.

- Foundry VTT v14, D&D 5e system 6.x, default character sheet
- English and Português (Portugal)

## Install

In Foundry, go to *Add-on Modules → Install Module* and paste this manifest URL:

```
https://github.com/zepedro0901/Stress-and-Resolve-for-Foundry-VTT/releases/latest/download/module.json
```

Then enable **Stress and Resolve** in your world's *Manage Modules*. Foundry offers updates when a new release is out.

Or download `stress-and-resolve.zip` from the [latest release](https://github.com/zepedro0901/Stress-and-Resolve-for-Foundry-VTT/releases/latest)
and unzip it into `Data/modules/`, so you get `Data/modules/stress-and-resolve/module.json`.

## Development

- `npm install`, then `npm test` runs the rules tests (Node 22, no Foundry needed).
- `npm run build:packs` compiles the compendium from `packs-src/` into `packs/` (needed when running from a clone).
- To release: publish a GitHub release with a tag like `v0.9.0`. The *Release* workflow sets that version and the
  download link in `module.json`, builds the compendium, and attaches `module.json` and `stress-and-resolve.zip`.

## New in 0.8.0

Four more of the PDF's Stress rules, each with its own setting:

| Rule | What happens |
| --- | --- |
| Targeted by a feared creature | When a creature a character is Frightened of uses anything that targets them (attack, spell, ability), they gain its CR. "Feared" = the source of a Frightened effect on them, including Fearful's. |
| Lingering conditions | At the end of each of their turns in combat, a character gains the CR of whoever inflicted each Blinded, Deafened, Poisoned, Restrained or Paralyzed condition. Unknown source (added from the HUD): the GM is asked the CR once per effect. Tick *Natively blind/deaf* in the Stress cog to skip Blinded/Deafened. Needs *Automate afflictions and virtues* on (it runs with the turn effects). |
| An ally dies | When a character, or an NPC whose token is Friendly, dies (the Dead condition, or a third failed death save), every other character on that scene gains 1d8 per Hit Die it had (level, or the dice in the NPC's HP formula). The GM gets a whispered button per absent party member, to click when they learn of it: half. Macro: `api.allyDied(actor)`. |
| Killing blow on a feared creature | When a character's damage drops a creature they're Frightened of to 0 HP, they remove twice its CR. |

## New in 0.7.1

**Fix: "no allies nearby".** Nearby allies were looked up on the combat's scene, which is the scene that was
*active* when the encounter was created (or none, for an unlinked encounter). If you ran the fight on a
different scene, nobody was ever nearby. The module now finds the character's token on the combat's scene,
the scene you're viewing, or the combatants' scenes. This also fixes Irrational, Powerful, Courageous and Fearful.
Allies are now any player characters within range unless one token is Friendly and the other Hostile, so a
Neutral token no longer hides an ally. With the *Debug* setting on, the console lists each ally's distance.

## New in 0.7.0

**Critical hits** (setting: *Critical hits change Stress*). When damage from a critical hit is applied:
the character hit gains Stress equal to half the damage taken, and a character who scored it removes
Stress equal to half the damage dealt (rounded down).

**Every Stress gain names its source.** Each gain posts a card with a *Source:* line (the creature,
spell, condition or person responsible; "set by hand by …" for manual changes). With *Stress chat messages*
off, gains are still whispered to the GM; losses stay silent as before.

## New in 0.6.2

The 0 HP Stress now applies **once per combat**: a character dropped, healed and dropped again in the same
fight only gains it the first time. Outside combat it applies every time.

## New in 0.6.1

**Dropping to 0 HP adds Stress** equal to the character's level (PDF, "Gaining Stress"). It doesn't apply
when a heart attack drops them, or when they're already at 0 HP. Setting: *Dropping to 0 HP adds Stress*.

## New in 0.6.0: the PDF's class, feat and spell changes

All of the PDF's "Other Changes" are now in, adjusted for the 2024 rules as agreed in the plan.
Setting: *Class and PDF riders*. Features are recognised by their dnd5e identifier (SRD 2024 class items work).

| Class or spell | What happens |
| --- | --- |
| Barbarian: Rage | While raging, Stress gained −CON modifier (min. 1). When Rage ends, heal Stress equal to Barbarian level. |
| Bard: Bardic Inspiration | Using it on an ally posts a button: the ally can spend the die on Stress instead. |
| Bard: Song of Rest (2024 replacement) | In allies' short rest window, tick *Song of Rest*: each Stress Die adds the Bardic Inspiration die. The Bard spends one Bardic Inspiration, once per rest. |
| Cleric: Divine Intervention | Every use (2024 has no roll): Stress to 0, then a Resolve check that keeps only Virtues. |
| Cleric: Turn Undead | Posts a button: say how many undead failed, heal 1d6 Stress each. |
| Fighter: Second Wind | Asks HP or Stress; Stress heals 1d10 + Fighter level and spends the use. |
| Monk: Patient Defense | The Focus Point version heals the Martial Arts die. |
| Paladin: Lay on Hands | Asks HP or Stress; Stress spends pool points 1:1 on the targeted character (or yourself). |
| Paladin: Aura of Courage | You and allies within 10 ft (30 ft with Aura Expansion) reduce Stress gained by your CHA modifier (min. 1). |
| Ranger: Favored Enemy (2024) | Stress caused by the creature under your Hunter's Mark is halved (fear, Fearful and Psychic damage know their source). |
| Rogue: Sneak Attack | After an attack with Advantage that hit, Sneak Attack heals Proficiency Bonus Stress. |
| Sorcerer: Calming Spell | New Metamagic (compendium). Target the allies and use it: spends 2 Sorcery Points, each target heals CHA modifier Stress. |
| Warlock: Pact Magic | Casting with a Pact Magic slot heals Stress equal to the slot level (Mystic Arcanum doesn't). |
| Warlock: Dark Commune | New invocation (compendium). The long rest window gets a *Dark Commune* box: you and the party gain CHA modifier Stress after the rest. |
| Wizard: Arcane Recovery | Asks how many slot levels you recovered, heals 1d4 Stress per level. |
| Artificer: Craftsman's Calm | Stress gained −number of attuned magic items (min. 1). |
| Blood Hunter: Crimson Rite | Heals twice the Hemocraft die. |
| Calm Emotions | The caster can suppress an afflicted target's affliction while the spell lasts (its effects, aura and icon switch off; it returns when concentration ends or after 1 minute). |
| Soothe | New 1st-level spell (compendium): heals 1d4 + spellcasting modifier Stress, +1d4 per slot level above 1st. Add it to your Druids and Rangers by hand. |

Already in from earlier versions: Contact Other Plane, Heroism and Inspiring Leader (temporary HP), Tough.
Rogue Blindsense is dropped (gone in 2024) and Skulker's darkness rule isn't tracked, as decided.

The new compendium **Stress and Resolve: Spells and Features** holds Soothe, Calming Spell and Dark Commune.

## New in 0.5.0

**Psychic damage adds Stress** equal to the Psychic damage taken (after resistance and immunity), when the
damage is applied. Setting: *Psychic damage adds Stress*.

**Temporary HP protect Hit Points or Stress.** Whenever a character gains temporary HP (any spell, feat,
damage card or the sheet), their player is asked what it protects. There is only ever one layer: choosing
one replaces the other, or the player keeps the current layer. If the GM applied it and the player is
online, the question goes to the player. The Stress layer soaks Stress before it's gained, shows as a
light-blue `+N` on the sheet, the party window and the token's Stress bar, and ends on a long rest.
The GM can correct it in the cog dialog. Setting: *Temporary HP can protect Stress*.

**Spell and feat riders** (setting: *Spell and feat riders*). Spells and feats are recognised by their
dnd5e identifier or name, so SRD, Player's Handbook and home-made items all work.

| Spell or feat | What happens |
| --- | --- |
| Contact Other Plane | On the caster's failed save: Stress rises to the Limit and a random affliction (signature one with Variant Resolve). Its Psychic damage adds no extra Stress. |
| Leomund's Tiny Hut, Mordenkainen's Magnificent Mansion, Galder's Tower, Mighty Fortress, Temple of the Gods | While it stands on the scene, the long rest dialog ticks *Rested somewhere safe* for you. |
| Heroes' Feast | Everyone who eats (targets, or the whole party) drops to 0 Stress. |
| Power Word Heal | Stress 0 and the affliction ends. |
| Prayer of Healing | Targets recover Stress equal to the caster's spellcasting modifier. |
| Greater Restoration | Asks whether to end an afflicted target's affliction instead. |
| Beacon of Hope | A Resolve check made under it is rolled twice; the better result is kept (a virtue beats an affliction). |
| Death Ward | Stops the heart attack once: 1 HP instead of 0, Stress falls to the Limit (a virtuous character goes to 0 and loses the virtue), the ward ends. |
| Catnap | Chat buttons let the sleepers spend Stress Dice. |
| Befuddlement, Dream, Fractured Awareness, Reality Break, Vision of Elapsing Eons | Cast on the party: the GM gets a whispered reminder of the suggested Stress rule (not automated). |
| Musician | As a rest ends, pick up to Proficiency Bonus allies: each recovers 1d4 Stress. |
| Chef | In the short rest dialog, allies who ate the meal add +1d8 to each Stress Die. |
| Healer | Using a Healer's Kit posts buttons so the patient can spend a Stress Die (rolled + the healer's Proficiency). |
| Boon of Recovery, Boon of Misty Escape | Offered when a heart attack is coming: 1 HP (Recovery: plus half the HP maximum) instead; uses are spent. |
| Boon of Bountiful Health | Stress Dice roll their maximum. |
| Aberrant Anatomy, Echoing Soul, Gathered Whispers, Living Shadow, Symbiotic Being, Watchers | A natural 1 on a D20 Test (not a death save) rolls the gift's save (DC 13 + Proficiency). On a fail, the drawback is posted and the character gains Proficiency Bonus Stress. Watchers: failing twice in one fight makes the character Paranoid. Second Skin stays with the table. |

Not automated by choice: Heroic Inspiration, revival from death (Stress is unchanged), darkness Stress
(so Blind Fighting and Fighting Initiate have nothing to hook into).

## New in 0.4.2

Turn reminders now cover every affliction and virtue: besides the rules the table applies, they list what
the module is doing automatically for that condition, so players know what to expect this turn.

## New in 0.4.1

**Turn reminders:** when an afflicted or virtuous character starts their turn in combat, the GM and that
character's players get a private chat message listing the rules Foundry can't apply for them (the
"Left to the table" column below): Paranoid, Selfish, Masochistic, Rapturous and Courageous, Irrational
losing the turn on a 6, and Refracted's affliction of the turn. Setting: *Turn reminders*.

## New in 0.4.0

**Virtuous characters also have the heart attack** at double the Stress Limit (0 HP, two failed death
saves); their Stress drops to 0 and the virtue ends.

**Fear:** gaining the Frightened condition adds Stress equal to the CR of the creature that caused it.
If the source can't be found (e.g. Frightened added from the token HUD), the GM picks the creature or types a CR.

**Afflictions and virtues now do what the rules say** (setting: *Automate afflictions and virtues*).
Turn effects run on the GM's client when the combat turn changes. "Nearby" = 30 ft (setting).

| Condition | Automated | Left to the table |
| --- | --- | --- |
| Every affliction | 1d4 Stress to nearby allies at the end of the turn (not Vigorous allies) | |
| Paranoid | Healing or buffs from an ally need a DC 15 CHA save in combat, refused outside it; a fail cancels the spell or item before anything is spent | Food and items handed over |
| Selfish | Healing or buffs on an ally need a DC 15 CHA save; a fail cancels before anything is spent | Sharing food and gear |
| Irrational | d6 each turn: 1–3 normal; 4–5 1d6 Stress to self and nearby allies; 6 takes 1d8 of their weapon's damage type | Skipping the rest of the turn |
| Fearful | Frightened of a random enemy each turn (until their next turn), Stress = CR, double if the same enemy again | |
| Hopeless | No advantage on any roll in combat; speed −10 ft; +1d4 to every Stress gain | |
| Abusive | An ally who misses a targeted attack takes 1d6 Stress; on a 6, disadvantage on their next attack or save | "Within eyesight" is treated as the same scene |
| Masochistic | Refuses an ally's healing (DC 15 CHA in combat, refused outside it); disadvantage on death saves | Can't Disengage; opportunity attacks against them have advantage |
| Rapturous | Advantage on attacks and initiative; attacks against them have advantage; disadvantage on DEX saves; damage taken −Proficiency; one damage die reroll per round | No Disengage, Dodge or Help |
| Refracted | Rolls on the Resolve table at the start of each turn; an affliction result applies until their next turn | |
| Powerful | One damage die reroll per turn, and nearby allies get one for their next turn; d4 = 4: next attack or spell deals maximum damage | |
| Courageous | Immune to Frightened (so no fear Stress); d4 = 4: self and nearby allies heal ½ level + Proficiency Stress | Allies' advantage on saves against fear |
| Stalwart | Immune to Charmed; Stress gained −Proficiency (minimum 1); d4 = 4: heals ½ level + Proficiency Stress | |
| Vigorous | 1d12 temporary HP each turn; advantage on all saves; no Stress from afflicted allies; d4 = 4: damage to self and allies −Proficiency until their next turn | |
| Focused | Crits one lower (19–20, or 18–20 if already expanded); advantage on DEX saves; spell DC +1; d4 = 4: allies crit on 19 until their next turn | |

Rerolls appear as a **Reroll lowest damage die** button on that character's damage roll in chat.

## New in 0.3.0

- **Fix: Mortality.** The heart attack (0 HP, two failed death saves) now always happens at double the
  Stress Limit. Chat or token-icon errors can no longer stop the rules, and a leftover "heart attack
  pending" marker no longer blocks the next one. The GM also has a *Face Mortality* button in the cog dialog.
- **Token Stress bar** above every character token. It fills to double the Limit; the white notch in the
  middle is the Limit. Setting: always / on hover / never.
- **Affliction and virtue aura** on tokens: a pulsing red aura with rotating thorns, or a golden aura with
  sun rays, plus the condition's name in large letters above the token.
- **Resolve reveal** on every screen when a character becomes afflicted or virtuous, or has a heart attack:
  the camera moves to the token, the screen darkens, the title slams in with a burst and a shake, and a
  sound plays. It lasts 4 seconds by default and works off-turn. Players can turn the animation, camera
  move or sound off for their own screen in the module settings.
- Debug logging setting: writes each Stress rules step to the browser console (F12).

Try the reveal from a macro: `game.modules.get("stress-and-resolve").api.previewReveal(actor, "virtue", "courageous")`.

## What works (0.2.0)

- **Stress meter** under Hit Dice on the character sheet. Click it to edit: a number sets Stress,
  `+3` or `-2` changes it. The cog opens per-character settings.
- **Stress Limit** from the class Stress Die (d6→d12, d8→d10, d10→d8, d12→d6) + WIS, per the rules.
  On level up you choose to roll or take half +1. Characters that already have levels get half +1 for
  those levels; edit them in the cog dialog if you rolled.
- **Resolve check** when Stress reaches the Limit: d100 on the Resolve table, posted to chat, and the
  affliction or virtue appears as a token status. A virtue sets Stress to half the Limit.
- **Mortality** at double the Limit: afflicted characters suffer a heart attack (0 HP, two failed death
  saves); stabilising or healing drops Stress to the Limit. Virtuous characters drop to 0 Stress and lose
  the virtue.
- **Short rest:** a *Stress Dice* section in the short rest dialog spends a hit die to heal the Stress
  Die + WIS.
- **Long rest:** any long rest ends a virtue. Tick *Rested somewhere safe* to clear Stress and afflictions.
  The GM gets a reminder about Indefinite Madness after three days afflicted.
- **Variant Resolve** (world setting) with signature affliction and virtue per character, including Rapturous.
- **Tough** (2024) can add 2 per level to the Stress Limit instead of HP (cog dialog).
- **Party Stress** window (Actors sidebar button) so everyone sees the party's Stress.
- Stress changes by players on characters they don't own are applied by the GM's client.


## Macros

```js
const sr = game.modules.get("stress-and-resolve").api;
const actor = canvas.tokens.controlled[0]?.actor;
await sr.addStress(actor, 4, { reason: "A hideous sight" }); // gain
await sr.addStress(actor, -2);                               // recover
sr.getStress(actor); sr.getLimit(actor);
await sr.resolveCheck(actor, { virtueOnly: true });          // Divine Intervention
sr.openParty();
```

## Credits

- Rules: *Darkest Dungeons and Dragons* v1.4 by zecron8, used with permission.
- Icons: Foundry VTT core icons. No Red Hook Studios art is included.
- Sounds: made for this module.
