import '@fontsource-variable/inter';
import './style.css';
import QRCode from 'qrcode';
import { Messenger } from './msg/engine.js';
import { Voice } from './msg/voice.js';
import { wipeAll } from './msg/store.js';
import { bytesToHex } from './crypto/prim.js';

const DEFAULT_SERVER = (import.meta.env.VITE_SERVER_URL || '').replace(/\/+$/, '');
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app'), overlay = $('#overlay');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('pqtalk.m.' + k)) ?? d; } catch { return d; } },
             set: (k, v) => localStorage.setItem('pqtalk.m.' + k, JSON.stringify(v)) };
const prefs = Object.assign({ notify: false, turnApi: '' }, LS.get('prefs', {}));

// ---------------- icons ----------------
const P = {
  back: '<path d="M15 5l-7 7 7 7"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  hang: '<path d="M3 15.5c5-4.7 13-4.7 18 0l-2.4 2.5-3.6-1.5v-2.6a11 11 0 0 0-6 0v2.6L5.4 18z"/>',
  radio: '<rect x="6" y="8" width="12" height="13" rx="2"/><path d="M9 8V3M9 13h6M9 16h6"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/>',
  micoff: '<path d="M9 9v2a3 3 0 0 0 5 2.2M15 9.3V6a3 3 0 0 0-5.6-1.5"/><path d="M6 11a6 6 0 0 0 9.5 4.8M18 11a6 6 0 0 1-.4 2.2M12 17v4M3 3l18 18"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checks: '<path d="M2 12.5l4.5 4.5L16 7.5"/><path d="M11 16l1 1 9.5-9.5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>', alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  group: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>', pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/>',
};
const icon = (n, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n]}</svg>`;
const hue = (seed) => { let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (n) => esc(String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?');
const avatar = (name, seed, size = 48, group = false) =>
  `<span class="av" style="--h:${hue(seed)};--s:${size}px" aria-hidden="true">${group ? icon('group') : initials(name)}</span>`;
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtShort = (ts) => {
  const d = new Date(ts), n = new Date();
  if (d.toDateString() === n.toDateString()) return fmtTime(ts);
  if (n - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const fmtDay = (ts) => {
  const d = new Date(ts), n = new Date();
  if (d.toDateString() === n.toDateString()) return 'Today';
  if (new Date(n - 864e5).toDateString() === d.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
};
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------------- state ----------------
let m = null, voice = null;
let route = { view: 'empty', conv: null };
const typing = new Map(); // conv -> Map(from -> expiry)
const urls = new Map(); // attachment id -> object URL
const drafts = new Map();
let pendingInvite = null;

(function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('i')) pendingInvite = location.hash;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
})();

async function iceServers() {
  const ice = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  if (prefs.turnApi) {
    try { const j = await (await fetch(prefs.turnApi, { referrerPolicy: 'no-referrer' })).json(); ice.push(...(Array.isArray(j) ? j : j.iceServers ?? [])); }
    catch { toast('Couldn’t get TURN credentials; calls may fail on some networks'); }
  }
  return ice;
}

// ---------------- boot ----------------
async function boot() {
  if (!(await Messenger.hasAccount())) return renderOnboarding();
  m = new Messenger();
  m.defaultServer = DEFAULT_SERVER;
  wire();
  renderShell();
  try { await m.start(); }
  catch (e) { toast(`Can’t reach the server: ${e.message}`, 5000); }
  if (pendingInvite) { const inv = pendingInvite; pendingInvite = null; addFromLink(inv); }
  refreshSide();
}

function renderOnboarding() {
  app.dataset.pane = 'main';
  app.innerHTML = `<div class="side"></div><main class="main"><div class="scroll"><form class="page center" id="onb">
    <div class="hero"><span class="mark">${icon('mic')}</span><h1>PQTalk</h1><p>Private messages, calls and walkie-talkie</p></div>
    <label class="f">Your name<input class="t" id="obName" maxlength="40" autocomplete="nickname" placeholder="How others will see you" required /></label>
    <label class="f ${DEFAULT_SERVER ? 'hidden' : ''}" id="obSrvWrap">Server address<input class="t" id="obSrv" type="url" placeholder="https://pqtalk-server.you.workers.dev" value="${esc(DEFAULT_SERVER)}" /></label>
    <p class="err" id="obErr" role="alert"></p>
    <button class="btn primary block" id="obGo">Get started</button>
    ${DEFAULT_SERVER ? '<button class="btn quiet" type="button" id="obAdv">Use a different server</button>' : ''}
    <p class="note">No phone number or email. Your keys are created on this device and never leave it.
      To chat, share your invite link and open theirs. Everything is end-to-end encrypted with post-quantum keys.</p>
  </form></div></main>`;
  $('#obAdv')?.addEventListener('click', () => { $('#obSrvWrap').classList.remove('hidden'); $('#obAdv').remove(); });
  $('#onb').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#obName').value.trim(), server = $('#obSrv').value.trim().replace(/\/+$/, '');
    if (!name) return;
    if (!/^https?:\/\//.test(server)) return ($('#obErr').textContent = 'Enter the server address you were given.');
    $('#obGo').disabled = true;
    try {
      m = new Messenger(); m.defaultServer = DEFAULT_SERVER; wire(); renderShell();
      await m.create({ name, server });
      if (pendingInvite) { const inv = pendingInvite; pendingInvite = null; addFromLink(inv); }
      refreshSide();
    } catch (err) {
      m?.stop(); m = null;
      await wipeAll().catch(() => {});
      renderOnboarding();
      $('#obErr').textContent = `Couldn’t connect to the server: ${err.message}`;
    }
  });
}

function wire() {
  voice = new Voice(m, { iceServers });
  voice.addEventListener('change', () => { renderOverlay(); if (route.view === 'chat') refreshChatChrome(); refreshSide(); });
  voice.addEventListener('toast', (e) => toast(e.detail));
  m.addEventListener('change', () => { refreshSide(); if (route.view === 'chat') refreshChatChrome(); });
  m.addEventListener('message', (e) => onMessage(e.detail));
  m.addEventListener('status', (e) => { if (route.view === 'chat' && e.detail.conv === route.conv) refreshMsgs(); });
  m.addEventListener('typing', (e) => {
    const { conv, from, on } = e.detail;
    const t = typing.get(conv) ?? new Map();
    on ? t.set(from, Date.now() + 6000) : t.delete(from);
    typing.set(conv, t);
    refreshSide(); if (route.view === 'chat' && route.conv === conv) refreshTyping();
  });
  m.addEventListener('net', () => refreshSide());
  m.addEventListener('error', (e) => toast(e.detail));
  m.addEventListener('log', (e) => console.debug('[pqtalk]', e.detail));
  setInterval(() => { // expire typing indicators
    let changed = false;
    for (const t of typing.values()) for (const [k, exp] of t) if (exp < Date.now()) { t.delete(k); changed = true; }
    if (changed) { refreshSide(); if (route.view === 'chat') refreshTyping(); }
  }, 2000);
}

// ---------------- layout ----------------
function renderShell() {
  app.innerHTML = `<aside class="side" id="side"></aside><main class="main" id="main"></main>`;
  setRoute(route);
}

function setRoute(r) {
  stopRecording(false);
  route = r;
  m.openConv = r.view === 'chat' ? r.conv : null;
  app.dataset.pane = r.view === 'empty' ? 'side' : 'main';
  const main = $('#main');
  if (r.view === 'empty') main.innerHTML = `<div class="empty">${icon('shield')}<h2>Your chats are end-to-end encrypted</h2><p>Pick a chat, or start one with the pencil button.</p></div>`;
  if (r.view === 'chat') renderChat();
  if (r.view === 'info') renderInfo();
  if (r.view === 'new') renderNew();
  if (r.view === 'group') renderGroupNew();
  if (r.view === 'settings') renderSettings();
  refreshSide();
}
const go = (view, conv = null) => setRoute({ view, conv });

async function refreshSide() {
  const side = $('#side'); if (!side || !m?.account) return;
  const convs = await m.convs();
  const titles = await Promise.all(convs.map((v) => m.convTitle(v)));
  const unread = convs.reduce((n, v) => n + (v.unread || 0), 0);
  document.title = unread ? `(${unread}) PQTalk` : 'PQTalk';
  const rows = await Promise.all(convs.map(async (v, i) => {
    const t = [...(typing.get(v.id)?.keys() ?? [])];
    let prev = esc(v.lastText || (v.type === 'group' ? 'New group' : 'Say hi'));
    if (v.type === 'group' && v.lastFrom && v.lastFrom !== 'system' && v.lastText) {
      prev = `${v.lastFrom === 'me' ? 'You' : esc((await m.contact(v.lastFrom))?.name?.split(' ')[0] ?? '')}: ${prev}`;
    } else if (v.lastFrom === 'me' && v.lastText) prev = `You: ${prev}`;
    const walk = voice?.walkieSeen.get(v.id);
    if (t.length) prev = 'typing…';
    else if (voice?.state?.conv === v.id) prev = voice.state.mode === 'ptt' ? 'On walkie-talkie' : 'In a call';
    else if (walk && Date.now() - walk.ts < 10 * 60_000) prev = 'Walkie-talkie is on';
    return `<button class="conv" data-act="open" data-id="${esc(v.id)}" aria-current="${route.conv === v.id}">
      ${avatar(titles[i], v.id, 50, v.type === 'group')}
      <span class="mid"><span class="row1"><b>${esc(titles[i])}</b><time>${fmtShort(v.lastTs)}</time></span>
      <span class="row2"><span class="prev ${t.length ? 'typing' : ''}">${prev}</span>${v.unread ? `<span class="badge">${v.unread}</span>` : ''}</span></span></button>`;
  }));
  side.innerHTML = `<header class="bar"><h1>Chats</h1>
      <button class="icon" data-act="settings" aria-label="Settings">${icon('gear')}</button>
      <button class="icon" data-act="new" aria-label="New chat">${icon('edit')}</button></header>
    ${m.online === false ? '<p class="netbar">Connecting…</p>' : ''}
    <div class="scroll">${rows.join('') || `<div class="empty"><h2>No chats yet</h2><p>Share your invite link with someone to start chatting.</p>
      <button class="btn primary" data-act="new">Invite someone</button></div>`}</div>`;
}

// ---------------- chat ----------------
async function renderChat() {
  const main = $('#main');
  main.innerHTML = `<header class="bar" id="chatBar"></header><div id="banner"></div>
    <div class="scroll" id="scroller"><div class="msgs" id="msgs"></div><div id="typing"></div></div>
    <div id="dock"></div>`;
  await refreshChatChrome();
  await refreshMsgs(true);
  if (!document.hidden) m.markRead(route.conv);
}

async function refreshChatChrome() {
  const v = await m.conv(route.conv); if (!v || route.view !== 'chat' || !$('#chatBar')) return;
  const title = await m.convTitle(v);
  let sub = '', verified = false;
  if (v.type === 'group') sub = v.left ? 'You left this group' : `${v.members.length + 1} members`;
  else { const c = await m.contact(v.id); verified = !!c?.verified; sub = verified ? 'Verified' : 'Tap for safety number'; }
  const inCall = voice.state?.conv === v.id;
  $('#chatBar').innerHTML = `<button class="icon back" data-act="home" aria-label="Back">${icon('back')}</button>
    <button class="title" data-act="info">${avatar(title, v.id, 38, v.type === 'group')}<span class="who"><b>${esc(title)}${
      verified ? icon('shield', 'i vbadge') : ''}</b><small>${esc(sub)}</small></span></button>
    <button class="icon" data-act="walkie" aria-label="Walkie-talkie" ${v.left ? 'disabled' : ''} aria-pressed="${inCall && voice.state.mode === 'ptt'}">${icon('radio')}</button>
    <button class="icon" data-act="call" aria-label="Voice call" ${v.left || (voice.state && !inCall) ? 'disabled' : ''}>${icon('phone')}</button>`;
  const walk = voice.walkieSeen.get(v.id);
  const banner = $('#banner');
  if (!inCall && walk && Date.now() - walk.ts < 10 * 60_000) {
    const who = (await m.contact(walk.from))?.name ?? 'Someone';
    banner.innerHTML = `<div class="banner">${icon('radio')}<span>${esc(who)} turned on walkie-talkie</span><button class="btn small tint" data-act="walkie">Join</button></div>`;
  } else if (inCall && voice.state.mode === 'call' && voice.state.hidden) {
    banner.innerHTML = `<div class="banner">${icon('phone')}<span>Call in progress</span><button class="btn small tint" data-act="showcall">Return to call</button></div>`;
  } else banner.innerHTML = '';
  renderDock(v);
}

function renderDock(v) {
  const dock = $('#dock'); if (!dock) return;
  const s = voice.state;
  if (s?.mode === 'ptt' && s.conv === v.id) {
    const r = s.room;
    const talkers = r ? [...r.peers.values()].filter((p) => p.talking) : [];
    const n = r ? r.peers.size : 0;
    const status = r?.talking ? ['tx', 'You’re talking'] : talkers.length ? ['rx', `${talkers.map((p) => p.nick).join(', ')} talking`]
      : ['', !r ? 'Connecting…' : n ? `${n} other${n > 1 ? 's' : ''} listening` : 'Waiting for others to join'];
    if (!dock.querySelector('.walkie')) {
      dock.innerHTML = `<div class="walkie"><div class="top"><p id="wkStatus"></p><button class="btn small quiet danger" data-act="walkieLeave">Leave</button></div>
        <button class="ptt" id="ptt" aria-label="Hold to talk">${icon('mic')}</button><small>Hold to talk${matchMedia('(pointer: fine)').matches ? ', or hold Space' : ''}</small></div>`;
      bindPtt();
    }
    const st = $('#wkStatus'); st.className = status[0]; st.textContent = status[1];
    $('#ptt').classList.toggle('busy', !r?.talking && talkers.length > 0);
    $('#ptt').classList.toggle('on', !!r?.talking);
    return;
  }
  if (v.left) { dock.innerHTML = '<p class="netbar">You left this group.</p>'; return; }
  if (dock.querySelector('.composer')) return;
  dock.innerHTML = `<div class="composer" id="composer">
    <button class="icon left" data-act="attach" aria-label="Send a photo">${icon('image')}</button>
    <textarea id="input" rows="1" placeholder="Message" aria-label="Message"></textarea>
    <button class="icon send hidden" id="sendBtn" data-act="send" aria-label="Send">${icon('send')}</button>
    <button class="icon left" id="micBtn" data-act="record" aria-label="Record voice message">${icon('mic')}</button>
    <input type="file" id="file" accept="image/*" hidden /></div>`;
  const input = $('#input');
  input.value = drafts.get(v.id) ?? '';
  autosize(input); toggleSend();
  input.addEventListener('input', () => { autosize(input); toggleSend(); drafts.set(route.conv, input.value); typingPing(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); sendText(); } });
  $('#file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendPhoto(f); });
}
const autosize = (el) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; };
function toggleSend() { const has = !!$('#input')?.value.trim(); $('#sendBtn')?.classList.toggle('hidden', !has); $('#micBtn')?.classList.toggle('hidden', has); }

let typingState = { on: false, last: 0, t: null };
function typingPing() {
  const conv = route.conv;
  if (!typingState.on || Date.now() - typingState.last > 4000) { m.typing(conv, true); typingState = { ...typingState, on: true, last: Date.now() }; }
  clearTimeout(typingState.t);
  typingState.t = setTimeout(() => { m.typing(conv, false); typingState.on = false; }, 3500);
}

async function sendText() {
  const input = $('#input'); const body = input.value.trim(); if (!body) return;
  input.value = ''; drafts.delete(route.conv); autosize(input); toggleSend(); input.focus();
  clearTimeout(typingState.t); if (typingState.on) { m.typing(route.conv, false); typingState.on = false; }
  await m.sendText(route.conv, body);
}

async function refreshMsgs(scrollEnd = false) {
  const box = $('#msgs'); if (!box) return;
  const sc = $('#scroller');
  const atEnd = scrollEnd || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  const v = await m.conv(route.conv);
  const list = await m.messages(route.conv);
  const names = new Map();
  for (const x of list) if (x.from !== 'me' && x.from !== 'system' && !names.has(x.from)) names.set(x.from, (await m.contact(x.from))?.name ?? 'Unknown');
  let html = '', lastDay = '';
  list.forEach((x, i) => {
    const day = new Date(x.ts).toDateString();
    if (day !== lastDay) { html += `<p class="day">${fmtDay(x.ts)}</p>`; lastDay = day; }
    if (x.kind === 'system') { html += `<p class="sys">${esc(x.body)}</p>`; return; }
    const prev = list[i - 1], next = list[i + 1];
    const same = (a) => a && a.from === x.from && a.kind !== 'system' && Math.abs(a.ts - x.ts) < 5 * 60_000 && new Date(a.ts).toDateString() === day;
    const me = x.from === 'me';
    const name = names.get(x.from);
    const status = me ? ({ sending: icon('clock'), sent: icon('check'), delivered: icon('checks'), read: icon('checks'), failed: icon('alert') }[x.status] ?? '') : '';
    const label = { sending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not sent' }[x.status] ?? '';
    const meta = `<span class="meta">${fmtTime(x.ts)}${me ? `<span title="${label}" aria-label="${label}" data-status="${esc(x.status)}" style="display:inline-flex${x.status === 'read' ? ';opacity:1' : ''}">${status}</span>` : ''}</span>`;
    const from = v?.type === 'group' && !me && !same(prev) ? `<p class="from" style="--h:${hue(x.from)}">${esc(name)}</p>` : '';
    let inner;
    if (x.kind === 'att' && x.att?.kind === 'image') {
      const ratio = x.att.w && x.att.h ? `aspect-ratio:${x.att.w}/${x.att.h}` : '';
      inner = `<div class="b media">${from ? `<div style="padding:4px 9px 0">${from}</div>` : ''}<img data-att="${esc(x.att.id)}" data-act="view" alt="Photo" style="${ratio}" />${x.body ? `<p class="txt">${esc(x.body)}</p>` : ''}${meta}</div>`;
    } else if (x.kind === 'att' && x.att?.kind === 'voice') {
      inner = `<div class="b">${from}<div class="voice"><button class="play" data-act="play" data-att="${esc(x.att.id)}" aria-label="Play voice message">${icon(playing === x.att.id && !player.paused ? 'pause' : 'play')}</button>
        <span class="track"><i data-track="${esc(x.att.id)}"></i></span><span>${fmtDur(x.att.dur ?? 0)}</span></div>${meta}</div>`;
    } else inner = `<div class="b">${from}<p class="txt">${linkify(esc(x.body))}</p>${meta}</div>`;
    html += `<div class="m ${me ? 'me' : ''} ${same(prev) ? '' : 'gap'} ${same(next) ? '' : 'last'}" data-id="${esc(x.id)}">
      ${me || v?.type !== 'group' ? '' : avatar(name, x.from, 28)}${inner}</div>`;
  });
  box.innerHTML = html || `<div class="empty">${icon('shield')}<p>Messages in this chat are end-to-end encrypted with post-quantum keys. Only the people in it can read them.</p></div>`;
  hydrateMedia();
  if (atEnd) sc.scrollTop = sc.scrollHeight;
  refreshTyping();
}
const linkify = (s) => s.replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer" style="color:inherit">${u}</a>`);

function refreshTyping() {
  const el = $('#typing'); if (!el) return;
  const on = [...(typing.get(route.conv)?.keys() ?? [])].length > 0;
  el.innerHTML = on ? '<div class="msgs" style="padding-top:0"><div class="typing" aria-label="Typing"><i></i><i></i><i></i></div></div>' : '';
}

async function blobUrl(att) {
  if (urls.has(att.id)) return urls.get(att.id);
  const u = URL.createObjectURL(await m.attachment(att));
  urls.set(att.id, u); return u;
}
async function attOf(id) { return (await m.messages(route.conv)).find((x) => x.att?.id === id)?.att; }
function hydrateMedia() {
  for (const img of document.querySelectorAll('img[data-att]:not([src])')) {
    attOf(img.dataset.att).then((a) => a && blobUrl(a)).then((u) => { if (u) img.src = u; })
      .catch(() => { img.replaceWith(Object.assign(document.createElement('div'), { className: 'ph', textContent: 'Photo unavailable' })); });
  }
}

// voice-note playback
const player = new Audio();
let playing = null;
player.addEventListener('timeupdate', () => {
  const t = document.querySelector(`[data-track="${playing}"]`);
  if (t && player.duration && isFinite(player.duration)) t.style.setProperty('--p', `${(player.currentTime / player.duration) * 100}%`);
});
player.addEventListener('ended', () => { setPlayIcon(playing, false); playing = null; });
function setPlayIcon(id, on) { const b = document.querySelector(`[data-act=play][data-att="${id}"]`); if (b) b.innerHTML = icon(on ? 'pause' : 'play'); }
async function togglePlay(id) {
  if (playing === id && !player.paused) { player.pause(); setPlayIcon(id, false); return; }
  if (playing && playing !== id) setPlayIcon(playing, false);
  const a = await attOf(id); if (!a) return;
  try { player.src = await blobUrl(a); playing = id; await player.play(); setPlayIcon(id, true); }
  catch { toast('Can’t play this voice message here'); }
}

// photos
async function sendPhoto(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    let q = 0.82, blob;
    do { blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q)); q -= 0.12; } while (blob.size > 1.8e6 && q > 0.3);
    toast('Sending photo…', 1500);
    await m.sendAttachment(route.conv, { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', kind: 'image', meta: { w: c.width, h: c.height } });
  } catch (e) { toast(`Couldn’t send photo: ${e.message}`); }
}

// voice notes
let rec = null;
async function startRecording() {
  if (voice.state) return toast('Finish your call first');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const mime = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
    const r = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
    const chunks = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec = { r, stream, chunks, start: Date.now(), conv: route.conv, mime: r.mimeType || mime || 'audio/webm' };
    r.start(250);
    $('#composer').innerHTML = `<button class="icon" data-act="recCancel" aria-label="Cancel recording">${icon('x')}</button>
      <div class="rec"><i></i><span id="recT">0:00</span></div>
      <button class="icon send" data-act="recSend" aria-label="Send voice message">${icon('send')}</button>`;
    rec.tick = setInterval(() => { const s = (Date.now() - rec.start) / 1000; const el = $('#recT'); if (el) el.textContent = fmtDur(s); if (s > 300) stopRecording(true); }, 250);
  } catch { toast('Microphone not available'); }
}
async function stopRecording(send) {
  if (!rec) return;
  const r = rec; rec = null;
  clearInterval(r.tick);
  const done = new Promise((res) => (r.r.onstop = res));
  r.r.stop(); await done;
  r.stream.getTracks().forEach((t) => t.stop());
  if (route.view === 'chat' && $('#dock')) { $('#dock').innerHTML = ''; const v = await m.conv(route.conv); if (v) renderDock(v); }
  const dur = (Date.now() - r.start) / 1000;
  if (!send || dur < 0.6) return;
  const blob = new Blob(r.chunks, { type: r.mime });
  if (blob.size > 1.9e6) return toast('Voice message too long');
  await m.sendAttachment(r.conv, { bytes: new Uint8Array(await blob.arrayBuffer()), mime: r.mime.split(';')[0], kind: 'voice', meta: { dur: Math.round(dur) } });
}

// walkie-talkie button
function bindPtt() {
  const b = $('#ptt');
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); if (voice.talk(true)) meter(); });
  ['pointerup', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => voice.talk(false)));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}
function meter() {
  const b = $('#ptt'); if (!b || !voice.state?.room?.talking) { b?.style.setProperty('--lvl', 0); return; }
  b.style.setProperty('--lvl', voice.audio.level().toFixed(2)); requestAnimationFrame(meter);
}
const typingTarget = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && voice?.state?.mode === 'ptt' && !typingTarget()) { e.preventDefault(); if (voice.talk(true)) meter(); } });
addEventListener('keyup', (e) => { if (e.code === 'Space' && voice?.state?.mode === 'ptt' && !typingTarget()) { e.preventDefault(); voice.talk(false); } });

// ---------------- incoming messages ----------------
async function onMessage(x) {
  refreshSide();
  const here = route.view === 'chat' && route.conv === x.conv;
  if (here) { await refreshMsgs(x.from === 'me'); if (!document.hidden && x.from !== 'me') m.markRead(x.conv); }
  if (x.from !== 'me' && x.from !== 'system' && (document.hidden || !here) && prefs.notify && window.Notification?.permission === 'granted') {
    const v = await m.conv(x.conv), c = await m.contact(x.from);
    const title = v?.type === 'group' ? `${c?.name ?? 'Someone'} in ${v.name}` : c?.name ?? 'New message';
    const body = x.kind === 'att' ? (x.att?.kind === 'voice' ? 'Voice message' : 'Photo') : x.body;
    try { const n = new Notification(title, { body, tag: x.conv, icon: './icon.svg' }); n.onclick = () => { focus(); go('chat', x.conv); }; } catch {}
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && route.view === 'chat') m?.markRead(route.conv); if (!document.hidden) m?.sync(); });

// ---------------- conversation info ----------------
async function renderInfo() {
  const v = await m.conv(route.conv); if (!v) return go('empty');
  const title = await m.convTitle(v);
  let body = '';
  if (v.type === 'group') {
    const members = (await Promise.all(v.members.map((id) => m.contact(id)))).filter(Boolean);
    body = `<section class="section"><h3>Group name</h3><div class="row"><input class="t" id="gName" value="${esc(v.name)}" maxlength="60" style="flex:3" ${v.left ? 'disabled' : ''} />
        <button class="btn tint small" data-act="gRename" ${v.left ? 'disabled' : ''}>Save</button></div></section>
      <section class="section"><h3>${members.length + 1} members</h3>
        <div class="member">${avatar(m.account.name, m.myId, 40)}<span>${esc(m.account.name)} (you)</span></div>
        ${members.map((c) => `<button class="conv" style="padding:6px 0" data-act="contactInfo" data-id="${c.id}">
          ${avatar(c.name, c.id, 40)}<span class="mid"><b>${esc(c.name)}</b></span>${c.verified ? icon('shield', 'i vbadge') : ''}</button>`).join('')}
        ${v.left ? '' : '<button class="btn tint" data-act="gAdd">Add members</button>'}</section>
      <div id="addPick"></div>
      ${v.left ? '' : '<button class="btn quiet danger" data-act="gLeave">Leave group</button>'}`;
  } else {
    const c = await m.contact(v.id);
    const sn = m.safety(c).split(' ');
    body = `<section class="section"><h3>Safety number</h3><p class="sn">${sn.map((g) => `<span>${g}</span>`).join('')}</p>
        <p class="note">Compare these numbers with ${esc(c.name)} in person or on a call. If they match on both phones, nobody is intercepting your messages.</p>
        <button class="btn ${c.verified ? '' : 'tint'}" data-act="verify" data-id="${c.id}">${c.verified ? 'Clear verification' : 'Mark as verified'}</button></section>`;
  }
  $('#main').innerHTML = `<header class="bar"><button class="icon" data-act="back" aria-label="Back">${icon('back')}</button><h1 style="font-size:17px">${v.type === 'group' ? 'Group info' : 'Contact info'}</h1></header>
    <div class="scroll"><div class="page"><div class="hero">${avatar(title, v.id, 88, v.type === 'group')}<h1 style="font-size:24px">${esc(title)}</h1></div>${body}</div></div>`;
}

async function renderAddPick() {
  const v = await m.conv(route.conv);
  const cs = (await m.contacts()).filter((c) => !v.members.includes(c.id) && !c.viaGroup);
  $('#addPick').innerHTML = cs.length ? `<section class="section"><h3>Add from your contacts</h3>
    ${cs.map((c) => `<label class="pick"><input type="checkbox" value="${c.id}" />${avatar(c.name, c.id, 36)}<span>${esc(c.name)}</span></label>`).join('')}
    <button class="btn primary" data-act="gAddDo">Add to group</button></section>` : '<p class="note">Everyone in your contacts is already here. Invite more people from the pencil button first.</p>';
}

// ---------------- new chat / invite ----------------
async function renderNew(reset = false) {
  const link = await m.myInvite(reset);
  const qr = await QRCode.toString(link, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  const cs = (await m.contacts()).sort((a, b) => a.name.localeCompare(b.name));
  $('#main').innerHTML = `<header class="bar"><button class="icon back" data-act="home" aria-label="Back">${icon('back')}</button><h1 style="font-size:17px">New chat</h1></header>
  <div class="scroll"><div class="page">
    <div class="menu"><button data-act="group"><span class="ic">${icon('group')}</span><span>New group<small>Chat, call and walkie-talkie with several people</small></span></button></div>
    <section class="section"><h3>Your invite link</h3>
      <div class="qr" role="img" aria-label="QR code of your invite link">${qr}</div>
      <p class="note" style="text-align:center">Have someone scan this with their phone’s camera, or send them the link over a channel you trust. Anyone with it can message you.</p>
      <div class="row"><button class="btn tint" data-act="share">${icon('link')} Share link</button><button class="btn tint" data-act="copy">Copy</button></div>
      <button class="btn quiet small" data-act="resetLink">Reset link (links you already shared stop working)</button>
    </section>
    <section class="section"><h3>Got a link from someone?</h3>
      <div class="row"><input class="t" id="pasteLink" placeholder="Paste their invite link" autocomplete="off" style="flex:3" /><button class="btn primary" data-act="addLink">Add</button></div>
    </section>
    ${cs.length ? `<section class="section"><h3>Contacts</h3>${cs.map((c) => `<button class="conv" data-act="dm" data-id="${c.id}" style="padding:8px 0">
      ${avatar(c.name, c.id, 40)}<span class="mid"><b>${esc(c.name)}</b></span></button>`).join('')}</section>` : ''}
  </div></div>`;
  $('#main').dataset.link = link;
}

async function addFromLink(link) {
  try { const id = await m.acceptInvite(link); toast('Contact added'); go('chat', id); }
  catch (e) { toast(e.message, 4000); }
}

async function renderGroupNew() {
  const cs = (await m.contacts()).filter((c) => !c.viaGroup).sort((a, b) => a.name.localeCompare(b.name));
  $('#main').innerHTML = `<header class="bar"><button class="icon" data-act="new" aria-label="Back">${icon('back')}</button><h1 style="font-size:17px">New group</h1></header>
  <div class="scroll"><div class="page">
    <label class="f">Group name<input class="t" id="newGName" maxlength="60" placeholder="Name this group" /></label>
    <section class="section"><h3>Members</h3>${cs.length ? cs.map((c) => `<label class="pick"><input type="checkbox" value="${c.id}" />${avatar(c.name, c.id, 36)}<span>${esc(c.name)}</span></label>`).join('')
      : '<p class="note">Add contacts with your invite link first, then make a group with them.</p>'}</section>
    <button class="btn primary" data-act="groupCreate" ${cs.length ? '' : 'disabled'}>Create group</button>
  </div></div>`;
}

// ---------------- settings ----------------
function renderSettings() {
  const fp = bytesToHex(m.identity.pk).match(/.{4}/g).slice(0, 8).join(' ');
  $('#main').innerHTML = `<header class="bar"><button class="icon back" data-act="home" aria-label="Back">${icon('back')}</button><h1 style="font-size:17px">Settings</h1></header>
  <div class="scroll"><div class="page">
    <section class="section"><h3>Profile</h3><div class="row"><input class="t" id="setName" value="${esc(m.account.name)}" maxlength="40" style="flex:3" />
      <button class="btn tint" data-act="saveName">Save</button></div></section>
    <section class="section"><h3>Notifications</h3><label class="pick"><input type="checkbox" id="setNotify" ${prefs.notify ? 'checked' : ''} /><span>Show a notification for new messages while PQTalk is open</span></label></section>
    <section class="section"><h3>Calls</h3><label class="f">TURN credentials URL (only needed when calls fail on some cellular networks)
      <input class="t" id="setTurn" value="${esc(prefs.turnApi)}" placeholder="https://yourapp.metered.live/api/v1/turn/credentials?apiKey=…" /></label></section>
    <section class="section"><h3>Security</h3><p class="diag">Identity key ${fp}…
Server ${esc(m.account.server)}
Sessions: PQXDH (X25519 + ML-KEM-768), Double Ratchet with an ML-KEM step on every turn
Calls and walkie-talkie: hybrid PQ handshake, SFrame frame encryption over WebRTC</p></section>
    <button class="btn quiet danger" data-act="wipe">Delete all data on this device</button>
  </div></div>`;
}

// ---------------- call overlay ----------------
let callTimer = null, ringT = null;
async function renderOverlay() {
  const s = voice.state;
  clearInterval(callTimer);
  if (overlay.querySelector('.viewer')) return;
  if (!s || s.mode !== 'call' || s.hidden) { overlay.innerHTML = ''; return; }
  const v = await m.conv(s.conv);
  const title = v ? await m.convTitle(v) : 'Call';
  const caller = s.from ? (await m.contact(s.from))?.name : null;
  const status = () => {
    if (s.phase === 'ringing-in') return v?.type === 'group' ? `${esc(caller ?? 'Someone')} is calling the group` : 'Incoming voice call';
    if (s.phase === 'ringing-out') return 'Ringing…';
    if (s.phase === 'connecting') return 'Connecting…';
    const n = s.room ? s.room.peers.size + 1 : 1;
    const t = fmtDur((Date.now() - s.startedAt) / 1000);
    return v?.type === 'group' ? `${t}, ${n} in call` : t;
  };
  overlay.innerHTML = `<div class="sheet" role="dialog" aria-label="Voice call">
    ${avatar(title, s.conv, 112, v?.type === 'group')}<h2>${esc(title)}</h2><p id="callStatus">${status()}</p>
    <div class="acts">${s.phase === 'ringing-in'
      ? `<div><button class="round red" data-act="decline" aria-label="Decline">${icon('hang')}</button><small>Decline</small></div>
         <div><button class="round green" data-act="accept" aria-label="Accept">${icon('phone')}</button><small>Accept</small></div>`
      : `<div><button class="round ${s.muted ? 'on' : ''}" data-act="mute" aria-label="${s.muted ? 'Unmute' : 'Mute'}">${icon(s.muted ? 'micoff' : 'mic')}</button><small>${s.muted ? 'Unmute' : 'Mute'}</small></div>
         <div><button class="round" data-act="hideCall" aria-label="Back to chat">${icon('back')}</button><small>Chat</small></div>
         <div><button class="round red" data-act="hangup" aria-label="End call">${icon('hang')}</button><small>End</small></div>`}</div></div>`;
  if (s.phase === 'live') callTimer = setInterval(() => { const el = $('#callStatus'); if (el) el.innerHTML = status(); }, 1000);
  clearTimeout(ringT);
  if (s.phase === 'ringing-in') ring();
}
function ring() { if (voice.state?.phase !== 'ringing-in') return; if (voice.audio.ctx) voice.audio.tone('permit'); ringT = setTimeout(ring, 1800); }

// ---------------- actions ----------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el || !m) return;
  const act = el.dataset.act;
  try {
    switch (act) {
      case 'open': go('chat', el.dataset.id); break;
      case 'home': go('empty'); break;
      case 'back': go('chat', route.conv); break;
      case 'info': go('info', route.conv); break;
      case 'new': go('new'); break;
      case 'group': go('group'); break;
      case 'settings': go('settings'); break;
      case 'send': sendText(); break;
      case 'attach': $('#file').click(); break;
      case 'record': startRecording(); break;
      case 'recCancel': stopRecording(false); break;
      case 'recSend': stopRecording(true); break;
      case 'play': togglePlay(el.dataset.att); break;
      case 'view': if (el.src) overlay.innerHTML = `<div class="viewer" data-act="closeView"><img src="${el.src}" alt="Photo" /></div>`; break;
      case 'closeView': overlay.innerHTML = ''; renderOverlay(); break;
      case 'call': await voice.call(route.conv); break;
      case 'walkie':
        if (voice.state?.mode === 'ptt' && voice.state.conv === route.conv) voice.leaveWalkie();
        else await voice.walkie(route.conv);
        break;
      case 'walkieLeave': voice.leaveWalkie(); break;
      case 'accept': { const c = voice.state?.conv; go('chat', c ?? route.conv); await voice.accept(); break; }
      case 'decline': voice.decline(); break;
      case 'hangup': voice.hangup(); break;
      case 'mute': voice.setMuted(!voice.state?.muted); break;
      case 'hideCall': voice.state.hidden = true; renderOverlay(); go('chat', voice.state.conv); break;
      case 'showcall': voice.state.hidden = false; renderOverlay(); refreshChatChrome(); break;
      case 'verify': await m.setVerified(el.dataset.id, !(await m.contact(el.dataset.id)).verified); renderInfo(); break;
      case 'contactInfo': await m._ensureConv(el.dataset.id, 'direct'); go('info', el.dataset.id); break;
      case 'dm': await m._ensureConv(el.dataset.id, 'direct'); go('chat', el.dataset.id); break;
      case 'share': {
        const url = $('#main').dataset.link;
        if (navigator.share) { try { await navigator.share({ title: 'Chat with me on PQTalk', url }); break; } catch {} }
        await navigator.clipboard.writeText(url); toast('Invite link copied');
        break;
      }
      case 'copy': await navigator.clipboard.writeText($('#main').dataset.link); toast('Invite link copied'); break;
      case 'resetLink': if (confirm('Reset your invite link? Links you already shared will stop working.')) renderNew(true); break;
      case 'addLink': { const v = $('#pasteLink').value.trim(); if (v) addFromLink(v); break; }
      case 'groupCreate': {
        const name = $('#newGName').value.trim(); const ids = [...document.querySelectorAll('.pick input:checked')].map((i) => i.value);
        if (!name) return toast('Give the group a name');
        if (!ids.length) return toast('Pick at least one member');
        el.disabled = true; go('chat', await m.createGroup(name, ids)); break;
      }
      case 'gRename': { const n = $('#gName').value.trim(); if (n) { await m.renameGroup(route.conv, n); toast('Group renamed'); } break; }
      case 'gAdd': renderAddPick(); break;
      case 'gAddDo': { const ids = [...document.querySelectorAll('#addPick input:checked')].map((i) => i.value); if (ids.length) { await m.addToGroup(route.conv, ids); toast('Members added'); renderInfo(); } break; }
      case 'gLeave': if (confirm('Leave this group? You won’t get its messages anymore.')) { await m.leaveGroup(route.conv); go('chat', route.conv); } break;
      case 'saveName': { const n = $('#setName').value.trim(); if (n) { await m.setName(n); toast('Name saved'); } break; }
      case 'wipe':
        if (confirm('Delete all chats, contacts and keys on this device? This can’t be undone.')) { m.stop(); await wipeAll(); location.reload(); }
        break;
    }
  } catch (err) { toast(err.message, 4000); }
});
document.addEventListener('change', async (e) => {
  if (e.target.id === 'setNotify') {
    if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
      e.target.checked = (await Notification.requestPermission()) === 'granted';
    }
    prefs.notify = e.target.checked; LS.set('prefs', prefs);
  }
  if (e.target.id === 'setTurn') { prefs.turnApi = e.target.value.trim(); LS.set('prefs', prefs); toast('Saved; applies to your next call'); }
});
addEventListener('hashchange', () => {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('i') && m?.account) { const link = location.hash; history.replaceState(null, '', location.pathname + location.search); addFromLink(link); }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
boot();
window.__pq = { get m() { return m; }, get voice() { return voice; } }; // for tests and debugging
