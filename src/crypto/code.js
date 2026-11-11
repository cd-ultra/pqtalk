// Room codes: 160 random bits, Crockford base32, shared out-of-band (Signal, iMessage...).
// Everything about the room is derived from the code; nothing is registered anywhere.
import { kdf, randomBytes, utf8, bytesToHex } from './prim.js';

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I L O U
export const CODE_CHARS = 32; // 32 * 5 = 160 bits (80-bit security even vs. Grover)

export function generateCode() {
  const bytes = randomBytes(20);
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return formatCode(out);
}

export function normalizeCode(input) {
  const s = String(input).toUpperCase().replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
  if (s.length !== CODE_CHARS || [...s].some((c) => !ALPHA.includes(c))) return null;
  return s;
}

export const formatCode = (s) => s.match(/.{1,4}/g).join('-');

/** Derive room id (public, used as relay topic), signaling key and PSK. */
export function deriveRoom(code) {
  const n = normalizeCode(code);
  if (!n) throw new Error('Invalid room code');
  const ikm = utf8(n);
  return {
    code: formatCode(n),
    roomId: bytesToHex(kdf(ikm, null, 'room-id', 16)),
    signalKey: kdf(ikm, null, 'signal-key', 32), // AES-256-GCM key for relay envelopes
    psk: kdf(ikm, null, 'psk', 32), // mixed into every pairwise handshake (symmetric => PQ-safe auth of membership)
  };
}
