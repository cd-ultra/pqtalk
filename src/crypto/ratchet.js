// Double Ratchet (Signal spec) with a post-quantum braid: every DH ratchet turn also carries a
// fresh ML-KEM-768 public key and a ciphertext encapsulated to the peer's latest one, and the KEM
// secret is mixed into the root key together with the X25519 output. Each turn therefore heals
// from compromise even against a quantum attacker (the role Signal's SPQR plays in its triple ratchet).
//
// State is plain JSON (base64 strings) so it can be stored in IndexedDB. Every operation works on
// a copy and only returns new state on success, so a bad message can never corrupt a session.
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256, chainStep, concatBytes, utf8, fromUtf8, b64, unb64, wipe } from './prim.js';

const MAX_SKIP = 1000;
const MAX_STORED_SKIPS = 2000;

const kdfRK = (rk, ikm) => {
  const out = hkdf(sha256, ikm, rk, utf8('pqtalk-v2 ratchet root'), 64);
  return [out.slice(0, 32), out.slice(32)];
};
const msgKeys = (mk) => {
  const out = hkdf(sha256, mk, new Uint8Array(32), utf8('pqtalk-v2 message keys'), 44);
  return { key: out.slice(0, 32), iv: out.slice(32) };
};
const dhPair = () => { const sk = x25519.utils.randomSecretKey(); return { sk: b64(sk), pk: b64(x25519.getPublicKey(sk)) }; };
const kemPair = () => { const k = ml_kem768.keygen(); return { sk: b64(k.secretKey), pk: b64(k.publicKey) }; };
const dh = (pair, pub) => x25519.getSharedSecret(unb64(pair.sk), unb64(pub));

/** Initiator (after PQXDH). theirSpk / theirPq are the responder's signed prekeys. */
export function initAlice(sk, ad, theirSpk, theirPq) {
  const DHs = dhPair(), KEMs = kemPair();
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(theirPq);
  const [RK, CKs] = kdfRK(sk, concatBytes(dh(DHs, b64(theirSpk)), sharedSecret));
  return {
    RK: b64(RK), CKs: b64(CKs), CKr: null, DHs, DHr: b64(theirSpk), KEMs, KEMr: b64(theirPq), kct: b64(cipherText),
    Ns: 0, Nr: 0, PN: 0, skipped: {}, AD: b64(ad),
  };
}

/** Responder: starts with its signed prekeys as the current ratchet keys. */
export function initBob(sk, ad, spk, pqspk) {
  return {
    RK: b64(sk), CKs: null, CKr: null, DHs: { sk: spk.sk, pk: spk.pub }, DHr: null,
    KEMs: { sk: pqspk.sk, pk: pqspk.pub }, KEMr: null, kct: null, Ns: 0, Nr: 0, PN: 0, skipped: {}, AD: b64(ad),
  };
}

const headerBytes = (h) => utf8(JSON.stringify([h.dh, h.kpk, h.kct, h.pn, h.n]));

export function encrypt(state, plaintext) {
  const s = structuredClone(state);
  if (!s.CKs) throw new Error('session not ready to send');
  const [mk, next] = chainStep(unb64(s.CKs));
  s.CKs = b64(next);
  const h = { dh: s.DHs.pk, kpk: s.KEMs.pk, kct: s.kct, pn: s.PN, n: s.Ns };
  s.Ns++;
  const { key, iv } = msgKeys(mk);
  const c = gcm(key, iv, concatBytes(unb64(s.AD), headerBytes(h))).encrypt(utf8(plaintext));
  wipe(mk, key);
  return { state: s, msg: { h, c: b64(c) } };
}

function skipTo(s, until) {
  if (!s.CKr) return;
  if (until - s.Nr > MAX_SKIP) throw new Error('too many skipped messages');
  let ck = unb64(s.CKr);
  while (s.Nr < until) {
    const [mk, next] = chainStep(ck);
    s.skipped[`${s.DHr}:${s.Nr}`] = b64(mk);
    ck = next; s.Nr++;
  }
  s.CKr = b64(ck);
  const keys = Object.keys(s.skipped);
  for (let i = 0; i < keys.length - MAX_STORED_SKIPS; i++) delete s.skipped[keys[i]];
}

function ratchetStep(s, h) {
  s.PN = s.Ns; s.Ns = 0; s.Nr = 0;
  s.DHr = h.dh;
  if (!h.kct) throw new Error('missing KEM ciphertext');
  const ss = ml_kem768.decapsulate(unb64(h.kct), unb64(s.KEMs.sk));
  let [RK, CKr] = kdfRK(unb64(s.RK), concatBytes(dh(s.DHs, s.DHr), ss));
  s.CKr = b64(CKr);
  s.KEMr = h.kpk;
  s.DHs = dhPair();
  s.KEMs = kemPair();
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(unb64(s.KEMr));
  const [RK2, CKs] = kdfRK(RK, concatBytes(dh(s.DHs, s.DHr), sharedSecret));
  s.RK = b64(RK2); s.CKs = b64(CKs); s.kct = b64(cipherText);
}

export function decrypt(state, msg) {
  const s = structuredClone(state);
  const h = msg.h;
  if (typeof h?.dh !== 'string' || typeof h.kpk !== 'string' || !Number.isInteger(h.n) || !Number.isInteger(h.pn)) throw new Error('bad header');
  const ad = concatBytes(unb64(s.AD), headerBytes(h));
  const open = (mk) => {
    const { key, iv } = msgKeys(mk);
    const pt = gcm(key, iv, ad).decrypt(unb64(msg.c));
    wipe(key);
    return fromUtf8(pt);
  };
  const skippedKey = `${h.dh}:${h.n}`;
  if (s.skipped[skippedKey]) {
    const pt = open(unb64(s.skipped[skippedKey]));
    delete s.skipped[skippedKey];
    return { state: s, plaintext: pt };
  }
  if (h.dh !== s.DHr) {
    skipTo(s, h.pn);
    ratchetStep(s, h);
  }
  skipTo(s, h.n);
  const [mk, next] = chainStep(unb64(s.CKr));
  s.CKr = b64(next); s.Nr++;
  const pt = open(mk);
  wipe(mk);
  return { state: s, plaintext: pt };
}
