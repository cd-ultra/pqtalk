// Voice calls and walkie-talkie for any chat. Both reuse the encrypted voice room (PQ pairwise
// handshake + SFrame sender keys + WebRTC mesh); calls keep the mic open, walkie-talkie is
// push-to-talk. Ringing travels as normal encrypted messages; the room itself is derived from
// the chat's shared secret, so only chat members can join.
import { Room } from '../room.js';
import { AudioIO } from '../audio.js';
import { deriveRoom } from '../crypto/code.js';
import { bytesToHex, randomId } from '../crypto/prim.js';
import { ServerRoomTransport } from './api.js';

const RING_MS = 45_000;

export class Voice extends EventTarget {
  constructor(messenger, { iceServers }) {
    super();
    this.m = messenger;
    this.iceServers = iceServers;
    this.audio = new AudioIO();
    this.state = null; // { conv, mode, callId, phase, room, startedAt, muted, from }
    this.walkieSeen = new Map(); // conv -> Map(contact id -> ts) of others on walkie-talkie there
    messenger.addEventListener('call', (e) => this._onSignal(e.detail));
  }
  emit() { this.dispatchEvent(new Event('change')); }

  async _join(conv, mode, callId) {
    const code = await this.m.voiceCode(conv, callId);
    const track = await this.audio.init();
    const transport = new ServerRoomTransport(this.m.account.server, deriveRoom(code).roomId);
    const iceServers = typeof this.iceServers === 'function' ? await this.iceServers() : this.iceServers;
    const room = new Room({
      code, nick: this.m.account.name, identity: this.m.identity, transport, iceServers,
      bitrate: mode === 'call' ? 24000 : 16000, ptime: mode === 'call' ? 20 : 40,
    });
    room.setTxTrack(track);
    room.addEventListener('peers', () => this._onPeers());
    room.addEventListener('ptt', (e) => { if (e.detail.on && mode === 'ptt') this.audio.tone('rx'); this.emit(); });
    room.addEventListener('needs-gesture', () => this.dispatchEvent(new CustomEvent('toast', { detail: 'Tap anywhere to turn on audio' })));
    this.state.room = room;
    await room.start();
    if (mode === 'call' && !this.state.muted) room.ptt(true);
    this.emit();
  }

  _onPeers() {
    const s = this.state; if (!s?.room) return;
    const live = [...s.room.peers.values()].some((p) => p.status === 'connected');
    if (live && s.phase !== 'live') { s.phase = 'live'; s.startedAt = Date.now(); clearTimeout(s.ringTimer); if (s.mode === 'call') s.room.ptt(!s.muted); }
    // Everyone else has left (1:1 or group): end it here too instead of sitting in an empty call.
    if (s.mode === 'call' && s.phase === 'live' && s.room.peers.size === 0) this.hangup(s.direct ? 'Call ended' : 'Everyone left the call');
    this.emit();
  }

  /** Name for a peer in the voice room, from our contacts (bound to their signed identity key). */
  async peerName(p) { return (await this.m.contact(bytesToHex(p.ik)))?.name ?? p.nick; }

  // ---------------- calls ----------------
  async call(conv) {
    if (this.state) throw new Error('You’re already in a call');
    const v = await this.m.conv(conv);
    const callId = randomId(8);
    this.state = { conv, mode: 'call', callId, phase: 'ringing-out', muted: false, direct: v?.type !== 'group' };
    this.emit();
    await this.m.callSignal(conv, 'ring', { call: callId, mode: 'call', ts: Date.now() });
    this.state.ringTimer = setTimeout(() => { if (this.state?.phase === 'ringing-out') this.hangup('No answer'); }, RING_MS);
    await this._join(conv, 'call', callId).catch((e) => this.hangup(e.message));
  }

  async accept() {
    const s = this.state; if (s?.phase !== 'ringing-in') return;
    s.phase = 'connecting'; this.emit();
    this.m.callSignal(s.conv, 'accept', { call: s.callId });
    await this._join(s.conv, 'call', s.callId).catch((e) => this.hangup(e.message));
  }

  decline() {
    const s = this.state; if (s?.phase !== 'ringing-in') return;
    this.m.callSignal(s.conv, 'decline', { call: s.callId });
    this._clear();
  }

  hangup(reason, { keepalive = false } = {}) {
    const s = this.state; if (!s) return;
    if (s.mode === 'call') {
      const op = s.phase === 'ringing-out' ? 'cancel' : s.phase === 'ringing-in' ? 'decline' : 'end';
      this.m.callSignal(s.conv, op, { call: s.callId }, { keepalive });
    }
    if (s.mode === 'ptt') this.m.callSignal(s.conv, 'walkie-off', {}, { keepalive });
    this._clear(reason);
  }

  setMuted(on) { const s = this.state; if (!s) return; s.muted = on; if (s.mode === 'call') s.room?.ptt(!on); this.emit(); }

  // ---------------- walkie-talkie ----------------
  async walkie(conv) {
    if (this.state) throw new Error('Leave the current call first');
    this.state = { conv, mode: 'ptt', callId: 'walkie', phase: 'connecting', muted: true };
    this.emit();
    this.m.callSignal(conv, 'walkie', { ts: Date.now() });
    await this._join(conv, 'ptt', 'walkie').catch((e) => this._clear(e.message));
  }
  talk(on) {
    const r = this.state?.room; if (!r || this.state.mode !== 'ptt') return false;
    if (on && r.channelBusy) { this.audio.tone('busy'); return false; }
    r.ptt(on); this.audio.tone(on ? 'permit' : 'roger', !on); this.emit();
    return true;
  }
  leaveWalkie() { if (this.state?.mode === 'ptt') this.hangup(); }

  /** Others currently on walkie-talkie in a chat (notices older than 10 minutes are ignored). */
  walkieActive(conv) {
    const m = this.walkieSeen.get(conv); if (!m) return [];
    for (const [id, ts] of m) if (Date.now() - ts > 10 * 60_000) m.delete(id);
    return [...m.keys()];
  }

  _clear(reason) {
    const s = this.state; if (!s) return;
    clearTimeout(s.ringTimer);
    try { s.room?.leave(); } catch {}
    this.audio.stream?.getTracks().forEach((t) => t.stop());
    this.state = null;
    if (reason) this.dispatchEvent(new CustomEvent('toast', { detail: reason }));
    this.emit();
  }

  _onSignal(e) {
    const s = this.state;
    if (e.op === 'walkie' || e.op === 'walkie-off') {
      const seen = this.walkieSeen.get(e.conv) ?? new Map();
      if (e.op === 'walkie' && Date.now() - (e.ts ?? 0) < 10 * 60_000) seen.set(e.from, e.ts);
      else seen.delete(e.from);
      this.walkieSeen.set(e.conv, seen);
      this.emit();
      return;
    }
    if (e.op === 'ring') {
      if (Date.now() - (e.ts ?? 0) > RING_MS) return; // stale ring delivered late
      if (s) { if (s.callId !== e.call) this.m.callSignal(e.conv, 'busy', { call: e.call }); return; }
      this.m.conv(e.conv).then((v) => {
        if (this.state) return;
        this.state = { conv: e.conv, mode: 'call', callId: e.call, phase: 'ringing-in', muted: false, from: e.from, direct: v?.type !== 'group',
                       inCall: new Set([e.from]) }; // who is in the call, so a group ring can stop once they've all left
        this.state.ringTimer = setTimeout(() => { if (this.state?.phase === 'ringing-in') this._clear('Missed call'); }, RING_MS);
        this.emit();
      });
      return;
    }
    if (!s || s.callId !== e.call) return;
    if (e.op === 'accept') {
      s.inCall?.add(e.from);
      if (s.phase === 'ringing-out') { s.phase = 'connecting'; this.emit(); }
      return;
    }
    if (s.direct) {
      // 1:1: whatever phase we're in, the other person leaving ends the call for us too.
      // (A caller can give up at the same moment the callee answers; the callee must not stay "Connecting".)
      if (e.op === 'cancel') this._clear(s.phase === 'ringing-in' ? 'Missed call' : 'Call ended');
      else if (e.op === 'end') this._clear('Call ended');
      else if (e.op === 'decline' || e.op === 'busy') this._clear(e.op === 'busy' ? 'Busy' : 'Call declined');
      return;
    }
    // Group: the caller hanging up before anyone joined stops everyone's ringing.
    // Once people are in, each person leaves on their own and the room tracks who is left.
    if (s.phase !== 'ringing-in') return;
    if (e.op === 'cancel') return this._clear('Missed call');
    if (e.op === 'end' || e.op === 'decline') { s.inCall.delete(e.from); if (!s.inCall.size) this._clear('Missed call'); }
  }
}
