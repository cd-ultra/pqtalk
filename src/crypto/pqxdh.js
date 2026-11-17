// Asynchronous session setup modeled on Signal's PQXDH, so you can message someone who is offline.
//
// Each device publishes a signed bundle: X25519 identity key, X25519 signed prekey, ML-KEM-768
// signed prekey, plus X25519 one-time prekeys. The initiator computes
//   SK = HKDF( F || DH(IKa,SPKb) || DH(EKa,IKb) || DH(EKa,SPKb) [|| DH(EKa,OPKb)] || KEM(PQSPKb),
//              salt = SHA256(PSK) )
// where PSK is the invite secret (or the group secret for members introduced by a group). The PSK
// adds a symmetric, quantum-safe authentication factor on top of the Ed25519 signatures.
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { kdf, sha256, concatBytes, utf8, b64, unb64, randomBytes, wipe } from './prim.js';
import { verify } from './identity.js';

const label = (s) => utf8(`pqtalk-v2 ${s}`);
const F = new Uint8Array(32).fill(0xff);

// ---------------- device prekeys (private state lives in IndexedDB) ----------------
export function newSignedPrekeys(identity, now = Date.now()) {
  const id = Math.floor(now / 1000);
  const ssk = x25519.utils.randomSecretKey();
  const kem = ml_kem768.keygen();
  const spkPub = x25519.getPublicKey(ssk);
  return {
    spk: { id, sk: b64(ssk), pub: b64(spkPub), sig: b64(identity.sign(concatBytes(label('spk'), spkPub))), ts: now },
    pqspk: { id, sk: b64(kem.secretKey), pub: b64(kem.publicKey), sig: b64(identity.sign(concatBytes(label('pqspk'), kem.publicKey))), ts: now },
  };
}

export function newIdentityDH(identity) {
  const sk = x25519.utils.randomSecretKey();
  const pub = x25519.getPublicKey(sk);
  return { sk: b64(sk), pub: b64(pub), sig: b64(identity.sign(concatBytes(label('ikx'), pub))) };
}

export function newOneTimePrekeys(startId, n) {
  return Array.from({ length: n }, (_, i) => {
    const sk = x25519.utils.randomSecretKey();
    return { id: startId + i, sk: b64(sk), pub: b64(x25519.getPublicKey(sk)) };
  });
}

/** What goes to the server: public halves only. */
export function publicBundle(keys) {
  return {
    ikx: keys.ikx.pub, ikxSig: keys.ikx.sig,
    spk: { id: keys.spk.id, pub: keys.spk.pub, sig: keys.spk.sig },
    pqspk: { id: keys.pqspk.id, pub: keys.pqspk.pub, sig: keys.pqspk.sig },
  };
}

/** Verify a fetched bundle against an identity key we already trust (from an invite or a group). */
export function verifyBundle(ikB64, bundle) {
  const ik = unb64(ikB64);
  const ikx = unb64(bundle.ikx), spk = unb64(bundle.spk.pub), pq = unb64(bundle.pqspk.pub);
  if (ikx.length !== 32 || spk.length !== 32 || pq.length !== 1184) throw new Error('bad bundle sizes');
  if (!verify(unb64(bundle.ikxSig), concatBytes(label('ikx'), ikx), ik)) throw new Error('bad identity-key signature');
  if (!verify(unb64(bundle.spk.sig), concatBytes(label('spk'), spk), ik)) throw new Error('bad signed-prekey signature');
  if (!verify(unb64(bundle.pqspk.sig), concatBytes(label('pqspk'), pq), ik)) throw new Error('bad PQ-prekey signature');
  return { ik, ikx, spk, pq };
}

function deriveSK(parts, psk, ikA, ikB) {
  const sk = kdf(concatBytes(F, ...parts), sha256(psk), `PQXDH ${b64(ikA)} ${b64(ikB)}`, 32);
  wipe(...parts);
  return sk;
}

/**
 * Initiator side. `me` = { identity, ikx:{sk,pub} } ; `them` = { ik (b64), bundle, opk|null } ; psk bytes.
 * Returns { sk, ad, pre } where `pre` travels with the first message.
 */
export function initiate(me, them, psk, pskId) {
  const v = verifyBundle(them.ik, them.bundle);
  const ek = x25519.utils.randomSecretKey();
  const ekPub = x25519.getPublicKey(ek);
  const ikxA = unb64(me.ikx.sk);
  const parts = [
    x25519.getSharedSecret(ikxA, v.spk),
    x25519.getSharedSecret(ek, v.ikx),
    x25519.getSharedSecret(ek, v.spk),
  ];
  if (them.opk) parts.push(x25519.getSharedSecret(ek, unb64(them.opk.pub)));
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(v.pq);
  parts.push(sharedSecret);
  const ikA = me.identity.pk;
  const sk = deriveSK(parts, psk, ikA, v.ik);
  wipe(ek);
  const sigMsg = concatBytes(label('pre'), unb64(me.ikx.pub), ekPub, v.ik, sha256(cipherText));
  const pre = {
    ik: b64(ikA), ikx: me.ikx.pub, ek: b64(ekPub), sig: b64(me.identity.sign(sigMsg)),
    spk: them.bundle.spk.id, pqspk: them.bundle.pqspk.id, opk: them.opk?.id ?? null,
    kct: b64(cipherText), psk: pskId,
  };
  return { sk, ad: concatBytes(ikA, v.ik), pre, theirSpk: v.spk, theirPq: v.pq };
}

/**
 * Responder side. `keys` = my stored device keys; `lookup` = { spk(id), pqspk(id), opk(id) } returning
 * stored secret records (or undefined). Returns { sk, ad, ikA, spk, pqspk, usedOpk }.
 */
export function respond(me, keys, lookup, pre, psk) {
  const ikA = unb64(pre.ik), ikxA = unb64(pre.ikx), ek = unb64(pre.ek), kct = unb64(pre.kct);
  if (ikA.length !== 32 || ikxA.length !== 32 || ek.length !== 32 || kct.length !== 1088) throw new Error('bad prekey message');
  const sigMsg = concatBytes(label('pre'), ikxA, ek, me.identity.pk, sha256(kct));
  if (!verify(unb64(pre.sig), sigMsg, ikA)) throw new Error('bad prekey message signature');
  const spk = lookup.spk(pre.spk), pq = lookup.pqspk(pre.pqspk);
  if (!spk || !pq) throw new Error('unknown or expired prekey');
  const spkSk = unb64(spk.sk);
  const parts = [
    x25519.getSharedSecret(spkSk, ikxA),
    x25519.getSharedSecret(unb64(keys.ikx.sk), ek),
    x25519.getSharedSecret(spkSk, ek),
  ];
  if (pre.opk != null) {
    const o = lookup.opk(pre.opk);
    if (!o) throw new Error('one-time prekey already used');
    parts.push(x25519.getSharedSecret(unb64(o.sk), ek));
  }
  parts.push(ml_kem768.decapsulate(kct, unb64(pq.sk)));
  const sk = deriveSK(parts, psk, ikA, me.identity.pk);
  return { sk, ad: concatBytes(ikA, me.identity.pk), ikA, spk, pqspk: pq };
}

export const newSecret = () => randomBytes(32);
