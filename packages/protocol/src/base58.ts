/**
 * base58btc, as used by `did:key`.
 *
 * Implemented here rather than taken as a dependency: ADR-0002 requires
 * `packages/protocol` to have zero runtime dependencies, because it is the most
 * security-critical package and its audit surface should be readable in one
 * sitting.
 */
import { ProtocolError, ProtocolErrorCode } from "./errors.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX: ReadonlyMap<string, number> = new Map(
  [...ALPHABET].map((char, i) => [char, i]),
);

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  // Leading zero bytes are not representable positionally; base58 encodes each
  // as a literal '1'.
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros++;
  }

  const digits: number[] = [];
  for (let i = leadingZeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      const value = (digits[j] as number) * 256 + carry;
      digits[j] = value % 58;
      carry = (value / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    out += ALPHABET[digits[i] as number];
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);

  let leadingOnes = 0;
  while (leadingOnes < text.length && text[leadingOnes] === "1") {
    leadingOnes++;
  }

  const bytes: number[] = [];
  for (let i = leadingOnes; i < text.length; i++) {
    const char = text[i] as string;
    const digit = INDEX.get(char);
    if (digit === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_BASE58,
        `character ${JSON.stringify(char)} is not in the base58btc alphabet`,
      );
    }
    let carry = digit;
    for (let j = 0; j < bytes.length; j++) {
      const value = (bytes[j] as number) * 58 + carry;
      bytes[j] = value & 0xff;
      carry = value >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(leadingOnes + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[leadingOnes + i] = bytes[bytes.length - 1 - i] as number;
  }
  return out;
}
