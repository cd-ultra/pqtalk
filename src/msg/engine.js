// The messenger: accounts, prekeys, sessions, contacts, groups, messages, receipts, attachments
// and call signaling. All ratchet updates run through one serial queue so state never forks.
import { makeIdentity, safetyNumber } from '../crypto/identity.js';
import { newIdentityDH, newSignedPrekeys, newOneTimePrekeys, publicBundle, initiate, respond } from '../crypto/pqxdh.js';
import { initAlice, initBob, encrypt, decrypt } from '../crypto/ratchet.js';
import { codeFromBytes } from '../crypto/code.js';
import { kdf, sha256, randomBytes, randomId, b64, unb64, bytesToHex, hexToBytes, utf8, concatBytes } from '../crypto/prim.js';
import { gcm } from '@noble/ciphers/aes.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import * as db from './store.js';
import { Api } from './api.js';

const WEEK = 7 * 864e5, MONTH = 30 * 864e5;
const OPK_BATCH = 75, OPK_LOW = 25;
const now = () => Date.now();

export class Messenger extends EventTarget {
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // ---------------- account ----------------
  static async hasAccount() { return !!(await db.get('kv', 'account')); }

  async create({ name, server }) {
    const account = { sk: b64(ed25519.utils.randomSecretKey()), mailbox: randomId(16), name, server, created: now() };
    await db.put('kv', account, 'account');
    await this.start();
  }

  async start() {
    this.account = await db.get('kv', 'account');
    if (!this.account) throw new Error('no account');
    this.identity = makeIdentity(unb64(this.account.sk));
    this.myId = bytesToHex(this.identity.pk);
    this.api = new Api(this.account.server, this.identity, this.account.mailbox);
    this.chain = Promise.resolve();
    await this.api.register();
    await this._maintainKeys();
    this.sock = this.api.connect((m) => this._onPush(m), (up) => { this.online = up; this.emit('net', up); if (up) this.sync(); });
    this.outboxTimer = setInterval(() => this._flushOutbox(), 15_000);
    await this.sync();
  }

  stop() { this.sock?.close(); clearInterval(this.outboxTimer); }

  async setName(name) {
    this.account.name = name; await db.put('kv', this.account, 'account');
    for (const c of await db.all('contacts')) this._send(c, { t: 'profile', name }).catch(() => {});
  }

  run(fn) { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }

  // ---------------- prekeys ----------------
  async _maintainKeys(opksOnServer) {
    let keys = await db.get('kv', 'keys');
    let publish = false, newOpks = [];
    if (!keys) {
      keys = { ikx: newIdentityDH(this.identity), ...newSignedPrekeys(this.identity), old: [], opks: {}, nextOpk: 1 };
      publish = true; opksOnServer = 0;
    }
    if (now() - keys.spk.ts > WEEK) {
      keys.old.push({ spk: keys.spk, pqspk: keys.pqspk });
      Object.assign(keys, newSignedPrekeys(this.identity));
      publish = true;
    }
    keys.old = keys.old.filter((o) => now() - o.spk.ts < MONTH + WEEK);
    if (opksOnServer !== undefined && opksOnServer < OPK_LOW) {
      newOpks = newOneTimePrekeys(keys.nextOpk, OPK_BATCH);
      keys.nextOpk += OPK_BATCH;
      for (const o of newOpks) keys.opks[o.id] = o;
    }
    if (publish || newOpks.length) {
      await db.put('kv', keys, 'keys');
      await this.api.publishKeys(publishBundleIf(publish, keys), newOpks.map(({ id, pub }) => ({ id, pub })));
    }
    this.keys = keys;
  }

  _lookup() {
    const k = this.keys;
    const find = (kind) => (id) => (k[kind].id === id ? k[kind] : k.old.find((o) => o[kind].id === id)?.[kind]);
    return { spk: find('spk'), pqspk: find('pqspk'), opk: (id) => k.opks[id] };
  }

  // ---------------- invites ----------------
  async myInvite(reset = false) {
    let inv = await db.get('kv', 'invite');
    if (!inv || reset) {
      const secret = randomBytes(32);
      inv = { secret: b64(secret), id: bytesToHex(sha256(secret)).slice(0, 16), created: now() };
      await db.put('kv', inv, 'invite');
    }
    const raw = concatBytes(hexToBytes(this.account.mailbox), this.identity.pk, unb64(inv.secret));
    const p = new URLSearchParams({ i: b64(raw) });
    if (this.account.server !== this.defaultServer) p.set('s', this.account.server);
    return `${location.origin}${location.pathname}#${p}`;
  }

  static parseInvite(link) {
    const hash = String(link).includes('#') ? String(link).split('#')[1] : String(link);
    const p = new URLSearchParams(hash);
    const raw = unb64(p.get('i') ?? '');
    if (raw.length !== 80) throw new Error('That isn’t a valid invite link.');
    const secret = raw.slice(48);
    return { mb: bytesToHex(raw.slice(0, 16)), ik: raw.slice(16, 48), secret, inviteId: bytesToHex(sha256(secret)).slice(0, 16), server: p.get('s') };
  }

  async acceptInvite(link) {
    const inv = Messenger.parseInvite(link);
    if (inv.server && inv.server.replace(/\/+$/, '') !== this.account.server.replace(/\/+$/, '')) throw new Error('This invite is for a different server.');
    const id = bytesToHex(inv.ik);
    if (id === this.myId) throw new Error('That’s your own invite link.');
    return this.run(async () => {
      let c = await db.get('contacts', id);
      if (!c) {
        c = { id, ik: b64(inv.ik), mb: inv.mb, name: 'New contact', verified: false, created: now(),
              intro: { pskId: `i:${inv.inviteId}`, psk: b64(inv.secret) }, voice: b64(randomBytes(32)), helloSent: true };
        await db.put('contacts', c);
      }
      await this._ensureConv(id, 'direct');
      await this._sendLocked(c, { t: 'hello', name: this.account.name, voice: c.voice });
      this.emit('change');
      return id;
    });
  }

  // ---------------- sessions ----------------
  async _ensureSession(c) {
    if (c.sendSid && (await db.get('sessions', c.sendSid))) return db.get('sessions', c.sendSid);
    if (!c.intro) throw new Error(`No way to reach ${c.name} yet`);
    const { ik, bundle, opk } = await this.api.fetchBundle(c.mb);
    if (ik !== c.ik) throw new Error('Mailbox belongs to someone else');
    const x = initiate({ identity: this.identity, ikx: this.keys.ikx }, { ik: c.ik, bundle, opk }, unb64(c.intro.psk), c.intro.pskId);
    const s = { sid: randomId(16), contact: c.id, state: initAlice(x.sk, x.ad, x.theirSpk, x.theirPq), pre: x.pre, created: now() };
    await db.put('sessions', s);
    c.sendSid = s.sid; await db.put('contacts', c);
    return s;
  }

  async _encryptFor(c, payload) {
    const s = await this._ensureSession(c);
    const inner = { p: payload };
    if (s.pre) inner.intro = { name: this.account.name, mb: this.account.mailbox };
    const r = encrypt(s.state, JSON.stringify(inner));
    s.state = r.state; await db.put('sessions', s);
    return { v: 2, sid: s.sid, ...(s.pre ? { pre: s.pre } : {}), h: r.msg.h, c: r.msg.c };
  }

  /** Encrypt under the queue lock, then post outside it (network never blocks the ratchet queue). */
  async _send(c, payload, opts) {
    const env = await this.run(() => this._encryptFor(c, payload));
    return this._post(c, env, payload, opts);
  }
  /** For code already running inside the queue. */
  async _sendLocked(c, payload, opts) {
    const env = await this._encryptFor(c, payload);
    this._post(c, env, payload, opts).catch(() => {});
  }
  async _post(c, env, payload, { eph = false, keepalive = false } = {}) {
    try { return await this.api.send(c.mb, env, { eph, keepalive }); }
    catch (e) {
      if (eph || e.status) throw e; // ephemeral or rejected: don't retry
      await db.put('outbox', { id: randomId(8), mb: c.mb, env, msgId: payload.id, ts: now() });
      return { queued: true };
    }
  }

  async _flushOutbox() {
    for (const o of await db.all('outbox')) {
      try { await this.api.send(o.mb, o.env); await db.del('outbox', o.id); if (o.msgId) await this._setStatus(o.msgId, null, 'sent'); }
      catch (e) { if (e.status || now() - o.ts > MONTH) await db.del('outbox', o.id); }
    }
  }

  // ---------------- receiving ----------------
  _onPush(m) {
    if (m.t === 'eph') this.run(() => this._receive(m.data, true));
    else this.run(async () => { await this._receive(m.data); await this.api.ack([m.id]).catch(() => {}); });
  }

  async sync() {
    if (this.syncing) return; this.syncing = true;
    try {
      for (let round = 0; round < 20; round++) {
        const { msgs, opks } = await this.api.fetchMessages();
        await this.run(() => this._maintainKeys(opks));
        if (!msgs.length) break;
        await this.run(async () => { for (const m of msgs) await this._receive(m.data); });
        await this.api.ack(msgs.map((m) => m.id));
        if (msgs.length < 200) break;
      }
      await this._flushOutbox();
    } catch (e) { this.emit('error', e.message); }
    finally { this.syncing = false; }
  }

  async _receive(data, eph = false) {
    let env; try { env = JSON.parse(data); } catch { return; }
    if (env?.v !== 2 || typeof env.sid !== 'string') return;
    try {
      let s = await db.get('sessions', env.sid), fresh = null;
      if (!s) {
        if (!env.pre) return;
        const psk = await this._pskFor(env.pre.psk);
        if (!psk) { if (String(env.pre.psk).startsWith('g:')) await this._park({ raw: data }); return; }
        const r = respond({ identity: this.identity }, this.keys, this._lookup(), env.pre, psk);
        s = { sid: env.sid, contact: bytesToHex(r.ikA), state: initBob(r.sk, r.ad, r.spk, r.pqspk), pre: null, created: now() };
        fresh = { psk: b64(psk), pskId: env.pre.psk, opk: env.pre.opk, ik: env.pre.ik };
      }
      const d = decrypt(s.state, { h: env.h, c: env.c });
      const inner = JSON.parse(d.plaintext);
      s.state = d.state; s.pre = null; s.lastRecv = now();
      let c = await db.get('contacts', s.contact);
      if (fresh) {
        if (fresh.opk != null) { delete this.keys.opks[fresh.opk]; await db.put('kv', this.keys, 'keys'); }
        if (!inner.intro?.mb) return;
        if (!c) {
          c = { id: s.contact, ik: fresh.ik, mb: inner.intro.mb, name: inner.intro.name || 'Unknown', verified: false, created: now(),
                intro: { pskId: fresh.pskId, psk: fresh.psk } };
          if (fresh.pskId.startsWith('i:')) await this._ensureConv(c.id, 'direct');
        }
      }
      if (!c) return;
      if (inner.intro?.mb) c.mb = inner.intro.mb;
      if (inner.intro?.name && (c.name === 'New contact' || c.name === 'Unknown')) c.name = inner.intro.name;
      c.sendSid = s.sid;
      await db.put('sessions', s);
      await db.put('contacts', c);
      await this._handle(c, inner.p ?? {}, eph);
    } catch (e) {
      this.emit('log', `drop message: ${e.message}`);
    }
  }

  async _pskFor(pskId) {
    if (typeof pskId !== 'string') return null;
    if (pskId.startsWith('i:')) {
      const inv = await db.get('kv', 'invite');
      return inv && pskId === `i:${inv.id}` ? unb64(inv.secret) : null;
    }
    if (pskId.startsWith('g:')) {
      const g = await db.get('convs', pskId);
      return g?.secret ? unb64(g.secret) : null;
    }
    return null;
  }

  async _handle(c, p, eph) {
    const conv = p.g ? `g:${p.g}` : c.id;
    switch (p.t) {
      case 'hello':
        if (p.name) c.name = p.name;
        if (p.voice) c.voice = !c.voice || p.voice < c.voice ? p.voice : c.voice;
        if (!c.helloSent) { c.helloSent = true; await this._sendLocked(c, { t: 'hello', name: this.account.name, voice: c.voice }).catch(() => {}); }
        await db.put('contacts', c);
        await this._ensureConv(c.id, 'direct');
        this.emit('change');
        break;
      case 'profile': if (p.name) { c.name = String(p.name).slice(0, 40); await db.put('contacts', c); this.emit('change'); } break;
      case 'text': case 'att': {
        if (p.g) {
          const g = await db.get('convs', conv);
          if (!g) return this._park({ cid: c.id, p });
          if (!g.members.includes(c.id)) return;
        }
        if (!p.g) await this._ensureConv(c.id, 'direct');
        if (await db.get('messages', p.id)) return;
        const m = { id: p.id, conv, ts: Math.min(p.ts ?? now(), now()), rx: now(), from: c.id, kind: p.t, body: String(p.body ?? '').slice(0, 8000),
                    att: p.att ?? null, status: 'received' };
        await db.put('messages', m);
        await this._bumpConv(conv, m, true);
        await this._sendLocked(c, { t: 'receipt', kind: 'delivered', ids: [p.id] }).catch(() => {});
        this.emit('message', m);
        break;
      }
      case 'receipt': for (const id of (p.ids ?? []).slice(0, 500)) await this._setStatus(id, c.id, p.kind); break;
      case 'typing': this.emit('typing', { conv, from: c.id, on: !!p.on }); break;
      case 'group': await this._onGroup(c, p); break;
      case 'call': this.emit('call', { conv, from: c.id, ...p }); break;
    }
  }

  // ---------------- conversations & messages ----------------
  async _ensureConv(id, type, extra = {}) {
    let v = await db.get('convs', id);
    if (!v) { v = { id, type, lastTs: now(), lastText: '', unread: 0, ...extra }; await db.put('convs', v); }
    return v;
  }

  async _bumpConv(id, m, incoming) {
    const v = await db.get('convs', id); if (!v) return;
    v.lastTs = m.ts; v.lastText = m.kind === 'att' ? (m.body || (m.att?.kind === 'voice' ? 'Voice message' : 'Photo')) : m.body;
    v.lastFrom = m.from;
    if (incoming && this.openConv !== id) v.unread = (v.unread ?? 0) + 1;
    await db.put('convs', v);
    this.emit('change');
  }

  async _setStatus(id, who, kind) {
    const m = await db.get('messages', id);
    if (!m || m.from !== 'me') return;
    const rank = { failed: -1, sending: 0, sent: 1, delivered: 2, read: 3 };
    let next = m.status;
    if (!who) { if (m.status === 'sending' || m.status === 'failed') next = 'sent'; }
    else {
      m.rcpt ??= {};
      if ((rank[kind] ?? 0) > (rank[m.rcpt[who]] ?? 1)) m.rcpt[who] = kind;
      const vals = (m.to?.length ? m.to : [who]).map((r) => m.rcpt[r]);
      next = vals.every((v) => v === 'read') ? 'read' : vals.every((v) => v === 'read' || v === 'delivered') ? 'delivered' : m.status;
    }
    if ((rank[next] ?? 0) >= (rank[m.status] ?? 0)) m.status = next;
    await db.put('messages', m);
    this.emit('status', m);
  }

  async recipients(convId) {
    const v = await db.get('convs', convId);
    const ids = v?.type === 'group' ? v.members : [convId];
    return (await Promise.all(ids.map((i) => db.get('contacts', i)))).filter(Boolean);
  }

  async sendText(convId, body) { return this._sendMessage(convId, { t: 'text', body }); }

  async _sendMessage(convId, extra, att = null) {
    const v = await db.get('convs', convId);
    const rcpts = await this.recipients(convId);
    const m = { id: randomId(12), conv: convId, ts: now(), from: 'me', kind: extra.t, body: extra.body ?? '', att, status: 'sending', to: rcpts.map((c) => c.id), rcpt: {} };
    await db.put('messages', m);
    await this._bumpConv(convId, m, false);
    this.emit('message', m);
    const payload = { ...extra, id: m.id, ts: m.ts, ...(v?.type === 'group' ? { g: convId.slice(2) } : {}) };
    let failed = 0;
    for (const c of rcpts) {
      try { await this._send(c, payload); } catch (e) { failed++; this.emit('log', `send to ${c.name}: ${e.message}`); }
    }
    m.status = failed && failed === rcpts.length ? 'failed' : 'sent';
    if (!rcpts.length) m.status = 'sent';
    const cur = await db.get('messages', m.id);
    if (cur.status === 'sending') { cur.status = m.status; await db.put('messages', cur); }
    this.emit('status', cur);
    return cur;
  }

  async markRead(convId) {
    const v = await db.get('convs', convId);
    if (v?.unread) { v.unread = 0; await db.put('convs', v); this.emit('change'); }
    const unread = (await db.messagesFor(convId)).filter((m) => m.from !== 'me' && !m.readSent);
    const bySender = new Map();
    for (const m of unread) { m.readSent = true; await db.put('messages', m); bySender.set(m.from, [...(bySender.get(m.from) ?? []), m.id]); }
    for (const [id, ids] of bySender) { const c = await db.get('contacts', id); if (c) this._send(c, { t: 'receipt', kind: 'read', ids }).catch(() => {}); }
  }

  async typing(convId, on) {
    const v = await db.get('convs', convId);
    for (const c of await this.recipients(convId)) this._send(c, { t: 'typing', on, ...(v?.type === 'group' ? { g: convId.slice(2) } : {}) }, { eph: true }).catch(() => {});
  }

  // ---------------- attachments ----------------
  async sendAttachment(convId, { bytes, mime, kind, meta = {}, caption = '' }) {
    const key = randomBytes(32), iv = randomBytes(12), id = randomId(16);
    const ct = gcm(key, iv).encrypt(bytes);
    await this.api.putBlob(id, ct);
    await db.put('blobs', new Blob([bytes], { type: mime }), id);
    const att = { id, key: b64(key), iv: b64(iv), size: bytes.length, mime, kind, ...meta };
    return this._sendMessage(convId, { t: 'att', att, body: caption }, att);
  }

  async attachment(att) {
    const cached = await db.get('blobs', att.id);
    if (cached) return cached;
    const ct = await this.api.getBlob(att.id);
    const pt = gcm(unb64(att.key), unb64(att.iv)).decrypt(ct);
    const blob = new Blob([pt], { type: att.mime });
    await db.put('blobs', blob, att.id);
    return blob;
  }

  // ---------------- groups ----------------
  async createGroup(name, memberIds) {
    const gid = randomId(16);
    const v = { id: `g:${gid}`, type: 'group', name, members: memberIds, secret: b64(randomBytes(32)), lastTs: now(), lastText: 'Group created', unread: 0, admin: this.myId };
    await db.put('convs', v);
    await this._broadcastGroup(v);
    this.emit('change');
    return v.id;
  }

  async addToGroup(convId, ids) {
    const v = await db.get('convs', convId);
    v.members = [...new Set([...v.members, ...ids])];
    await db.put('convs', v);
    await this._broadcastGroup(v);
    this.emit('change');
  }

  async renameGroup(convId, name) {
    const v = await db.get('convs', convId); v.name = name; await db.put('convs', v);
    await this._broadcastGroup(v); this.emit('change');
  }

  async leaveGroup(convId) {
    const v = await db.get('convs', convId);
    for (const c of await this.recipients(convId)) this._send(c, { t: 'group', op: 'leave', gid: convId.slice(2) }).catch(() => {});
    v.left = true; v.members = []; await db.put('convs', v); this.emit('change');
  }

  async _broadcastGroup(v) {
    const roster = [{ ik: b64(this.identity.pk), mb: this.account.mailbox, name: this.account.name }];
    for (const c of await this.recipients(v.id)) roster.push({ ik: c.ik, mb: c.mb, name: c.name });
    const payload = { t: 'group', op: 'state', gid: v.id.slice(2), name: v.name, secret: v.secret, members: roster };
    for (const c of await this.recipients(v.id)) await this._send(c, payload).catch((e) => this.emit('log', `group to ${c.name}: ${e.message}`));
  }

  async _onGroup(from, p) {
    const id = `g:${p.gid}`;
    let v = await db.get('convs', id);
    if (p.op === 'leave') {
      if (v) { v.members = v.members.filter((m) => m !== from.id); await db.put('convs', v); await this._system(id, `${from.name} left the group`); }
      return;
    }
    if (p.op !== 'state' || !Array.isArray(p.members)) return;
    if (v && !v.members.includes(from.id)) return; // only members may change a group
    const members = [];
    for (const m of p.members.slice(0, 64)) {
      const mid = bytesToHex(unb64(m.ik));
      if (mid === this.myId) continue;
      members.push(mid);
      let c = await db.get('contacts', mid);
      if (!c) {
        c = { id: mid, ik: m.ik, mb: m.mb, name: String(m.name || 'Member').slice(0, 40), verified: false, created: now(), intro: { pskId: id, psk: p.secret }, viaGroup: true };
        await db.put('contacts', c);
      }
    }
    const isNew = !v;
    const renamed = v && v.name !== p.name;
    v = { ...(v ?? { id, type: 'group', lastTs: now(), lastText: '', unread: 0 }), name: String(p.name).slice(0, 60), members, secret: p.secret, left: false };
    await db.put('convs', v);
    if (isNew) { await this._system(id, `${from.name} added you to the group`); await this._unpark(); }
    else if (renamed) await this._system(id, `${from.name} renamed the group to “${v.name}”`);
    this.emit('change');
  }

  // Messages that arrive before the group they belong to are parked and replayed once it exists.
  async _park(item) {
    const q = (await db.get('kv', 'parked')) ?? [];
    q.push({ ...item, ts: now() });
    await db.put('kv', q.filter((x) => now() - x.ts < WEEK).slice(-200), 'parked');
  }
  async _unpark() {
    const q = (await db.get('kv', 'parked')) ?? [];
    if (!q.length) return;
    await db.put('kv', [], 'parked');
    for (const x of q) {
      if (x.raw) await this._receive(x.raw);
      else { const c = await db.get('contacts', x.cid); if (c) await this._handle(c, x.p, false); }
    }
  }

  async _system(conv, text) {
    const m = { id: randomId(12), conv, ts: now(), from: 'system', kind: 'system', body: text, status: 'received' };
    await db.put('messages', m); await this._bumpConv(conv, m, false); this.emit('message', m);
  }

  // ---------------- calls & walkie-talkie ----------------
  async voiceCode(convId, callId) {
    const v = await db.get('convs', convId);
    let secret;
    if (v?.type === 'group') secret = v.secret;
    else secret = (await db.get('contacts', convId))?.voice;
    if (!secret) throw new Error('Voice isn’t set up for this chat yet');
    return codeFromBytes(kdf(unb64(secret), null, `voice-room ${callId}`, 20));
  }

  async callSignal(convId, op, extra = {}, opts = {}) {
    const v = await db.get('convs', convId);
    const payload = { t: 'call', op, ...extra, ...(v?.type === 'group' ? { g: convId.slice(2) } : {}) };
    for (const c of await this.recipients(convId)) this._send(c, payload, opts).catch(() => {});
  }

  // ---------------- queries ----------------
  contact(id) { return id ? db.get('contacts', id) : Promise.resolve(undefined); }
  contacts() { return db.all('contacts'); }
  conv(id) { return id ? db.get('convs', id) : Promise.resolve(undefined); }
  async convs() { return (await db.all('convs')).sort((a, b) => b.lastTs - a.lastTs); }
  messages(id) { return db.messagesFor(id); }
  safety(c) { return safetyNumber(this.identity.pk, unb64(c.ik)); }
  async setVerified(id, on) { const c = await db.get('contacts', id); c.verified = on; await db.put('contacts', c); this.emit('change'); }
  async convTitle(v) {
    if (v.type === 'group') return v.name;
    return (await db.get('contacts', v.id))?.name ?? 'Unknown';
  }
}

function publishBundleIf(publish, keys) { return publish ? publicBundle(keys) : undefined; }
