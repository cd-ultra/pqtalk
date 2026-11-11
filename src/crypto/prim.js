// Low-level primitives. Everything is synchronous (noble) so ordering is
// deterministic and the same code runs in the page, the E2EE worker and Node tests.
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { concatBytes, randomBytes, utf8ToBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export { sha256, sha512, hmac, concatBytes, randomBytes, utf8ToBytes, bytesToHex, hexToBytes };

export const VERSION = 'pqtalk-v1';
const td = new TextDecoder();
export const utf8 = (s) => utf8ToBytes(s);
export const fromUtf8 = (b) => td.decode(b);

/** HKDF-SHA256 */
export const kdf = (ikm, salt, info, len = 32) =>
  hkdf(sha256, ikm, salt ?? new Uint8Array(32), utf8(`${VERSION} ${info}`), len);

/** One step of a Signal-style symmetric KDF chain: returns [messageKey, nextChainKey]. */
export const chainStep = (ck) => [hmac(sha256, ck, Uint8Array.of(1)), hmac(sha256, ck, Uint8Array.of(2))];

export function wipe(...arrs) { for (const a of arrs) if (a) a.fill(0); }

export function ctEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// AES-256-GCM with random 96-bit nonce prepended. Used for control-plane messages only.
export function seal(key, pt, aad) {
  const iv = randomBytes(12);
  return concatBytes(iv, gcm(key, iv, aad).encrypt(pt));
}
export function open(key, data, aad) {
  if (data.length < 28) throw new Error('short ciphertext');
  return gcm(key, data.subarray(0, 12), aad).decrypt(data.subarray(12));
}

// base64url without padding
export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomId = (n = 8) => bytesToHex(randomBytes(n));
