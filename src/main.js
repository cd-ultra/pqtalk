import '@fontsource-variable/inter';
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
    $('chanCode').textContent = `Channel ${formatCode(code).slice(0, 9)}`;
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
  $('join').classList.toggle('hidden', on);
  $('chan').classList.toggle('hidden', !on);
  if (!on) { $('relayDot').className = 'dot'; $('ptt').classList.remove('on', 'busy'); render.last = null; }
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
    $('relayDot').className = 'dot ' + (up === total ? 'ok' : up ? 'partial' : '');
    $('relayDot').title = `Relays connected: ${up} of ${total}`;
  });
  r.addEventListener('ptt', ({ detail: { on } }) => { if (on) audio.tone('rx'); render(); });
  r.addEventListener('needs-gesture', () => toast('Tap anywhere to enable audio'));
  r.addEventListener('log', ({ detail }) => {
    const l = $('log'); l.textContent = `${new Date().toLocaleTimeString()} ${detail}\n` + l.textContent.slice(0, 8000);
  });
}
document.addEventListener('click', () => room?.peers.forEach((p) => p.audio?.paused && p.audio.play().catch(() => {})));

const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const STATUS = { handshake: 'Exchanging keys…', connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…' };
const ROUTE = { 'direct (LAN)': 'Same network', 'direct (P2P)': 'Direct', 'TURN relay': 'Relayed' };
const CHECK = '<svg viewBox="0 0 24 24" aria-label="Verified"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.4 14.2-4-4 1.6-1.6 2.4 2.4 5.2-5.2 1.6 1.6Z"/></svg>';
const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const hue = (seed) => { let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = (name, seed) => `<span class="av" style="--h:${hue(seed)}" aria-hidden="true">${esc(name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?')}</span>`;

function render() {
  if (!room) return;
  const talkers = [...room.peers.values()].filter((p) => p.talking);
  const rows = [`<div class="row me ${room.talking ? 'talking' : ''}">${avatar(room.nick, room.peerId)}
    <span class="who"><span class="nm">${esc(room.nick)}</span><span class="sub">${room.talking ? 'Talking…' : 'You'}</span></span></div>`];
  for (const p of room.peers.values()) {
    if (p.audio) p.audio.volume = settings.volume;
    const isV = verified.has(bytesToHex(p.ik));
    const s = p.stats || {};
    const st = p.talking ? 'Talking…' : p.status === 'connected'
      ? [ROUTE[s.route], s.rtt != null ? `${s.rtt} ms` : null].filter(Boolean).join(', ') || 'Connected'
      : STATUS[p.status] ?? p.status;
    rows.push(`<button class="row ${p.talking ? 'talking' : ''}" data-id="${p.id}" data-act="verify" aria-expanded="${!!p.open}">
      ${avatar(p.nick, p.id)}<span class="who"><span class="nm">${esc(p.nick)}${isV ? CHECK : ''}</span><span class="sub">${st}</span></span>${CHEV}</button>`);
    if (p.open && p.safety) rows.push(`<div class="safety" data-id="${p.id}">
      <p class="sn">${p.safety.split(' ').map((g) => `<span>${g}</span>`).join('')}</p>
      <p class="hint">Compare this safety number with ${esc(p.nick)} in person or on a call. If it matches on both screens, nobody is listening in.</p>
      <button class="btn small tint" data-act="mark">${isV ? 'Clear verification' : 'Mark as verified'}</button></div>`);
  }
  if (!room.peers.size) rows.push('<p class="empty">No one else is here yet. Send an invite to bring people in.</p>');
  const html = rows.join('');
  if (html !== render.last) { $('roster').innerHTML = html; render.last = html; } // keep rows stable under the finger

  const t = $('talker');
  t.className = 'talker ' + (room.talking ? 'tx' : talkers.length ? 'rx' : '');
  t.textContent = room.talking ? 'You are talking' : talkers.length ? `${talkers.map((p) => p.nick).join(', ')} ${talkers.length > 1 ? 'are' : 'is'} talking` : 'Channel clear';
  $('ptt').classList.toggle('busy', !room.talking && talkers.length > 0 && !settings.talkOver);
  $('pttLabel').textContent = room.talking ? (settings.latch ? 'Tap to stop' : 'Release to finish') : settings.latch ? 'Tap to talk' : 'Hold to talk';
  $('pttSub').textContent = room.talking || matchMedia('(pointer: coarse)').matches ? '' : settings.latch ? 'or press Space' : 'or hold Space';
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
  $('usage').textContent = `Sending ${tx.toFixed(1)} kbps${txp ? ` (${txp.toFixed(0)} packets/s)` : ''}, receiving ${rx.toFixed(1)} kbps, ${(total / 1e6).toFixed(2)} MB this session`;
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
  if (!room?.talking) { ptt.style.setProperty('--lvl', 0); return; }
  ptt.style.setProperty('--lvl', audio.level().toFixed(2));
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

// ---------- volume ----------
const vol = $('vol');
vol.value = Math.round(settings.volume * 100);
vol.oninput = () => {
  settings.volume = vol.value / 100; saveSettings();
  room?.peers.forEach((p) => { if (p.audio) p.audio.volume = settings.volume; });
};

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
