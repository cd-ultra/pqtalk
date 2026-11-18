// Client for the mailbox server. Owner requests are signed with the device's Ed25519 key.
import { sha256, bytesToHex, b64, utf8 } from '../crypto/prim.js';

export class Api {
  constructor(base, identity, mailbox) {
    this.base = base.replace(/\/+$/, '');
    this.identity = identity;
    this.mailbox = mailbox;
  }
  _sign(method, path, body) {
    const ts = Date.now();
    const bodyHash = bytesToHex(sha256(body));
    return `${ts}.${b64(this.identity.sign(utf8(`${method} ${path} ${ts} ${bodyHash}`)))}`;
  }
  async _req(method, path, obj, { signed = false, raw } = {}) {
    const body = raw ?? (obj === undefined ? new Uint8Array() : utf8(JSON.stringify(obj)));
    const headers = {};
    if (!raw && obj !== undefined) headers['content-type'] = 'application/json';
    if (signed) headers['x-auth'] = this._sign(method, path, body);
    const r = await fetch(this.base + path, { method, headers, body: method === 'GET' ? undefined : body, referrerPolicy: 'no-referrer' });
    if (!r.ok) {
      let msg = `${r.status}`; try { msg = (await r.json()).error ?? msg; } catch {}
      const e = new Error(`Server: ${msg}`); e.status = r.status; throw e;
    }
    return r.headers.get('content-type')?.includes('json') ? r.json() : new Uint8Array(await r.arrayBuffer());
  }

  register() { return this._req('PUT', `/v1/mb/${this.mailbox}`, { ik: b64(this.identity.pk) }, { signed: true }); }
  publishKeys(bundle, opks) { return this._req('PUT', `/v1/mb/${this.mailbox}/keys`, { bundle, opks }, { signed: true }); }
  fetchBundle(mb) { return this._req('GET', `/v1/mb/${mb}/bundle`); }
  send(mb, envelope, { eph = false } = {}) {
    return this._req('POST', `/v1/mb/${mb}/msg${eph ? '?eph=1' : ''}`, undefined, { raw: utf8(JSON.stringify(envelope)) });
  }
  fetchMessages() { return this._req('GET', `/v1/mb/${this.mailbox}/msgs`, undefined, { signed: true }); }
  ack(ids) { return this._req('POST', `/v1/mb/${this.mailbox}/ack`, { ids }, { signed: true }); }
  turn() { return this._req('POST', `/v1/mb/${this.mailbox}/turn`, {}, { signed: true }); }
  putBlob(id, bytes) { return this._req('PUT', `/v1/blob/${id}`, undefined, { raw: bytes }); }
  getBlob(id) { return this._req('GET', `/v1/blob/${id}`); }

  /** Live push. Calls onMsg({t:'msg'|'eph', id?, data}); reconnects with backoff. */
  connect(onMsg, onState) {
    let closed = false, ws, delay = 1000, pingT;
    const open = () => {
      const path = `/v1/mb/${this.mailbox}/ws`;
      const auth = this._sign('WS', path, new Uint8Array());
      ws = new WebSocket(`${this.base.replace(/^http/, 'ws')}${path}?auth=${encodeURIComponent(auth)}`);
      ws.onopen = () => { delay = 1000; onState?.(true); pingT = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25_000); };
      ws.onmessage = (e) => { if (e.data !== 'pong') { try { onMsg(JSON.parse(e.data)); } catch {} } };
      ws.onclose = () => {
        clearInterval(pingT); onState?.(false);
        if (!closed) setTimeout(open, delay), (delay = Math.min(delay * 2, 30_000));
      };
    };
    open();
    return { close: () => { closed = true; ws?.close(); }, reconnectNow: () => { if (ws?.readyState > 1) { delay = 0; } } };
  }
}

/** Voice-room signaling over the server's Room relay (same interface as MqttTransport). */
export class ServerRoomTransport {
  constructor(base, roomId) { this.url = `${base.replace(/\/+$/, '').replace(/^http/, 'ws')}/v1/room/${roomId}/ws`; this.handlers = new Map(); this.onstatus = () => {}; }
  connect() {
    return new Promise((resolve) => {
      let first = true;
      const open = () => {
        this.ws = new WebSocket(this.url);
        this.ws.onopen = () => {
          for (const t of this.handlers.keys()) this.ws.send(JSON.stringify({ s: t }));
          this.onstatus(1, 1); if (first) { first = false; resolve(); }
          this.ping = setInterval(() => this.ws.readyState === 1 && this.ws.send('ping'), 25_000);
        };
        this.ws.onmessage = (e) => { if (e.data === 'pong') return; try { const m = JSON.parse(e.data); this.handlers.get(m.topic)?.(m.data); } catch {} };
        this.ws.onclose = () => { clearInterval(this.ping); this.onstatus(0, 1); if (!this.closed) setTimeout(open, 1500); };
      };
      open();
      setTimeout(() => { if (first) { first = false; resolve(); } }, 6000);
    });
  }
  subscribe(topic, cb) { this.handlers.set(topic, cb); if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ s: topic })); }
  publish(topic, data) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ p: topic, d: data })); }
  close() { this.closed = true; this.ws?.close(); }
}
