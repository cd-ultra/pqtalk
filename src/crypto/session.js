// Pairwise secure session.
//  * Root key from the hybrid handshake.
//  * Per-direction symmetric KDF chains (Signal "symmetric-key ratchet"): every message gets a
//    fresh key, old keys are deleted => forward secrecy per message.
//  * Periodic hybrid KEM re-key (fresh X25519 + ML-KEM-768 each time) mixed into the root chain
//    => post-compromise security, analogous to the DH/SPQR steps of Signal's triple ratchet.
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { kdf, chainStep, seal, open, concatBytes, utf8, fromUtf8, b64, unb64, wipe } from './prim.js';

const MAX_SKIP = 500;

function chainsFor(root, iAmLo) {
  const lo2hi = kdf(root, null, 'chain lo->hi');
  const hi2lo = kdf(root, null, 'chain hi->lo');
  return iAmLo ? { send: lo2hi, recv: hi2lo } : { send: hi2lo, recv: lo2hi };
}

export class PairSession {
  constructor(root, iAmLo) {
    this.root = root;
    this.iAmLo = iAmLo;
    this.epoch = 0;
    const c = chainsFor(root, iAmLo);
    this.send = { ck: c.send, n: 0 };
    this.recv = new Map([[0, { ck: c.recv, n: 0, skipped: new Map() }]]);
    this.pendingRekey = null;
    this.lastRekey = Date.now();
  }

  encrypt(obj) {
    const [mk, next] = chainStep(this.send.ck);
    wipe(this.send.ck);
    this.send.ck = next;
    const n = this.send.n++;
    const key = kdf(mk, null, 'msg-key');
    wipe(mk);
    const aad = utf8(`${this.epoch}|${n}`);
    const c = seal(key, utf8(JSON.stringify(obj)), aad);
    wipe(key);
    return { e: this.epoch, n, c: b64(c) };
  }

  decrypt(env) {
    const st = this.recv.get(env.e);
    if (!st) throw new Error(`unknown epoch ${env.e}`);
    let mk;
    if (env.n < st.n) {
      mk = st.skipped.get(env.n);
      if (!mk) throw new Error('replay or too old');
      st.skipped.delete(env.n);
    } else {
      if (env.n - st.n > MAX_SKIP) throw new Error('too many skipped');
      while (st.n < env.n) {
        const [k, next] = chainStep(st.ck);
        st.skipped.set(st.n++, k);
        wipe(st.ck); st.ck = next;
      }
      const [k, next] = chainStep(st.ck);
      wipe(st.ck); st.ck = next; st.n++;
      mk = k;
      if (st.skipped.size > MAX_SKIP) { const first = st.skipped.keys().next().value; st.skipped.delete(first); }
    }
    const key = kdf(mk, null, 'msg-key');
    wipe(mk);
    const pt = open(key, unb64(env.c), utf8(`${env.e}|${env.n}`));
    wipe(key);
    // first message in a newer epoch proves the peer switched: drop older receive chains
    for (const e of [...this.recv.keys()]) if (e < env.e) { const o = this.recv.get(e); wipe(o.ck); this.recv.delete(e); }
    return JSON.parse(fromUtf8(pt));
  }

  _advance(secret) {
    const newRoot = kdf(secret, this.root, 'root-ratchet');
    wipe(this.root, secret);
    this.root = newRoot;
    this.epoch++;
    const c = chainsFor(newRoot, this.iAmLo);
    wipe(this.send.ck);
    this.send = { ck: c.send, n: 0 };
    this.recv.set(this.epoch, { ck: c.recv, n: 0, skipped: new Map() });
    this.lastRekey = Date.now();
  }

  // ---- PQ ratchet step (initiated by the "lo" peer) ----
  startRekey() {
    const xsk = x25519.utils.randomSecretKey();
    const kem = ml_kem768.keygen();
    this.pendingRekey = { xsk, kemSk: kem.secretKey };
    return { t: 'rk1', x: b64(x25519.getPublicKey(xsk)), k: b64(kem.publicKey) };
  }
  /** Responder: returns reply message; caller must send it (under the OLD epoch) then call commit(). */
  answerRekey(m) {
    const xsk = x25519.utils.randomSecretKey();
    const dh = x25519.getSharedSecret(xsk, unb64(m.x));
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(unb64(m.k));
    const reply = { t: 'rk2', x: b64(x25519.getPublicKey(xsk)), c: b64(cipherText) };
    const secret = concatBytes(dh, sharedSecret);
    wipe(xsk, dh, sharedSecret);
    return { reply, commit: () => this._advance(secret) };
  }
  finishRekey(m) {
    const p = this.pendingRekey;
    if (!p) throw new Error('no pending rekey');
    this.pendingRekey = null;
    const dh = x25519.getSharedSecret(p.xsk, unb64(m.x));
    const ss = ml_kem768.decapsulate(unb64(m.c), p.kemSk);
    const secret = concatBytes(dh, ss);
    wipe(p.xsk, p.kemSk, dh, ss);
    this._advance(secret);
  }
}
