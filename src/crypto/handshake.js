// Hybrid post-quantum pairwise handshake, modeled on Signal's PQXDH but interactive
// (both peers are online, so no prekey server is needed):
//
//   SK = HKDF( X25519(eA,eB) || ML-KEM-768(A->B) || ML-KEM-768(B->A),
//              salt = SHA256(PSK_room || transcript) )
//
// * Confidentiality holds if EITHER X25519 or ML-KEM-768 holds (hybrid), plus the room PSK.
// * Each side encapsulates to the other, so each contributes fresh PQ entropy.
// * HELLO and KEM messages are signed by the Ed25519 identity key and bound to the room.
// * Ephemeral keys are per session => forward secrecy of the session root.
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { kdf, sha256, concatBytes, utf8, b64, unb64, wipe, VERSION } from './prim.js';
import { verify } from './identity.js';

export function createEphemeral() {
  const xsk = x25519.utils.randomSecretKey();
  const kem = ml_kem768.keygen();
  return { xsk, xpk: x25519.getPublicKey(xsk), kemPk: kem.publicKey, kemSk: kem.secretKey };
}

const helloBytes = (roomId, h) =>
  utf8(JSON.stringify([VERSION, 'hello', roomId, h.id, h.nick, h.ik, h.ek, h.kem, h.ts]));

export function makeHello({ roomId, peerId, nick, identity, eph }) {
  const h = { id: peerId, nick, ik: b64(identity.pk), ek: b64(eph.xpk), kem: b64(eph.kemPk), ts: Date.now() };
  h.sig = b64(identity.sign(helloBytes(roomId, h)));
  return h;
}

/** Returns parsed hello with byte fields + transcript hash, or throws. */
export function verifyHello(roomId, h) {
  const ik = unb64(h.ik), ek = unb64(h.ek), kem = unb64(h.kem);
  if (ik.length !== 32 || ek.length !== 32 || kem.length !== 1184) throw new Error('bad hello sizes');
  const bytes = helloBytes(roomId, h);
  if (!verify(unb64(h.sig), bytes, ik)) throw new Error('bad hello signature');
  if (typeof h.nick !== 'string' || h.nick.length > 40) throw new Error('bad nick');
  return { id: h.id, nick: h.nick, ik, ek, kem, hash: sha256(bytes) };
}

const kemBytes = (roomId, from, to, ct, hFrom, hTo) =>
  concatBytes(utf8(JSON.stringify([VERSION, 'kem', roomId, from, to])), sha256(ct), hFrom, hTo);

/** Encapsulate to a verified peer hello. Returns { msg, ss }. */
export function encapsulateTo({ roomId, myId, myHelloHash, identity, peer }) {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(peer.kem);
  const sig = identity.sign(kemBytes(roomId, myId, peer.id, cipherText, myHelloHash, peer.hash));
  return { msg: { ct: b64(cipherText), sig: b64(sig) }, ct: cipherText, ss: sharedSecret };
}

/** Verify + decapsulate a KEM message from peer addressed to me. */
export function decapsulateFrom({ roomId, myId, myHelloHash, eph, peer, msg }) {
  const ct = unb64(msg.ct);
  if (ct.length !== 1088) throw new Error('bad kem ct');
  if (!verify(unb64(msg.sig), kemBytes(roomId, peer.id, myId, ct, peer.hash, myHelloHash), peer.ik))
    throw new Error('bad kem signature');
  return { ct, ss: ml_kem768.decapsulate(ct, eph.kemSk) };
}

/**
 * Combine everything into the pairwise root key. Inputs are ordered by peer id so both sides agree.
 * Returns { root, iAmLo }.
 */
export function deriveRoot({ psk, myId, peerId, eph, peerHello, myHelloHash, myCt, mySs, theirCt, theirSs }) {
  const iAmLo = myId < peerId;
  const dh = x25519.getSharedSecret(eph.xsk, peerHello.ek);
  if (dh.every((b) => b === 0)) throw new Error('low-order point');
  const [ssLo, ssHi] = iAmLo ? [mySs, theirSs] : [theirSs, mySs]; // ss "Lo" = encapsulated BY lo
  const [ctLo, ctHi] = iAmLo ? [myCt, theirCt] : [theirCt, myCt];
  const [hLo, hHi] = iAmLo ? [myHelloHash, peerHello.hash] : [peerHello.hash, myHelloHash];
  const transcript = sha256(concatBytes(hLo, hHi, sha256(ctLo), sha256(ctHi)));
  const root = kdf(concatBytes(dh, ssLo, ssHi), sha256(concatBytes(psk, transcript)), 'pairwise-root');
  wipe(dh);
  return { root, iAmLo };
}
