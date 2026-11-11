// Mic capture -> WebAudio graph -> one outgoing track (so we can inject radio tones on-air),
// plus local UI tones and a level meter.
export class AudioIO {
  async init(deviceId) {
    this.ctx ??= new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
      },
    });
    this.src?.disconnect();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    if (!this.dest) {
      this.dest = this.ctx.createMediaStreamDestination();
      this.dest.channelCount = 1;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
    }
    this.src.connect(this.dest);
    this.src.connect(this.analyser);
    this.txTrack = this.dest.stream.getAudioTracks()[0];
    return this.txTrack;
  }

  level() {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v;
    return Math.min(1, Math.sqrt(s / buf.length) * 4);
  }

  /** kind: 'permit' | 'roger' | 'busy' | 'rx' ; onAir => also mixed into the outgoing stream */
  tone(kind, onAir = false) {
    const ctx = this.ctx; if (!ctx) return 0;
    const seq = {
      permit: [[1200, 0.05], [1600, 0.05]],
      roger: [[1800, 0.06], [1300, 0.08]],
      busy: [[420, 0.12], [0, 0.06], [420, 0.12]],
      rx: [[900, 0.03]],
    }[kind];
    let t = ctx.currentTime + 0.01;
    const out = ctx.createGain(); out.gain.value = kind === 'rx' ? 0.05 : 0.12;
    out.connect(ctx.destination);
    if (onAir && this.dest) out.connect(this.dest);
    for (const [f, d] of seq) {
      if (f) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        o.connect(out); o.start(t); o.stop(t + d);
      }
      t += d;
    }
    const total = (t - ctx.currentTime) * 1000;
    setTimeout(() => out.disconnect(), total + 50);
    return total;
  }

  static async devices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return { inputs: all.filter((d) => d.kind === 'audioinput'), outputs: all.filter((d) => d.kind === 'audiooutput') };
  }
}
