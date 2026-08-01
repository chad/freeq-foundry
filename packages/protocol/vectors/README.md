# Conformance vectors

`index.json` is the operational definition of Freeq Foundry protocol conformance.
Nothing about TypeScript is normative. If your implementation passes these
vectors, it interoperates.

You need no dependency on this package. Read the JSON.

```bash
curl -O https://raw.githubusercontent.com/chad/freeq-foundry/main/packages/protocol/vectors/index.json
```

## Format

```jsonc
{
  "formatVersion": 1,
  "protocol": "freeq-foundry/v1",
  "canonicalization": { "valid": [], "invalidJson": [], "invalidConstructed": [] },
  "digests": [],
  "didKey": { "valid": [], "invalid": [] },
  "signing": { "contexts": {}, "vectors": [], "crossContextMustFail": true },
  "events": { "genesisHash", "recorderDid", "runId", "events": [], "ndjson" },
  "chain": []
}
```

Every `errorCode` is a stable string. Assert on the code, not on a message:
messages are for humans and will change. A test that only checks "it was
rejected" does not prove it was rejected for the right reason.

## 1. Canonicalization

### `canonicalization.valid`

```jsonc
{
  "name": "key-ordering-mixed",
  "note": "\\n=10, '1'=49, 'a'=97, '€'=8364.",
  "inputJson": "{\"\\u20ac\":1,\"\\n\":2,\"a\":3,\"1\":4}",
  "canonical": "{\"\\n\":2,\"1\":4,\"a\":3,\"€\":1}",
  "canonicalHex": "7b225c6e223a322c2231...",
  "digest": "sha256:7f24b2d10817..."
}
```

Parse `inputJson`, canonicalize the result, and compare against all three of
`canonical` (UTF-8 text), `canonicalHex` (hex of the UTF-8 bytes), and `digest`.

`canonicalHex` exists because comparing strings across languages hides encoding
bugs. Compare the bytes.

Canonical form is [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS) plus
five restrictions. Most languages have a JCS library; **it will not be sufficient
on its own**, because of restrictions 3–5 below.

### `canonicalization.invalidJson`

Parse `inputJson`, attempt to canonicalize, expect rejection with `errorCode`.

| Code | Restriction |
| --- | --- |
| `NON_INTEGER_NUMBER` | Integers only. Encode non-integers as strings with a documented unit. |
| `UNSAFE_INTEGER` | Within ±(2⁵³−1). |
| `UNEXPECTED_NULL` | Omit a field rather than sending `null`. |
| `DUPLICATE_KEY` | Reject at parse time — do not silently keep the last. |

`DUPLICATE_KEY` catches most implementers out, because the standard JSON parser in
nearly every language silently collapses duplicates. `{"a":1,"a":2}` becomes
`{"a":2}`, which re-canonicalizes to different bytes than the sender produced and
then fails signature verification with a misleading error. Detect it at parse
time.

The `nfc-colliding-keys` vector also produces `DUPLICATE_KEY`: two distinct keys
that become identical after NFC normalization.

### `canonicalization.invalidConstructed`

Some rejections need a value JSON text cannot express, so these vectors carry a
`directive` naming the condition instead of an input:

| Directive | Construct | Expected |
| --- | --- | --- |
| `nan` | A number field holding NaN | `NON_FINITE_NUMBER` |
| `positive-infinity` | A number field holding +∞ | `NON_FINITE_NUMBER` |
| `undefined-array-element` | An array with a language-level absent element | `UNSUPPORTED_TYPE` |
| `lone-high-surrogate` | A string containing U+D800 alone | `LONE_SURROGATE` |
| `lone-low-surrogate` | A string containing U+DC00 alone | `LONE_SURROGATE` |

Map each directive to whatever your language calls it. Describing these in prose
would guarantee divergence.

### The five restrictions, stated plainly

1. **Integers only.** JCS number serialization is well defined for doubles but not
   intuitive across languages. Forbidding non-integers removes a whole defect class.
2. **Absent, not null.** An optional field with no value is omitted. Emitting
   `null` changes the bytes and therefore the hash.
3. **NFC normalization.** Normalize every string *and every key* to NFC before
   canonicalizing. Not part of JCS. Without it, visually identical DIDs hash
   differently. If normalizing two keys makes them equal, that is `DUPLICATE_KEY`.
4. **No lone surrogates.** Not encodable as UTF-8, and language behaviour varies.
5. **Depth ≤ 64, canonical size ≤ 1 MiB.** Larger content is an artifact
   reference. Measure size on **encoded bytes**, not code units.

## 2. Digests

SHA-256 of the UTF-8 bytes, lowercase hex, prefixed `sha256:`.

```
sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

The prefix is deliberate: it makes a future algorithm migration a validation
change rather than a format change.

## 3. `did:key`

```jsonc
{ "name": "seed-all-0x00", "seedHex": "0000...", "publicKeyHex": "3b6a27bc...", "did": "did:key:z6Mki..." }
```

Derive an Ed25519 keypair from the 32-byte seed, then check the public key and the
DID. Ed25519 only, multicodec `0xed01`, base58btc with the `z` multibase prefix.

`seed-all-0x00` is the [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032) test
vector — its public key is `3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29`.
Start there. If it fails, your Ed25519 seed handling is wrong and nothing else
will work.

`didKey.invalid` covers non-DIDs, unsupported methods, wrong multibase prefixes,
and base58 alphabet violations (`0`, `O`, `I`, `l` are excluded because they are
confusable).

## 4. Signing

Ed25519, deterministic, unpadded base64url. **Every payload type has its own
domain-separation context**, and the context is prefixed to the canonical bytes
before signing:

```
signingInput = contextString + JCS(payload)
signature    = base64url(Ed25519-sign(privateKey, UTF8(signingInput)))
```

```jsonc
{
  "name": "event-simple",
  "kind": "EVENT",
  "context": "FREEQ-FOUNDRY-V1-EVENT\n",
  "seedHex": "0101...",
  "did": "did:key:z6Mk...",
  "payloadJson": "{\"a\":1,\"b\":\"two\"}",
  "signingInputHex": "465245...",
  "signature": "kQ8f..."
}
```

Check `signingInputHex` **first**. When a signature disagrees across
implementations, the signing input is almost always the cause, and comparing it
directly tells you whether the problem is your canonicalizer or your crypto.

Note the trailing `\n` in every context string.

### `crossContextMustFail`

When true — it is — every signature in `signing.vectors` **MUST** fail
verification under every context other than its own. This is not optional
hardening. Without it, a signature harvested from a credential can be replayed as
an event.

Structure your API so this is hard to get wrong: `verify()` should take the
payload type and derive the context internally. Do not expose a function that
verifies caller-supplied bytes.

## 5. Events

`events.events` is a complete, valid run. `events.ndjson` is the same run in
export form (one JSON object per line, canonical order).

Every event carries **two** signatures:

| Field | Signed by | Over |
| --- | --- | --- |
| `signature` | the participant | content only, excluding position |
| `recorderSignature` | the recorder | the positioned event, including `signature` |

```
contentView  = event minus { logicalTime, previousEventHash, eventHash,
                             signature, recorderSignature }
signature    = Ed25519_participant("FREEQ-FOUNDRY-V1-EVENT\n"  + JCS(contentView))

hashingInput = event minus { eventHash, recorderSignature }
eventHash    = "sha256:" + hex(SHA-256(hashingInput))

recordView   = event minus { recorderSignature }
recorderSignature
             = Ed25519_recorder("FREEQ-FOUNDRY-V1-RECORD\n" + JCS(recordView))
```

The participant signature covers content only, so it is stable wherever the event
lands — which is why a participant can sign before knowing its position.

**The recorder DID is not in the event.** It comes from the run manifest, and here
from `events.recorderDid`. An event that named its own recorder would let a forger
name themselves.

The first event's `previousEventHash` is `events.genesisHash`: `sha256:` followed
by 64 zeros.

## 6. Chain

Mutations are expressed as [RFC 6902](https://www.rfc-editor.org/rfc/rfc6902)
patches over the `events` array, so you can apply them mechanically:

```jsonc
{
  "name": "chain-link-rewritten",
  "patches": [{ "op": "replace", "path": "/2/previousEventHash", "value": "sha256:000..." }],
  "expectValid": false,
  "expectCodes": ["BROKEN_CHAIN"],
  "expectFirstBadIndex": 2
}
```

Only `replace`, `remove`, and `move` appear. Apply the patches, verify the chain,
and check `expectValid`, `expectFirstBadIndex`, and that every code in
`expectCodes` is present. Additional violations are permitted; missing ones are not.

### Two tamper shapes

Worth understanding rather than just passing:

- **`payload-altered`** — content changed, declared hash untouched. Only that
  event is implicated. Later events still link correctly to what it *claimed* to
  be, so flagging them would be a false positive, and in an audit log a false
  positive costs as much investigation as a true one.
- **`declared-hash-altered`** and friends — the event is made self-consistent, and
  every later back-link breaks instead.

To get both right, advance your chain cursor using the **declared** `eventHash`,
not the recomputed one.

## Version compatibility

`formatVersion` is bumped when the vector file's *structure* changes. The
`protocol` field identifies the wire protocol.

Changes to canonical form, hashing, or any signing context are **breaking**: they
invalidate every signature ever issued. They arrive with a new protocol version,
never as a patch.

## Regenerating

```bash
pnpm --filter @freeq-foundry/protocol run vectors
```

A drift-guard test asserts the committed file equals a fresh build, so vectors
cannot silently diverge from the implementation. If that test fails, understand
why before regenerating — a deliberate protocol change needs a version bump, not
a regenerate.

## Reporting a disagreement

If your implementation disagrees with a vector, one of us is wrong and it is worth
knowing which. Open an issue with your canonical bytes, the vector name, and your
language. Include `signingInputHex` if it is a signature vector.
