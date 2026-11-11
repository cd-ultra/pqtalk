// Feature detection + wiring of encoded-frame transforms.
export function e2eeMode() {
  if (typeof RTCRtpScriptTransform !== 'undefined') return 'script';
  if (typeof RTCRtpSender !== 'undefined' && 'createEncodedStreams' in RTCRtpSender.prototype) return 'legacy';
  return null;
}

export function attach(worker, mode, senderOrReceiver, op, peerId) {
  if (mode === 'script') {
    senderOrReceiver.transform = new RTCRtpScriptTransform(worker, { op, peerId });
  } else {
    const { readable, writable } = senderOrReceiver.createEncodedStreams();
    worker.postMessage({ op, peerId, readable, writable }, [readable, writable]);
  }
}
