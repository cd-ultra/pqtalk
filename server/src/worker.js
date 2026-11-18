// PQTalk mailbox server. It stores and forwards ciphertext only:
//  * Mailbox  – one Durable Object per device mailbox: owner key, published prekey bundle,
//               queued encrypted messages, live WebSocket push.
//  * Blob     – one Durable Object per encrypted attachment (write-once, expires).
//  * Room     – pub/sub relay for live voice-room signaling (already encrypted end to end).
// The server never sees names, contacts, message contents, attachment keys or who sent a
// message (the sender is only inside the encryption, like Signal's sealed sender).
import { DurableObject } from 'cloudflare:workers';
import { ed25519 } from '@noble/curves/ed25519.js';

const MAX_MSG = 64 * 1024;
const MAX_QUEUE = 5000;
const MAX_BLOB = 2 * 1024 * 1024 - 1024;
const MSG_TTL = 30 * 864e5;
const BLOB_TTL = 30 * 864e5;
const MAX_OPKS = 200;
const SKEW = 5 * 60_000;
const HEX32 = /^[0-9a-f]{32}$/;
const TURN_TTL = 6 * 3600; // seconds a TURN credential stays valid
const TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-auth',
  'access-control-max-age': '86400',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'content-type': 'application/json' } });
const err = (status, message) => json({ error: message }, status);

const b64d = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));

/** Verify an owner signature: x-auth = "<ts>.<sig b64url>" over "METHOD PATH TS SHA256(body)". */
async function verifyAuth(auth, method, path, body, ik) {
  if (!auth || !ik) return false;
  const [ts, sig] = auth.split('.');
  if (!ts || !sig || Math.abs(Date.now() - Number(ts)) > SKEW) return false;
  const msg = new TextEncoder().encode(`${method} ${path} ${ts} ${await sha256hex(body)}`);
  try { return ed25519.verify(b64d(sig), msg, b64d(ik)); } catch { return false; }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean); // v1, kind, id, ...
    if (url.pathname === '/v1/turn/status') return json({ configured: !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) });
    if (parts[0] !== 'v1' || !HEX32.test(parts[2] ?? '')) {
      return url.pathname === '/' ? new Response('PQTalk mailbox server', { headers: CORS }) : err(404, 'not found');
    }
    const ns = { mb: env.MAILBOX, blob: env.BLOB, room: env.ROOM }[parts[1]];
    if (!ns) return err(404, 'not found');
    const res = await ns.get(ns.idFromName(parts[2])).fetch(req);
    if (res.webSocket) return res;
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
};

export class Mailbox extends DurableObject {
  async fetch(req) {
    const url = new URL(req.url);
    const [, , , action = ''] = url.pathname.split('/').filter(Boolean);
    const body = new Uint8Array(await req.arrayBuffer());
    const owner = await this.ctx.storage.get('ik');
    const authed = () => verifyAuth(req.headers.get('x-auth'), req.method, url.pathname, body, owner);
    const route = `${req.method} ${action}`;

    if (route === 'PUT ') { // register: claim this mailbox for an identity key (proof of possession)
      const { ik } = JSON.parse(new TextDecoder().decode(body));
      if (owner && owner !== ik) return err(409, 'mailbox taken');
      if (!(await verifyAuth(req.headers.get('x-auth'), req.method, url.pathname, body, ik))) return err(401, 'bad signature');
      await this.ctx.storage.put('ik', ik);
      return json({ ok: true });
    }
    if (!owner) return err(404, 'no such mailbox');

    switch (route) {
      case 'PUT keys': { // publish signed prekey bundle (+ optional extra one-time prekeys)
        if (!(await authed())) return err(401, 'bad signature');
        const { bundle, opks = [] } = JSON.parse(new TextDecoder().decode(body));
        if (bundle) await this.ctx.storage.put('bundle', bundle);
        const count = (await this.ctx.storage.list({ prefix: 'opk:' })).size;
        const room = Math.max(0, MAX_OPKS - count);
        const add = {};
        for (const k of opks.slice(0, room)) if (k?.id && k?.pub) add[`opk:${String(k.id).padStart(10, '0')}`] = k;
        for (let i = 0; i < Object.keys(add).length; i += 100) {
          await this.ctx.storage.put(Object.fromEntries(Object.entries(add).slice(i, i + 100)));
        }
        return json({ ok: true, opks: count + Object.keys(add).length });
      }
      case 'GET bundle': { // anyone may fetch; one one-time prekey is handed out and deleted
        const bundle = await this.ctx.storage.get('bundle');
        if (!bundle) return err(404, 'no keys published');
        const first = await this.ctx.storage.list({ prefix: 'opk:', limit: 1 });
        let opk = null;
        for (const [k, v] of first) { opk = v; await this.ctx.storage.delete(k); }
        return json({ ik: owner, bundle, opk });
      }
      case 'POST msg': { // anyone may deposit ciphertext; ?eph=1 means deliver live only, never store
        if (!body.length || body.length > MAX_MSG) return err(413, 'message size');
        const eph = url.searchParams.get('eph') === '1';
        const data = new TextDecoder().decode(body);
        const ts = Date.now();
        if (eph) {
          const n = this._push({ t: 'eph', ts, data });
          return json({ ok: true, delivered: n > 0 });
        }
        const seq = ((await this.ctx.storage.get('seq')) ?? 0) + 1;
        const count = (await this.ctx.storage.get('count')) ?? 0;
        if (count >= MAX_QUEUE) return err(507, 'mailbox full');
        const id = `${String(seq).padStart(12, '0')}`;
        await this.ctx.storage.put({ seq, count: count + 1, [`m:${id}`]: { id, ts, data } });
        if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(ts + 864e5);
        this._push({ t: 'msg', id, ts, data });
        return json({ ok: true, id });
      }
      case 'GET msgs': {
        if (!(await authed())) return err(401, 'bad signature');
        const list = await this.ctx.storage.list({ prefix: 'm:', limit: 200 });
        const opks = (await this.ctx.storage.list({ prefix: 'opk:' })).size;
        return json({ msgs: [...list.values()], opks });
      }
      case 'POST ack': {
        if (!(await authed())) return err(401, 'bad signature');
        const { ids = [] } = JSON.parse(new TextDecoder().decode(body));
        const keys = ids.slice(0, 500).map((i) => `m:${i}`);
        const n = keys.length ? await this.ctx.storage.delete(keys) : 0;
        const count = Math.max(0, ((await this.ctx.storage.get('count')) ?? 0) - n);
        await this.ctx.storage.put('count', count);
        return json({ ok: true, deleted: n });
      }
      case 'POST turn': { // short-lived Cloudflare TURN credentials, only for registered mailbox owners
        if (!(await authed())) return err(401, 'bad signature');
        return this._turn();
      }
      case 'GET ws': { // browsers can't set headers on WebSockets, so auth rides in the query
        const auth = url.searchParams.get('auth');
        if (!(await verifyAuth(auth, 'WS', url.pathname, new Uint8Array(), owner))) return err(401, 'bad signature');
        if (req.headers.get('upgrade') !== 'websocket') return err(426, 'websocket required');
        const { 0: client, 1: server } = new WebSocketPair();
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }
    }
    return err(404, 'not found');
  }

  // One credential per mailbox, reused until an hour before it expires, so a client can't
  // mint credentials in a loop. The TURN API token never leaves Cloudflare.
  async _turn() {
    const { TURN_KEY_ID: id, TURN_KEY_API_TOKEN: token } = this.env;
    if (!id || !token) return err(503, 'turn not configured');
    const cached = await this.ctx.storage.get('turn');
    if (cached && cached.exp - Date.now() > 3600_000) return json({ iceServers: cached.iceServers });
    const r = await fetch(`${this.env.TURN_API || TURN_API}/${id}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL }),
    });
    if (!r.ok) return err(502, `turn provider ${r.status}`);
    const { iceServers = [] } = await r.json();
    // Browsers block port 53, and a TURN URL on it only stalls connection setup until it times out.
    const clean = (Array.isArray(iceServers) ? iceServers : [iceServers]).map((s) => ({
      ...s, urls: [].concat(s.urls ?? []).filter((u) => !/:53(\?|$)/.test(u)),
    })).filter((s) => s.urls.length);
    await this.ctx.storage.put('turn', { iceServers: clean, exp: Date.now() + TURN_TTL * 1000 });
    return json({ iceServers: clean });
  }

  _push(obj) {
    const s = JSON.stringify(obj);
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); n++; } catch {} }
    return n;
  }
  webSocketMessage(ws, m) { if (m === 'ping') ws.send('pong'); }
  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch {} }

  async alarm() { // expire undelivered messages after 30 days
    const cutoff = Date.now() - MSG_TTL;
    const old = [];
    for (const [k, v] of await this.ctx.storage.list({ prefix: 'm:', limit: 1000 })) { if (v.ts < cutoff) old.push(k); else break; }
    if (old.length) {
      for (let i = 0; i < old.length; i += 128) await this.ctx.storage.delete(old.slice(i, i + 128));
      await this.ctx.storage.put('count', Math.max(0, ((await this.ctx.storage.get('count')) ?? 0) - old.length));
    }
    if ((await this.ctx.storage.get('count')) > 0) await this.ctx.storage.setAlarm(Date.now() + 864e5);
  }
}

export class Blob extends DurableObject {
  async fetch(req) {
    if (req.method === 'PUT') {
      if (await this.ctx.storage.get('data')) return err(409, 'exists');
      const len = Number(req.headers.get('content-length') ?? 0);
      if (len > MAX_BLOB) return err(413, 'too large');
      const data = await req.arrayBuffer();
      if (!data.byteLength || data.byteLength > MAX_BLOB) return err(413, 'too large');
      await this.ctx.storage.put('data', data);
      await this.ctx.storage.setAlarm(Date.now() + BLOB_TTL);
      return json({ ok: true });
    }
    if (req.method === 'GET') {
      const data = await this.ctx.storage.get('data');
      return data ? new Response(data, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=86400' } }) : err(404, 'not found');
    }
    return err(405, 'method');
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

// Live voice-room signaling relay (replaces public MQTT brokers). Payloads are already
// AES-GCM encrypted under the room key; this just fans messages out by topic.
export class Room extends DurableObject {
  async fetch(req) {
    if (req.headers.get('upgrade') !== 'websocket') return err(426, 'websocket required');
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ topics: [] });
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, raw) {
    if (raw === 'ping') return ws.send('pong');
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (typeof m.s === 'string' && m.s.length < 200) {
      const a = ws.deserializeAttachment() ?? { topics: [] };
      if (!a.topics.includes(m.s) && a.topics.length < 8) a.topics.push(m.s);
      ws.serializeAttachment(a);
    } else if (typeof m.p === 'string' && typeof m.d === 'string' && m.d.length < 64 * 1024) {
      const out = JSON.stringify({ topic: m.p, data: m.d });
      for (const peer of this.ctx.getWebSockets()) {
        if ((peer.deserializeAttachment()?.topics ?? []).includes(m.p)) { try { peer.send(out); } catch {} }
      }
    }
  }
  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch {} }
}
