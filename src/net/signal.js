// Room-level envelope over an untrusted relay: AES-256-GCM under a key derived from the room
// code, with timestamps + message ids for replay/duplicate suppression (multi-broker fan-out
// delivers the same message several times).
import { seal, open, utf8, fromUtf8, b64, unb64, randomId } from '../crypto/prim.js';

const MAX_AGE_MS = 120_000;

export class RoomSignal {
  constructor({ transport, room, peerId, onMessage }) {
    Object.assign(this, { transport, room, peerId, onMessage });
    this.base = `pqtalk/v1/${room.roomId}`;
    this.seen = new Map();
    this.aad = utf8(room.roomId);
  }
  start() {
    const handler = (raw) => this._recv(raw);
    this.transport.subscribe(`${this.base}/all`, handler);
    this.transport.subscribe(`${this.base}/${this.peerId}`, handler);
  }
  send(to, msg) {
    const inner = { ...msg, f: this.peerId, ts: Date.now(), i: randomId(8) };
    const outer = JSON.stringify({ f: this.peerId, c: b64(seal(this.room.signalKey, utf8(JSON.stringify(inner)), this.aad)) });
    this.transport.publish(`${this.base}/${to ?? 'all'}`, outer);
  }
  _recv(raw) {
    let outer, inner;
    try {
      outer = JSON.parse(raw);
      if (outer.f === this.peerId) return;
      inner = JSON.parse(fromUtf8(open(this.room.signalKey, unb64(outer.c), this.aad)));
    } catch { return; } // not for us / not decryptable => ignore silently
    if (inner.f !== outer.f || Math.abs(Date.now() - inner.ts) > MAX_AGE_MS || this.seen.has(inner.i)) return;
    this.seen.set(inner.i, inner.ts);
    if (this.seen.size > 2000) for (const [k, ts] of this.seen) if (Date.now() - ts > MAX_AGE_MS) this.seen.delete(k);
    this.onMessage(inner.f, inner);
  }
}
