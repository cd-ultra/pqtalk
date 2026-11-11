import '@fontsource/doto/700.css';
import '@fontsource/doto/900.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import './style.css';
import { generateCode, normalizeCode, formatCode } from './crypto/code.js';
import { loadIdentity } from './crypto/identity.js';
import { b64, unb64, utf8, fromUtf8, bytesToHex } from './crypto/prim.js';
import { MqttTransport, LocalTransport } from './net/transport.js';
import { Room } from './room.js';
import { AudioIO } from './audio.js';

const $ = (id) => document.getElementById(id);
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('pqtalk.' + k)) ?? d; } catch { return d; } },
             set: (k, v) => localStorage.setItem('pqtalk.' + k, JSON.stringify(v)) };

const identity = loadIdentity();
const audio = new AudioIO();
const settings = Object.assign({
  bitrate: 12000, ptime: 60, latch: false, roger: true, talkOver: false, relayOnly: false,
  mic: '', spk: '', volume: 0.8, turnApi: '', turnUrls: '', turnUser: '', turnPass: '', turnInInvite: false, nick: '',
}, LS.get('settings', {}));
const saveSettings = () => LS.set('settings', settings);
const verified = new Set(LS.get('verified', []));
let room = null, wakeLock = null, txTimer = null, txStart = 0;
const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const MAX_TX_MS = 60_000;

// ---------- invite link parsing ----------
(function parseHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('c')) $('code').value = h.get('c');
  if (h.get('t')) {
    try { Object.assign(settings, JSON.parse(fromUtf8(unb64(h.get('t'))))); saveSettings(); } catch {}
  }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
})();
$('nick').value = settings.nick;

function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}

async function buildIceServers() {
  const ice = [...STUN];
  if (settings.turnApi) {
    try {
      const r = await fetch(settings.turnApi, { referrerPolicy: 'no-referrer' });
      const j = await r.json();
      ice.push(...(Array.isArray(j) ? j : j.iceServers ?? []));
    } catch (e) { toast('TURN credentials fetch failed; continuing with STUN only'); }
  }
  if (settings.turnUrls) ice.push({ urls: settings.turnUrls.split(',').map((s) => s.trim()).filter(Boolean), username: settings.turnUser, credential: settings.turnPass });
  return ice;
}

// ---------- join / leave ----------
$('btnNew').onclick = () => { $('code').value = generateCode(); $('btnJoin').click(); };
$('code').onkeydown = (e) => e.key === 'Enter' && $('btnJoin').click();

$('btnJoin').onclick = async () => {
  $('joinErr').textContent = '';
  const nick = $('nick').value.trim() || 'Anon';
  const code = normalizeCode($('code').value);
  if (!code) return ($('joinErr').textContent = 'Invalid code: it must be 32 characters (dashes optional).');
  settings.nick = nick; saveSettings();
  $('btnJoin').disabled = true;
  try {
    const track = await audio.init(settings.mic); // must run inside the click gesture (iOS)
    const transport = new URLSearchParams(location.search).get('transport') === 'local' ? new LocalTransport() : new MqttTransport();
    room = new Room({
      code, nick, identity, transport, iceServers: await buildIceServers(),
      relayOnly: settings.relayOnly, bitrate: +settings.bitrate, ptime: +settings.ptime,
    });
    room.setTxTrack(track);
    if (settings.spk) room.setSink(settings.spk);
    wireRoom(room);
    await room.start();
    $('chanCode').textContent = `Ch ${formatCode(code).slice(0, 9)}…`;
    $('chanCode').title = formatCode(code);
    setPowered(true);
    acquireWakeLock(); setupMediaSession(); fillDevices(); render();
    window.__room = room; // debugging / tests
  } catch (e) {
    console.error(e);
    $('joinErr').textContent = e.message || String(e);
    room = null;
  } finally { $('btnJoin').disabled = false; }
};

$('btnLeave').onclick = () => {
  stopTx(true);
  room?.leave(); room = null;
  audio.stream?.getTracks().forEach((t) => t.stop());
  wakeLock?.release().catch(() => {}); wakeLock = null;
  setPowered(false);
};

function setPowered(on) {
  for (const id of ['join', 'joinKeys', 'joinNote']) $(id).classList.toggle('hidden', on);
  for (const id of ['chan', 'chanKeys', 'rear']) $(id).classList.toggle('hidden', !on);
  $('ptt').disabled = !on;
  if (!on) { $('ledTx').classList.remove('on'); $('ledRx').classList.remove('on'); $('lcd').classList.remove('lit'); $('relayDot').className = 'led link'; }
}
addEventListener('pagehide', () => room?.leave());

$('btnInvite').onclick = async () => {
  const p = new URLSearchParams({ c: room.room.code });
  if (settings.turnInInvite && (settings.turnApi || settings.turnUrls)) {
    const { turnApi, turnUrls, turnUser, turnPass } = settings;
    p.set('t', b64(utf8(JSON.stringify({ turnApi, turnUrls, turnUser, turnPass }))));
  }
  const url = `${location.origin}${location.pathname}#${p}`;
  const text = `Join my PQTalk channel: ${url}`;
  if (navigator.share) { try { await navigator.share({ title: 'PQTalk', text, url }); return; } catch {} }
  await navigator.clipboard.writeText(url).then(() => toast('Invite link copied: send it over Signal'), () => prompt('Copy invite link', url));
};

// ---------- room events / rendering ----------
function wireRoom(r) {
  r.addEventListener('peers', render);
  r.addEventListener('stats', renderUsage);
  r.addEventListener('sk', render);
  r.addEventListener('relay', ({ detail: { up, total } }) => {
    $('relayDot').className = 'led link ' + (up === total ? 'ok' : up ? 'partial' : '');
    $('relayDot').title = `relays connected: ${up}/${total}`;
  });
  r.addEventListener('ptt', ({ detail: { on } }) => { if (on) audio.tone('rx'); render(); });
  r.addEventListener('needs-gesture', () => toast('Tap anywhere to enable audio'));
  r.addEventListener('log', ({ detail }) => {
    const l = $('log'); l.textContent = `${new Date().toLocaleTimeString()} ${detail}\n` + l.textContent.slice(0, 8000);
  });
}
document.addEventListener('click', () => room?.peers.forEach((p) => p.audio?.paused && p.audio.play().catch(() => {})));

const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const STATUS = { handshake: 'keys…', connecting: 'link…', connected: 'ok', reconnecting: 'retry' };
const ROUTE = { 'direct (LAN)': 'lan', 'direct (P2P)': 'p2p', 'TURN relay': 'relay' };
function render() {
  if (!room) return;
  const talkers = [...room.peers.values()].filter((p) => p.talking);
  const rows = [`<div class="lrow me ${room.talking ? 'talking' : ''}"><span>${room.talking ? '▶' : ''}</span>
    <span class="nm">${esc(room.nick)} (you)</span><span class="st">${room.talking ? 'tx' : ''}</span></div>`];
  for (const p of room.peers.values()) {
    if (p.audio) p.audio.volume = settings.volume;
    const isV = verified.has(bytesToHex(p.ik));
    const s = p.stats || {};
    const st = p.talking ? 'rx' : p.status === 'connected'
      ? [ROUTE[s.route], s.rtt != null ? `${s.rtt}ms` : null].filter(Boolean).join(' ') || 'ok'
      : STATUS[p.status] ?? p.status;
    rows.push(`<button class="lrow ${p.talking ? 'talking' : ''}" data-id="${p.id}" data-act="verify" aria-expanded="${!!p.open}"
      title="Show safety number"><span>${p.talking ? '▶' : isV ? '✓' : ''}</span><span class="nm">${esc(p.nick)}</span><span class="st">${st}</span></button>`);
    if (p.open && p.safety) rows.push(`<div class="lcd-sn" data-id="${p.id}">${p.safety}
      <small>Read this aloud with ${esc(p.nick)}. If both screens match, nobody is listening in.</small>
      <button class="softkey" data-act="mark">${isV ? 'Clear verified' : 'Mark verified'}</button></div>`);
  }
  if (!room.peers.size) rows.push('<div class="lrow me"><span></span><span class="nm">Waiting for others…</span><span></span></div>');
  const html = rows.join('');
  if (html !== render.last) { $('roster').innerHTML = html; render.last = html; } // keep rows stable under the finger

  $('talker').textContent = room.talking ? 'Transmitting' : talkers.length ? `Rx ${talkers.map((p) => p.nick).join(', ')}` : 'Channel clear';
  $('ledTx').classList.toggle('on', room.talking);
  $('ledRx').classList.toggle('on', talkers.length > 0);
  $('lcd').classList.toggle('lit', room.talking || talkers.length > 0);
  $('lcdLock').textContent = room.sk ? `E2EE k${room.sk.epoch}` : 'E2EE';
  $('ptt').classList.toggle('busy', !room.talking && talkers.length > 0);
  $('pttLabel').textContent = room.talking ? (settings.latch ? 'Tap to stop' : 'Talking') : settings.latch ? 'Tap to talk' : 'Push to talk';
  $('pttSub').textContent = room.talking ? 'release to send roger' : talkers.length ? `${talkers[0].nick} is talking` : settings.latch ? 'or press Space' : 'or hold Space';
  $('secInfo').textContent = [
    `Frame encryption: ${room.mode === 'script' ? 'RTCRtpScriptTransform' : 'Insertable Streams (legacy)'}, SFrame AES-128-CTR + HMAC-SHA256-80`,
    `Pairwise: X25519 + ML-KEM-768 hybrid + room PSK, symmetric ratchet, PQ re-key every 5 min`,
    `My sender key epoch: ${room.sk?.epoch ?? 'pending'} (rotates on join, leave and every 10 min)`,
    `Room id (public relay topic): ${room.room.roomId}`,
    `Frames: ${room.frameStats ? `${room.frameStats.enc} encrypted, ${room.frameStats.dec} decrypted, ${room.frameStats.drop} dropped` : 'none yet'}`,
  ].join('\n');
}

function renderUsage() {
  if (!room) return;
  let tx = 0, rx = 0, total = 0, txp = 0;
  for (const p of room.peers.values()) { const s = p.stats || {}; tx += s.txKbps || 0; rx += s.rxKbps || 0; txp += s.txPps || 0; total += s.totalBytes || 0; }
  $('usage').textContent = `↑${tx.toFixed(1)}k ↓${rx.toFixed(1)}k ${txp ? `${txp.toFixed(0)}pk/s ` : ''}${(total / 1e6).toFixed(2)}MB`;
  render();
}

$('roster').onclick = (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const p = room.peers.get(btn.closest('[data-id]')?.dataset.id); if (!p) return;
  if (btn.dataset.act === 'verify') p.open = !p.open;
  if (btn.dataset.act === 'mark') { const k = bytesToHex(p.ik); verified.has(k) ? verified.delete(k) : verified.add(k); LS.set('verified', [...verified]); }
  render();
};

// ---------- push-to-talk ----------
function startTx() {
  if (!room || room.talking) return;
  if (room.channelBusy && !settings.talkOver) { audio.tone('busy'); toast('Channel busy'); return; }
  room.ptt(true);
  audio.tone('permit');
  txStart = Date.now();
  $('ptt').classList.add('on');
  clearTimeout(txTimer); txTimer = setTimeout(() => { toast('Transmit timeout (60 s)'); stopTx(); }, MAX_TX_MS);
  meterLoop(); render();
}
function stopTx(immediate = false) {
  if (!room?.talking) return;
  clearTimeout(txTimer);
  $('ptt').classList.remove('on');
  if (settings.roger && !immediate) {
    const ms = audio.tone('roger', true);
    setTimeout(() => { room?.ptt(false); render(); }, ms + 40);
  } else { room.ptt(false); }
  render();
}
const toggleTx = () => (room?.talking ? stopTx() : startTx());

const ptt = $('ptt');
ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); settings.latch ? toggleTx() : startTx(); });
['pointerup', 'pointercancel'].forEach((ev) => ptt.addEventListener(ev, () => { if (!settings.latch) stopTx(); }));
ptt.addEventListener('contextmenu', (e) => e.preventDefault());
const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && room && !typing()) { e.preventDefault(); settings.latch ? toggleTx() : startTx(); } });
addEventListener('keyup', (e) => { if (e.code === 'Space' && room && !typing() && !settings.latch) { e.preventDefault(); stopTx(); } });

function meterLoop() {
  if (!room?.talking) { $('lvl').style.width = '0'; return; }
  $('lvl').style.width = `${audio.level() * 100}%`;
  requestAnimationFrame(meterLoop);
}

// Bluetooth headset / car buttons arrive as media keys (best effort in browsers; native in Capacitor build)
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'PQTalk', artist: 'Channel open' });
  for (const a of ['play', 'pause', 'stop', 'togglemicrophone']) {
    try { navigator.mediaSession.setActionHandler(a, toggleTx); } catch {}
  }
}

async function acquireWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (room && document.visibilityState === 'visible') acquireWakeLock(); });

// ---------- volume knob: drag up/right or use arrow keys; 270° sweep ----------
const knob = $('knob');
function setVolume(v) {
  settings.volume = Math.max(0, Math.min(1, v));
  knob.style.setProperty('--rot', `${-135 + settings.volume * 270}deg`);
  knob.setAttribute('aria-valuenow', Math.round(settings.volume * 100));
  room?.peers.forEach((p) => { if (p.audio) p.audio.volume = settings.volume; });
}
setVolume(settings.volume);
knob.addEventListener('pointerdown', (e) => {
  knob.setPointerCapture(e.pointerId);
  const start = { x: e.clientX, y: e.clientY, v: settings.volume };
  const move = (ev) => setVolume(start.v + ((ev.clientX - start.x) - (ev.clientY - start.y)) / 160);
  const up = () => { knob.removeEventListener('pointermove', move); saveSettings(); };
  knob.addEventListener('pointermove', move);
  knob.addEventListener('pointerup', up, { once: true });
  knob.addEventListener('pointercancel', up, { once: true });
});
knob.addEventListener('keydown', (e) => {
  const d = { ArrowUp: .05, ArrowRight: .05, ArrowDown: -.05, ArrowLeft: -.05 }[e.key];
  if (d) { e.preventDefault(); setVolume(settings.volume + d); saveSettings(); }
});
knob.addEventListener('wheel', (e) => { e.preventDefault(); setVolume(settings.volume - e.deltaY / 1000); saveSettings(); }, { passive: false });

// ---------- settings UI ----------
const bind = (id, key, { type = 'value', live } = {}) => {
  const el = $(id);
  el[type === 'checked' ? 'checked' : 'value'] = settings[key];
  el.onchange = () => { settings[key] = type === 'checked' ? el.checked : el.value; saveSettings(); live?.(settings[key]); render(); };
};
bind('setBitrate', 'bitrate', { live: (v) => room?.setBitrate(+v) });
bind('setPtime', 'ptime', { live: (v) => { if (room) { room.ptime = +v; room.setBitrate(room.bitrate); } } });
bind('setLatch', 'latch', { type: 'checked' });
bind('setRoger', 'roger', { type: 'checked' });
bind('setTalkOver', 'talkOver', { type: 'checked' });
bind('setRelayOnly', 'relayOnly', { type: 'checked' });
bind('turnApi', 'turnApi'); bind('turnUrls', 'turnUrls'); bind('turnUser', 'turnUser'); bind('turnPass', 'turnPass');
bind('turnInInvite', 'turnInInvite', { type: 'checked' });
bind('setMic', 'mic', { live: async (id) => { if (room) room.setTxTrack(await audio.init(id)); } });
bind('setSpk', 'spk', { live: (id) => room?.setSink(id) });

async function fillDevices() {
  const { inputs, outputs } = await AudioIO.devices();
  const opts = (list) => '<option value="">System default</option>' + list.map((d) => `<option value="${d.deviceId}">${esc(d.label || 'Device')}</option>`).join('');
  $('setMic').innerHTML = opts(inputs); $('setMic').value = settings.mic;
  const spkSupported = 'setSinkId' in HTMLMediaElement.prototype;
  $('setSpk').innerHTML = spkSupported ? opts(outputs) : '<option value="">Controlled by OS (Bluetooth via system)</option>';
  $('setSpk').disabled = !spkSupported; $('setSpk').value = settings.spk;
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => room && fillDevices());

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
