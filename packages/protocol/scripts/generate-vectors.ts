/**
 * Regenerate `vectors/index.json`.
 *
 * Run with `pnpm run vectors`. The committed file is asserted against a fresh
 * build in `vectors.test.ts`, so a change to canonical form, hashing, or a
 * signing context fails CI until the vectors are regenerated deliberately —
 * which is the point. Those changes invalidate every signature ever issued and
 * must never happen by accident.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVectorSet } from "../src/vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "vectors", "index.json");

const set = buildVectorSet("@freeq-foundry/protocol");
writeFileSync(target, `${JSON.stringify(set, null, 2)}\n`, "utf8");

const counts = {
  canonicalValid: set.canonicalization.valid.length,
  canonicalInvalidJson: set.canonicalization.invalidJson.length,
  canonicalInvalidConstructed: set.canonicalization.invalidConstructed.length,
  digests: set.digests.length,
  didKeyValid: set.didKey.valid.length,
  didKeyInvalid: set.didKey.invalid.length,
  signing: set.signing.vectors.length,
  events: set.events.events.length,
  chain: set.chain.length,
};
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`wrote ${target}`);
console.log(`${total} vectors:`, counts);
