// Opus tuning via SDP. Each side munges its OWN local description: Opus fmtp params are
// receiver-declared ("send me at most X"), and ptime tells the remote encoder the packet size.
//
// Why ptime=60: at 20 ms packets the IP/UDP/RTP/SRTP headers (~50 B x 50 pkt/s ≈ 20 kbps) cost
// more than 12 kbps Opus itself. 60 ms cuts header overhead to ~7 kbps.
// Why cbr=1: VBR packet sizes leak phonemes even through encryption (Wright et al.); Signal also
// runs CBR for calls. With push-to-talk we send nothing at all when idle, so DTX is unnecessary.
export function tuneOpus(sdp, { bitrate = 12000, ptime = 60 } = {}) {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
  if (!pt) return sdp;
  const want = {
    minptime: '10', useinbandfec: '1', usedtx: '0', cbr: '1', stereo: '0', 'sprop-stereo': '0',
    maxaveragebitrate: String(bitrate), maxplaybackrate: bitrate <= 10000 ? '12000' : '16000',
  };
  const fmtp = (existing = '') => {
    const p = new Map(existing.split(';').filter(Boolean).map((kv) => kv.trim().split('=')));
    for (const [k, v] of Object.entries(want)) p.set(k, v);
    return `a=fmtp:${pt} ` + [...p].map(([k, v]) => `${k}=${v}`).join(';');
  };
  const out = [];
  let inAudio = false, hadFmtp = false;
  for (const line of sdp.split('\r\n')) {
    if (line.startsWith('m=')) inAudio = line.startsWith('m=audio');
    if (inAudio) {
      // RFC 6464 audio-level header extension is sent in the clear => leaks who's talking/how loud
      if (/^a=extmap:\d+(\/\w+)? urn:ietf:params:rtp-hdrext:ssrc-audio-level/.test(line)) continue;
      if (line.startsWith('a=ptime:') || line.startsWith('a=maxptime:')) continue;
      if (line.startsWith(`a=fmtp:${pt} `)) {
        out.push(fmtp(line.slice(`a=fmtp:${pt} `.length)), `a=ptime:${ptime}`, `a=maxptime:${ptime}`);
        hadFmtp = true;
        continue;
      }
      if (!hadFmtp && line.startsWith(`a=rtpmap:${pt} `)) {
        out.push(line);
        if (!sdp.includes(`a=fmtp:${pt} `)) { out.push(fmtp(), `a=ptime:${ptime}`, `a=maxptime:${ptime}`); hadFmtp = true; }
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\r\n');
}
