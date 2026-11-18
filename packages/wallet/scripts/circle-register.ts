/**
 * One-time Circle setup: generate an entity secret, register it with Circle, and save it to
 * contracts/.env. Circle returns a recovery file, written OUTSIDE the repo (~/.circle/), which is
 * the only way back in if the entity secret is lost. Registration can't be repeated, so this
 * refuses to run if CIRCLE_ENTITY_SECRET is already set.
 *
 *   pnpm --filter @gta/wallet circle:register
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../contracts/.env");
process.loadEnvFile(envFile);

const apiKey = process.env.CIRCLE_API_KEY;
if (!apiKey) throw new Error(`CIRCLE_API_KEY is missing from ${envFile}`);
if (process.env.CIRCLE_ENTITY_SECRET) {
  console.log("CIRCLE_ENTITY_SECRET is already set; nothing to do.");
  process.exit(0);
}

const entitySecret = randomBytes(32).toString("hex");
const dir = path.join(homedir(), ".circle");
mkdirSync(dir, { recursive: true, mode: 0o700 });
// Without a path the SDK also drops a copy of the recovery file into the current directory.
await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: dir });
appendFileSync(envFile, `\n# Circle entity secret (registered ${new Date().toISOString()})\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`);

console.log(`Registered. Secret saved to ${envFile}; recovery file in ${dir}`);
