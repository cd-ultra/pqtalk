// Group media encryption: Signal "Sender Keys" + SFrame-style frame protection.
//
// Each member owns a sender chain key and hands it to every other member over the pairwise PQ
// sessions. Frames are protected with AES-128-CTR + HMAC-SHA256 truncated to 80 bits — the
// SFrame (RFC 9605) audio cipher suite — keyed from a hash ratchet that steps every 256 frames
// (~15 s at 60 ms packets). Old generation keys are deleted => forward secrecy within a talk
// session. Sender keys are rotated whenever someone leaves and on a timer.
//
// Frame layout: [epoch:1][gen:3][ctr:1] || ciphertext || tag:10   (15 bytes overhead)
import { ctr } from '@noble/ciphers/aes.js';
import { kdf, chainStep, hmac, sha256, concatBytes, ctEqual, wipe } from './prim.js';

const HDR = 5, TAG = 10, PER_GEN = 256, MAX_GEN_SKIP = 64;

function genMaterial(ck) {
  const [mk] = chainStep(ck);
  const okm = kdf(mk, null, 'sframe gen', 16 + 32 + 12);
  wipe(mk);
  return { enc: okm.slice(0, 16), auth: okm.slice(16, 48), salt: okm.slice(48, 60) };
}
const nextCk = (ck) => chainStep(ck)[1];

function ivFor(salt, ctrByte) {
  const iv = new Uint8Array(16);
  iv.set(salt);
  iv[11] ^= ctrByte;
  return iv; // last 4 bytes = CTR block counter, starts at 0
}
const tagOf = (auth, hdr, ct) => hmac(sha256, auth, concatBytes(hdr, ct)).subarray(0, TAG);

export class SenderChain {
  constructor(chainKey, epoch) {
    this.epoch = epoch & 0xff;
    this.ck = chainKey.slice();
    this.gen = 0;
    this.ctr = 0;
    this.m = genMaterial(this.ck);
  }
  encrypt(pt) {
    if (this.ctr === PER_GEN) {
      const n = nextCk(this.ck);
      wipe(this.ck, this.m.enc, this.m.auth);
      this.ck = n; this.gen++; this.ctr = 0;
      this.m = genMaterial(this.ck);
    }
    const hdr = Uint8Array.of(this.epoch, (this.gen >>> 16) & 0xff, (this.gen >>> 8) & 0xff, this.gen & 0xff, this.ctr);
    const ct = ctr(this.m.enc, ivFor(this.m.salt, this.ctr)).encrypt(pt);
    this.ctr++;
    return concatBytes(hdr, ct, tagOf(this.m.auth, hdr, ct));
  }
  destroy() { wipe(this.ck, this.m.enc, this.m.auth); }
}

export class ReceiverChain {
  /** chainKey is the sender's key at generation `gen` (joiners never get older generations). */
  constructor(chainKey, epoch, gen = 0) {
    this.epoch = epoch & 0xff;
    this.ck = chainKey.slice();
    this.gen = gen;
    this.cache = new Map([[gen, genMaterial(this.ck)]]); // keep current + previous gen for reordering
  }
  _materialFor(gen) {
    if (this.cache.has(gen)) return this.cache.get(gen);
    if (gen < this.gen || gen - this.gen > MAX_GEN_SKIP) return null;
    while (this.gen < gen) {
      const n = nextCk(this.ck); wipe(this.ck); this.ck = n; this.gen++;
      this.cache.set(this.gen, genMaterial(this.ck));
    }
    for (const g of [...this.cache.keys()]) if (g < this.gen - 1) { const m = this.cache.get(g); wipe(m.enc, m.auth); this.cache.delete(g); }
    return this.cache.get(gen);
  }
  /** Returns plaintext or null (drop). */
  decrypt(frame) {
    if (frame.length < HDR + TAG || frame[0] !== this.epoch) return null;
    const gen = (frame[1] << 16) | (frame[2] << 8) | frame[3];
    const m = this._materialFor(gen);
    if (!m) return null;
    const hdr = frame.subarray(0, HDR), ct = frame.subarray(HDR, frame.length - TAG);
    if (!ctEqual(tagOf(m.auth, hdr, ct), frame.subarray(frame.length - TAG))) return null;
    return ctr(m.enc, ivFor(m.salt, frame[4])).decrypt(ct);
  }
  destroy() { wipe(this.ck); for (const m of this.cache.values()) wipe(m.enc, m.auth); this.cache.clear(); }
}

export const frameEpoch = (frame) => frame[0];
export const FRAME_OVERHEAD = HDR + TAG;
