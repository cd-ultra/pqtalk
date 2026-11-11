// Rendezvous transports. The relay only ever sees opaque, AES-GCM-encrypted blobs on a topic
// derived from the room code; it is used for discovery + WebRTC setup, never for audio.
import mqtt from 'mqtt';

// Free public MQTT-over-WSS brokers. We publish to all of them and de-duplicate, so any one
// being down/blocked doesn't matter.
export const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

export class MqttTransport {
  constructor(brokers = DEFAULT_BROKERS) {
    this.brokers = brokers;
    this.clients = [];
    this.handlers = new Map();
    this.onstatus = () => {};
  }
  connect() {
    const status = new Map();
    const report = () => this.onstatus([...status.values()].filter(Boolean).length, this.brokers.length);
    this.clients = this.brokers.map((url) => {
      const c = mqtt.connect(url, {
        clientId: 'pqt_' + Math.random().toString(36).slice(2, 12),
        clean: true, keepalive: 30, reconnectPeriod: 4000, connectTimeout: 8000, resubscribe: true,
      });
      c.on('connect', () => { status.set(url, true); report(); for (const t of this.handlers.keys()) c.subscribe(t, { qos: 0 }); });
      c.on('close', () => { status.set(url, false); report(); });
      c.on('error', () => {});
      c.on('message', (topic, payload) => this.handlers.get(topic)?.(payload.toString()));
      return c;
    });
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 6000);
      this.clients.forEach((c) => c.once('connect', () => { clearTimeout(t); resolve(); }));
    });
  }
  subscribe(topic, cb) {
    this.handlers.set(topic, cb);
    for (const c of this.clients) if (c.connected) c.subscribe(topic, { qos: 0 });
  }
  publish(topic, data) {
    for (const c of this.clients) if (c.connected) c.publish(topic, data, { qos: 0 });
  }
  close() { for (const c of this.clients) c.end(true); this.clients = []; }
}

/** Same-origin tabs only (BroadcastChannel). For development and automated tests. */
export class LocalTransport {
  constructor() { this.handlers = new Map(); this.onstatus = () => {}; }
  connect() {
    this.bc = new BroadcastChannel('pqtalk-local');
    this.bc.onmessage = (e) => this.handlers.get(e.data.topic)?.(e.data.data);
    this.onstatus(1, 1);
    return Promise.resolve();
  }
  subscribe(topic, cb) { this.handlers.set(topic, cb); }
  publish(topic, data) {
    this.bc.postMessage({ topic, data });
    // BroadcastChannel doesn't echo to self; deliver locally so self-addressed topics behave like MQTT
    queueMicrotask(() => this.handlers.get(topic)?.(data));
  }
  close() { this.bc?.close(); }
}
