// Group channel orchestration: discovery, PQ handshakes, WebRTC mesh, sender-key management,
// push-to-talk state, liveness, and stats.
import { deriveRoom } from './crypto/code.js';
import { safetyNumber } from './crypto/identity.js';
import { createEphemeral, makeHello, verifyHello, encapsulateTo, decapsulateFrom, deriveRoot } from './crypto/handshake.js';
import { PairSession } from './crypto/session.js';
import { randomBytes, randomId, b64, unb64, bytesToHex } from './crypto/prim.js';
import { RoomSignal } from './net/signal.js';
import { tuneOpus } from './rtc/sdp.js';
import { e2eeMode, attach } from './rtc/e2ee.js';

const HELLO_EVERY = 20_000;
const PEER_TIMEOUT = 45_000;
const PAIR_REKEY_EVERY = 5 * 60_000;
const SENDER_KEY_EVERY = 10 * 60_000;

export class Room extends EventTarget {
  constructor({ code, nick, identity, transport, iceServers, relayOnly = false, bitrate = 12000, ptime = 60 }) {
    super();
    this.room = deriveRoom(code);
    Object.assign(this, { nick, identity, transport, iceServers, relayOnly, bitrate, ptime });
    this.peerId = randomId(8);
    this.eph = createEphemeral();
    this.hello = makeHello({ roomId: this.room.roomId, peerId: this.peerId, nick, identity, eph: this.eph });
    this.helloHash = verifyHello(this.room.roomId, this.hello).hash;
    this.peers = new Map();
    this.pendingKem = new Map();
    this.pendingPair = new Map();
    this.txTrack = null;
    this.talking = false;
    this.mode = e2eeMode();
    if (!this.mode) throw new Error('This browser lacks WebRTC encoded transforms; refusing to run without frame-level E2EE.');
    this.worker = new Worker(new URL('./e2ee-worker.js', import.meta.url), { type: 'module', name: 'e2ee' });
    this.worker.onmessage = ({ data }) => { if (data.op === 'stats') this.frameStats = data; };
    this.sk = null; this.skPending = null; this.skAgain = false;
    this.signal = new RoomSignal({ transport, room: this.room, peerId: this.peerId, onMessage: (f, m) => this._onSignal(f, m) });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  log(...a) { this.emit('log', a.join(' ')); }

  async start() {
    this.transport.onstatus = (up, total) => this.emit('relay', { up, total });
    await this.transport.connect();
    this.signal.start();
    this._rotateSenderKey(true);
    this.signal.send(null, { t: 'hello', h: this.hello });
    this.timers = [
      setInterval(() => this.signal.send(null, { t: 'hello', h: this.hello }), HELLO_EVERY),
      setInterval(() => this._tick(), 2000),
      setInterval(() => this._rotateSenderKey(), SENDER_KEY_EVERY),
    ];
  }

  leave() {
    try { this.signal.send(null, { t: 'bye' }); } catch {}
    this.timers?.forEach(clearInterval);
    for (const id of [...this.peers.keys()]) this._removePeer(id, false);
    setTimeout(() => this.transport.close(), 300);
    this.worker.terminate();
  }

  // ---------------- relay messages ----------------
  _onSignal(from, m) {
    try {
      if (m.t === 'hello') return this._onHello(from, m);
      if (m.t === 'kem') return this._onKem(from, m);
      if (m.t === 'p') {
        const p = this.peers.get(from);
        if (!p?.session) { const q = this.pendingPair.get(from) ?? []; q.push(m.s); this.pendingPair.set(from, q.slice(-50)); return; }
        return this._onPairEnvelope(p, m.s);
      }
      if (m.t === 'bye') return this._removePeer(from, true);
    } catch (e) { this.log(`signal ${m.t} from ${from}: ${e.message}`); }
  }

  _onHello(from, m) {
    if (m.h.id !== from) return;
    const existing = this.peers.get(from);
    if (existing) {
      existing.lastSeen = Date.now();
      // peer lost us (e.g. reloaded its pc) while we still hold it: it re-announces; nothing to do
      return;
    }
    const hello = verifyHello(this.room.roomId, m.h);
    const p = {
      id: from, nick: hello.nick, hello, ik: hello.ik, status: 'handshake', lastSeen: Date.now(),
      safety: null, talking: false, iAmLo: this.peerId < from, iceQ: [], stats: {},
    };
    this.peers.set(from, p);
    if (!m.reply) this.signal.send(from, { t: 'hello', h: this.hello, reply: true });
    const enc = encapsulateTo({ roomId: this.room.roomId, myId: this.peerId, myHelloHash: this.helloHash, identity: this.identity, peer: hello });
    p.myKem = enc;
    this.signal.send(from, { t: 'kem', ...enc.msg });
    const pk = this.pendingKem.get(from);
    if (pk) { this.pendingKem.delete(from); this._onKem(from, pk); }
    this.emit('peers');
  }

  _onKem(from, m) {
    const p = this.peers.get(from);
    if (!p) { this.pendingKem.set(from, m); return; }
    if (p.theirKem) return;
    p.theirKem = decapsulateFrom({ roomId: this.room.roomId, myId: this.peerId, myHelloHash: this.helloHash, eph: this.eph, peer: p.hello, msg: m });
    if (!p.myKem) return;
    const { root, iAmLo } = deriveRoot({
      psk: this.room.psk, myId: this.peerId, peerId: from, eph: this.eph, peerHello: p.hello, myHelloHash: this.helloHash,
      myCt: p.myKem.ct, mySs: p.myKem.ss, theirCt: p.theirKem.ct, theirSs: p.theirKem.ss,
    });
    p.myKem.ss.fill(0); p.theirKem.ss.fill(0);
    p.session = new PairSession(root, iAmLo);
    p.safety = safetyNumber(this.identity.pk, p.ik);
    p.status = 'connecting';
    this.log(`🔐 PQ session with ${p.nick} (X25519 + ML-KEM-768 + room PSK)`);
    this._startRtc(p);
    for (const env of this.pendingPair.get(from) ?? []) this._onPairEnvelope(p, env);
    this.pendingPair.delete(from);
    this._rotateSenderKey(); // membership changed => new sender key for everyone
    this.emit('peers');
  }

  // ---------------- pairwise secure channel ----------------
  _sendPair(p, obj) {
    if (!p.session) return;
    const env = p.session.encrypt(obj);
    if (p.dc?.readyState === 'open') p.dc.send(JSON.stringify(env));
    else this.signal.send(p.id, { t: 'p', s: env });
  }

  _onPairEnvelope(p, env) {
    let m;
    try { m = p.session.decrypt(env); } catch (e) { return this.log(`decrypt from ${p.nick}: ${e.message}`); }
    p.lastSeen = Date.now();
    this._onPair(p, m).catch((e) => this.log(`pair ${m.t}: ${e.message}`));
  }

  async _onPair(p, m) {
    switch (m.t) {
      case 'sdp': {
        await p.pc.setRemoteDescription(m.d);
        for (const c of p.iceQ.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
        if (m.d.type === 'offer') {
          const ans = await p.pc.createAnswer();
          await p.pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(ans.sdp, this) });
          this._sendPair(p, { t: 'sdp', d: { type: 'answer', sdp: p.pc.localDescription.sdp } });
        }
        break;
      }
      case 'ice':
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(m.c).catch(() => {});
        else p.iceQ.push(m.c);
        break;
      case 'sk':
        this.worker.postMessage({ op: 'setRecvKey', peerId: p.id, key: unb64(m.k), epoch: m.e });
        this._sendPair(p, { t: 'ska', e: m.e });
        break;
      case 'ska':
        if (this.skPending?.epoch === m.e) { this.skPending.acks.add(p.id); this._maybeCommitSk(); }
        break;
      case 'ptt':
        p.talking = !!m.on; this.emit('ptt', { peer: p, on: p.talking });
        break;
      case 'rk1': { const { reply, commit } = p.session.answerRekey(m); this._sendPair(p, reply); commit(); this.log(`↻ PQ ratchet with ${p.nick} (epoch ${p.session.epoch})`); break; }
      case 'rk2': p.session.finishRekey(m); this.log(`↻ PQ ratchet with ${p.nick} (epoch ${p.session.epoch})`); break;
      case 'ping': break;
    }
  }

  // ---------------- WebRTC ----------------
  _startRtc(p) {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: this.relayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require',
      ...(this.mode === 'legacy' ? { encodedInsertableStreams: true } : {}),
    });
    p.pc = pc;
    p.dc = pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true });
    p.dc.onmessage = (e) => { try { this._onPairEnvelope(p, JSON.parse(e.data)); } catch {} };
    p.dc.onopen = () => { if (this.talking) this._sendPair(p, { t: 'ptt', on: true }); this.emit('peers'); };
    p.dc.onclose = () => this._removePeer(p.id);
    pc.onicecandidate = (e) => e.candidate && this._sendPair(p, { t: 'ice', c: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') { p.status = 'connected'; p.failedAt = null; this._applyBitrate(p); }
      else if (s === 'failed') { p.status = 'reconnecting'; p.failedAt ??= Date.now(); if (p.iAmLo) this._offer(p, true); }
      else if (s === 'disconnected') p.status = 'reconnecting';
      this.emit('peers');
    };
    pc.ontrack = (e) => this._wireTransceiver(p, e.transceiver, e.track);
    if (p.iAmLo) {
      const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      this._wireTransceiver(p, tr);
      this._offer(p, false);
    }
  }

  _wireTransceiver(p, tr, track) {
    if (!p.wired) {
      p.wired = true;
      p.tr = tr;
      try {
        const opus = RTCRtpReceiver.getCapabilities?.('audio')?.codecs.filter((c) => /opus/i.test(c.mimeType));
        if (opus?.length) tr.setCodecPreferences?.(opus);
      } catch {}
      tr.direction = 'sendrecv';
      attach(this.worker, this.mode, tr.sender, 'encrypt', p.id);
      attach(this.worker, this.mode, tr.receiver, 'decrypt', p.id);
      tr.sender.replaceTrack(this.talking ? this.txTrack : null);
    }
    if (track && !p.audio) {
      p.audio = new Audio();
      p.audio.autoplay = true; p.audio.playsInline = true;
      p.audio.srcObject = new MediaStream([track]);
      if (this.sinkId && p.audio.setSinkId) p.audio.setSinkId(this.sinkId).catch(() => {});
      p.audio.play().catch(() => this.emit('needs-gesture'));
    }
  }

  async _offer(p, iceRestart) {
    const offer = await p.pc.createOffer({ iceRestart });
    await p.pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp, this) });
    this._sendPair(p, { t: 'sdp', d: { type: 'offer', sdp: p.pc.localDescription.sdp } });
  }

  async _applyBitrate(p) {
    const s = p.tr?.sender; if (!s) return;
    try {
      const prm = s.getParameters();
      if (!prm.encodings?.length) prm.encodings = [{}];
      prm.encodings[0].maxBitrate = this.bitrate;
      prm.encodings[0].priority = 'high';
      prm.encodings[0].networkPriority = 'high';
      await s.setParameters(prm);
    } catch {}
  }

  setBitrate(bps) { this.bitrate = bps; for (const p of this.peers.values()) { this._applyBitrate(p); if (p.iAmLo && p.pc?.signalingState === 'stable') this._offer(p, false); } }
  setSink(id) { this.sinkId = id; for (const p of this.peers.values()) p.audio?.setSinkId?.(id).catch(() => {}); }

  // ---------------- sender keys ----------------
  _rotateSenderKey(initial = false) {
    if (this.skPending) { this.skAgain = true; return; }
    clearTimeout(this.skDebounce);
    this.skDebounce = setTimeout(() => {
      const epoch = this.sk ? (this.sk.epoch + 1) & 0xff : Math.floor(Math.random() * 256);
      const key = randomBytes(32);
      const targets = [...this.peers.values()].filter((p) => p.session);
      this.skPending = { epoch, key, acks: new Set(), need: new Set(targets.map((p) => p.id)) };
      for (const p of targets) this._sendPair(p, { t: 'sk', k: b64(key), e: epoch });
      this.skPending.timer = setTimeout(() => this._commitSk(), 1500);
      this._maybeCommitSk();
    }, initial ? 0 : 250);
  }
  _maybeCommitSk() {
    const s = this.skPending;
    if (s && [...s.need].every((id) => s.acks.has(id) || !this.peers.has(id))) this._commitSk();
  }
  _commitSk() {
    const s = this.skPending; if (!s) return;
    clearTimeout(s.timer);
    this.worker.postMessage({ op: 'setSendKey', key: s.key, epoch: s.epoch });
    this.sk = { epoch: s.epoch };
    s.key.fill(0);
    this.skPending = null;
    this.emit('sk', { epoch: s.epoch });
    if (this.skAgain) { this.skAgain = false; this._rotateSenderKey(); }
  }

  // ---------------- PTT ----------------
  setTxTrack(track) { this.txTrack = track; if (this.talking) this._applyTx(); }
  ptt(on) {
    if (this.talking === on) return;
    this.talking = on;
    this._applyTx();
    for (const p of this.peers.values()) this._sendPair(p, { t: 'ptt', on });
  }
  _applyTx() { for (const p of this.peers.values()) p.tr?.sender.replaceTrack(this.talking ? this.txTrack : null).catch(() => {}); }
  get channelBusy() { return [...this.peers.values()].some((p) => p.talking); }

  // ---------------- housekeeping ----------------
  _removePeer(id, rotate = true) {
    const p = this.peers.get(id); if (!p) return;
    this.peers.delete(id);
    try { p.dc?.close(); p.pc?.close(); } catch {}
    if (p.audio) { p.audio.srcObject = null; }
    this.worker.postMessage({ op: 'removePeer', peerId: id });
    this.log(`${p.nick} left`);
    if (rotate) this._rotateSenderKey();
    this.emit('peers');
  }

  async _tick() {
    const now = Date.now();
    this.worker.postMessage({ op: 'stats' });
    for (const p of [...this.peers.values()]) {
      if (p.dc?.readyState === 'open') this._sendPair(p, { t: 'ping' });
      if (now - p.lastSeen > PEER_TIMEOUT || (p.failedAt && now - p.failedAt > 30_000)) { this._removePeer(p.id); continue; }
      if (p.iAmLo && p.session && p.dc?.readyState === 'open' && !p.session.pendingRekey && now - p.session.lastRekey > PAIR_REKEY_EVERY)
        this._sendPair(p, p.session.startRekey());
      if (p.pc) await this._stats(p, now).catch(() => {});
    }
    this.emit('stats');
  }

  async _stats(p, now) {
    const r = await p.pc.getStats();
    let out, inn, pair, local;
    r.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'audio') out = s;
      if (s.type === 'inbound-rtp' && s.kind === 'audio') inn = s;
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = r.get(s.selectedCandidatePairId);
    });
    if (!pair) r.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    if (pair) local = r.get(pair.localCandidateId);
    const prev = p.stats.raw, dt = prev ? (now - prev.t) / 1000 : 0;
    // "wire" estimate: payload + RTP header + IPv4/UDP (28) + SRTP tag (10) per packet
    const wire = (o, b, h, n) => (o ? (o[b] ?? 0) + (o[h] ?? 0) + (o[n] ?? 0) * 38 : 0);
    const cur = {
      t: now,
      tx: wire(out, 'bytesSent', 'headerBytesSent', 'packetsSent'), txp: out?.packetsSent ?? 0,
      rx: wire(inn, 'bytesReceived', 'headerBytesReceived', 'packetsReceived'), rxp: inn?.packetsReceived ?? 0,
    };
    p.stats = {
      raw: cur,
      route: local ? (local.candidateType === 'relay' ? 'TURN relay' : local.candidateType === 'host' ? 'direct (LAN)' : 'direct (P2P)') : '—',
      rtt: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      txKbps: dt ? ((cur.tx - prev.tx) * 8) / dt / 1000 : 0, txPps: dt ? (cur.txp - prev.txp) / dt : 0,
      rxKbps: dt ? ((cur.rx - prev.rx) * 8) / dt / 1000 : 0, rxPps: dt ? (cur.rxp - prev.rxp) / dt : 0,
      totalBytes: cur.tx + cur.rx,
    };
  }

  get myFingerprint() { return bytesToHex(this.identity.pk).slice(0, 16); }
}
