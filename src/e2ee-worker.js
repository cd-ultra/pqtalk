// Runs the per-frame E2EE (sender keys / SFrame-style) off the main thread.
// Works with both RTCRtpScriptTransform (Safari, Firefox, modern Chrome) and Chrome's legacy
// createEncodedStreams() (streams are transferred in via postMessage).
import { SenderChain, ReceiverChain } from './crypto/sframe.js';

let sender = null;
const receivers = new Map(); // peerId -> Map(epoch -> ReceiverChain)
const stats = { enc: 0, dec: 0, drop: 0, noKey: 0 };

const asBuffer = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer);

function pipe({ op, peerId }, readable, writable) {
  const transform = op === 'encrypt'
    ? (frame, ctl) => {
        if (!sender) { stats.noKey++; return; } // never send plaintext
        frame.data = asBuffer(sender.encrypt(new Uint8Array(frame.data)));
        stats.enc++;
        ctl.enqueue(frame);
      }
    : (frame, ctl) => {
        const data = new Uint8Array(frame.data);
        const pt = data.length ? receivers.get(peerId)?.get(data[0])?.decrypt(data) : null;
        if (!pt) { stats.drop++; return; }
        frame.data = asBuffer(pt);
        stats.dec++;
        ctl.enqueue(frame);
      };
  readable.pipeThrough(new TransformStream({ transform })).pipeTo(writable).catch(() => {});
}

self.onmessage = ({ data: m }) => {
  switch (m.op) {
    case 'setSendKey': { const old = sender; sender = new SenderChain(m.key, m.epoch); old?.destroy(); break; }
    case 'setRecvKey': {
      let map = receivers.get(m.peerId);
      if (!map) receivers.set(m.peerId, (map = new Map()));
      map.get(m.epoch)?.destroy();
      map.delete(m.epoch);
      map.set(m.epoch, new ReceiverChain(m.key, m.epoch, m.gen ?? 0));
      while (map.size > 2) { const [e, rc] = map.entries().next().value; rc.destroy(); map.delete(e); }
      break;
    }
    case 'removePeer': { for (const rc of receivers.get(m.peerId)?.values() ?? []) rc.destroy(); receivers.delete(m.peerId); break; }
    case 'encrypt': case 'decrypt': pipe(m, m.readable, m.writable); break;
    case 'stats': self.postMessage({ op: 'stats', ...stats }); break;
  }
};

if ('RTCTransformEvent' in self) {
  self.onrtctransform = ({ transformer: t }) => pipe(t.options, t.readable, t.writable);
}
