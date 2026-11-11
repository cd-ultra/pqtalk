// Long-term device identity (Ed25519) + Signal-style safety numbers.
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512, concatBytes, utf8, b64, unb64, bytesToHex } from './prim.js';

const KEY = 'pqtalk.identity.v1';

export function loadIdentity(storage = globalThis.localStorage) {
  let sk;
  try { const s = storage?.getItem(KEY); if (s) sk = unb64(s); } catch {}
  if (!sk || sk.length !== 32) {
    sk = ed25519.utils.randomSecretKey();
    try { storage?.setItem(KEY, b64(sk)); } catch {}
  }
  return makeIdentity(sk);
}

export function makeIdentity(sk) {
  const pk = ed25519.getPublicKey(sk);
  return {
    pk,
    pkHex: bytesToHex(pk),
    sign: (msg) => ed25519.sign(msg, sk),
  };
}

export const verify = (sig, msg, pk) => {
  try { return ed25519.verify(sig, msg, pk); } catch { return false; }
};

// Signal's numeric fingerprint: 5200 iterations of SHA-512, 30 digits per party.
function fingerprint(pk) {
  let h = concatBytes(Uint8Array.of(0, 0), pk, utf8('pqtalk'));
  for (let i = 0; i < 5200; i++) h = sha512(concatBytes(h, pk));
  let out = '';
  for (let i = 0; i < 30; i += 5) {
    const n = (h[i] * 2 ** 32 + ((h[i + 1] << 24) >>> 0) + (h[i + 2] << 16) + (h[i + 3] << 8) + h[i + 4]) % 100000;
    out += String(n).padStart(5, '0');
  }
  return out;
}
const fpCache = new Map();
const fpOf = (pk) => { const k = bytesToHex(pk); if (!fpCache.has(k)) fpCache.set(k, fingerprint(pk)); return fpCache.get(k); };

/** 60-digit safety number, identical on both devices. */
export function safetyNumber(pkA, pkB) {
  const [a, b] = [fpOf(pkA), fpOf(pkB)].sort();
  return (a + b).match(/.{5}/g).join(' ');
}
