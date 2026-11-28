/**
 * Prints a new random encryption key for NIKKI_ENCRYPTION_KEY. Run it on your own computer and paste the output
 * straight into Railway → your service → Variables. Never paste it into a chat, email or the repository.
 *
 *   npx tsx scripts/generate-key.ts
 */
import { generateKey } from "../server/security/vault.js";
console.log(generateKey());
