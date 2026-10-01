// Compile the compendium sources (packs-src/*) into Foundry's LevelDB packs (packs/*).
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { readdir, rm } from "node:fs/promises";

for ( const name of await readdir("packs-src") ) {
  await rm(`packs/${name}`, { recursive: true, force: true });
  await compilePack(`packs-src/${name}`, `packs/${name}`, { log: true });
}
