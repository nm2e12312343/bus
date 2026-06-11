'use strict';

/* ============================================================
   ABFAHRT. — app logic
   Sections: utils · seed data · state & sync · audio ·
             SVG builders (van, scenes) · views · actions · departure
   ============================================================ */

/* ---------- utils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (ts) =>
  new Date(ts).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- template helpers ---------- */
function zone(name, labels) {
  return { name, items: labels.map((label) => ({ id: uid(), label })) };
}
/* Device-wide template library: built by hand, copied into every new trip. */
const loadTemplatesLib = () => JSON.parse(localStorage.getItem('crafter_templates') || '[]');
const saveTemplatesLib = () => localStorage.setItem('crafter_templates', JSON.stringify(S.templates));

/* ---------- state ---------- */
const urlRoom = new URLSearchParams(location.search).get('room');
let local = JSON.parse(localStorage.getItem('abfahrt:local') || 'null') || {
  sound: false, theme: 'day', meId: null, tab: 'checklist', room: null,
};
let room = null;
let KEY = null;
const newRoomCode = () => 'CRAFT-' + Math.random().toString(36).slice(2, 6).toUpperCase();

function freshState() {
  // Copy the device library into the trip so the crew receives the templates via sync.
  const templates = JSON.parse(JSON.stringify(loadTemplatesLib()));
  return {
    // ts: 0 — a fresh local state must always lose against the real room state,
    // otherwise someone joining via code overwrites the owner's trip.
    v: 1, ts: 0,
    van: 'The Crafter',
    trip: { name: 'Neue Tour', departAt: '', templateId: templates[0]?.id ?? null, startedAt: null },
    templates,
    checked: {},
    crew: [{ id: 'c-owner', name: 'Owner', role: 'owner' }],
  };
}
let S = null;
let sync = null;

function saveLocal() { localStorage.setItem('abfahrt:local', JSON.stringify(local)); }

/* ---------- sync adapter ----------
   Primary: PartyKit WebSocket — real cross-device sync.
   Fallback: BroadcastChannel for same-browser tab sync when WS is offline. */
const PARTYKIT_HOST = (() => {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '') return 'localhost:1999';
  return 'abfahrt-sync.nm2e12312343.partykit.dev';
})();
const WS_PROTO = PARTYKIT_HOST.startsWith('localhost') ? 'ws:' : 'wss:';

function createSync(roomCode, onRemote) {
  const SRC = uid();

  // BroadcastChannel keeps same-browser tabs in sync instantly
  const bc = 'BroadcastChannel' in self ? new BroadcastChannel('abfahrt:' + roomCode) : null;
  if (bc) {
    bc.onmessage = (e) => {
      const m = e.data;
      if (!m || m.src === SRC) return;
      if (m.type === 'hello') bc.postMessage({ type: 'state', src: SRC, state: S });
      if (m.type === 'state' && m.state && m.state.ts > S.ts) onRemote(m.state);
    };
    bc.postMessage({ type: 'hello', src: SRC });
  }

  // PartyKit WebSocket for real cross-device sync
  let ws = null;
  let retryTimer = null;
  let closed = false;
  const chip = document.getElementById('roomChip');

  function setStatus(ok) {
    if (chip) chip.dataset.wsOk = ok ? '1' : '0';
  }

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(`${WS_PROTO}//${PARTYKIT_HOST}/party/${encodeURIComponent(roomCode)}`);
      ws.onopen = () => setStatus(true);
      ws.onmessage = (e) => {
        try {
          const incoming = JSON.parse(e.data);
          if (incoming.ts > S.ts) onRemote(incoming);
        } catch {}
      };
      ws.onclose = () => {
        ws = null;
        setStatus(false);
        if (!closed) retryTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws && ws.close();
    } catch {
      setStatus(false);
      if (!closed) retryTimer = setTimeout(connect, 5000);
    }
  }

  connect();

  return {
    send(state) {
      if (bc) bc.postMessage({ type: 'state', src: SRC, state });
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(state));
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      if (bc) bc.close();
      if (ws) ws.close();
    },
  };
}
/* Boot into a room: load (or seed) its state, open sync, pin the URL. */
function bootRoom(code) {
  if (sync) sync.close();
  room = code;
  KEY = 'abfahrt:' + room;
  local.room = room;
  S = JSON.parse(localStorage.getItem(KEY) || 'null') || freshState();
  if (!local.meId || !S.crew.some((c) => c.id === local.meId)) local.meId = S.crew[0].id;
  saveLocal();
  sync = createSync(room, (remote) => {
    S = remote;
    localStorage.setItem(KEY, JSON.stringify(S));
    recordTrip();
    render();
  });
  if (location.protocol !== 'file:') history.replaceState(null, '', location.pathname + '?room=' + room);
  lastP = progress();
  prevRoadP = null;
  recordTrip();
  render();
}

function commit() {
  S.ts = Date.now();
  localStorage.setItem(KEY, JSON.stringify(S));
  if (sync) sync.send(S);
  recordTrip();
  render();
}

/* Template mutations also mirror into the device library. */
function commitTemplates() {
  saveTemplatesLib();
  commit();
}

/* ---------- trip history (crafter_trips) ---------- */
const loadTrips = () => JSON.parse(localStorage.getItem('crafter_trips') || '[]');
const saveTrips = (t) => localStorage.setItem('crafter_trips', JSON.stringify(t));

/* Upsert this room's logbook entry; completedAt mirrors departure unless overridden. */
function recordTrip(extra = {}) {
  if (!room || !S) return;
  const trips = loadTrips();
  let t = trips.find((x) => x.code === room);
  if (!t) { t = { code: room, startedAt: Date.now() }; trips.push(t); }
  t.name = S.trip.name;
  t.template = tpl()?.type ?? null;
  t.progress = Math.round(progress() * 100);
  t.completedAt = S.trip.startedAt || null;
  Object.assign(t, extra);
  saveTrips(trips);
}

/* ---------- derived ---------- */
const tpl = () => S.templates.find((t) => t.id === S.trip.templateId) || S.templates[0] || null;
const allItems = () => { const t = tpl(); return t ? t.zones.flatMap((z) => z.items) : []; };
const progress = () => {
  const it = allItems();
  if (!it.length) return 0;
  return it.filter((i) => S.checked[i.id]).length / it.length;
};
const me = () => S.crew.find((c) => c.id === local.meId) || S.crew[0];
const canEdit = () => ['owner', 'edit'].includes(me().role);
const isOwner = () => me().role === 'owner';

/* ---------- audio (synthesized, no assets) ---------- */
let AC = null;
const ac = () => AC || (AC = new (window.AudioContext || window.webkitAudioContext)());
function sndClick() {
  try {
    const a = ac(), t = a.currentTime;
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.08);
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g).connect(a.destination);
    o.start(t); o.stop(t + 0.14);
  } catch { /* audio unavailable */ }
}
function sndEngine() {
  try {
    const a = ac(), t = a.currentTime, dur = 4.6;
    const o = a.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(34, t);
    o.frequency.linearRampToValueAtTime(82, t + 1.6);
    o.frequency.linearRampToValueAtTime(60, t + dur);
    const lfo = a.createOscillator(); lfo.frequency.value = 11;
    const lg = a.createGain(); lg.gain.value = 9;
    lfo.connect(lg).connect(o.frequency);
    const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 240;
    const g = a.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.5);
    g.gain.setValueAtTime(0.3, t + dur - 1);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(f).connect(g).connect(a.destination);
    o.start(t); lfo.start(t); o.stop(t + dur); lfo.stop(t + dur);
  } catch { /* audio unavailable */ }
}

/* ---------- ambient loop (landing hero: engine idle + wind) ---------- */
let ambient = null;
function startAmbient() {
  if (ambient) return;
  try {
    const a = ac(), t = a.currentTime;
    const master = a.createGain();
    master.gain.setValueAtTime(0, t);
    master.gain.linearRampToValueAtTime(0.16, t + 1.4);
    master.connect(a.destination);
    // engine at idle: low sawtooth with a slow rpm wobble
    const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 44;
    const wob = a.createOscillator(); wob.frequency.value = 7.5;
    const wg = a.createGain(); wg.gain.value = 3.5;
    wob.connect(wg).connect(o.frequency);
    const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 150;
    const og = a.createGain(); og.gain.value = 0.5;
    o.connect(f).connect(og).connect(master);
    // wind: looped noise through a slowly swaying bandpass
    const len = a.sampleRate * 2;
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const n = a.createBufferSource(); n.buffer = buf; n.loop = true;
    const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 320; bp.Q.value = 0.6;
    const sway = a.createOscillator(); sway.frequency.value = 0.13;
    const sg = a.createGain(); sg.gain.value = 140;
    sway.connect(sg).connect(bp.frequency);
    const ng = a.createGain(); ng.gain.value = 0.22;
    n.connect(bp).connect(ng).connect(master);
    o.start(); wob.start(); n.start(); sway.start();
    ambient = { master, stops: [o, wob, n, sway] };
  } catch { ambient = null; }
}
function stopAmbient() {
  if (!ambient) return;
  const amb = ambient;
  ambient = null;
  try {
    amb.master.gain.linearRampToValueAtTime(0, ac().currentTime + 0.4);
  } catch { /* already gone */ }
  setTimeout(() => amb.stops.forEach((x) => { try { x.stop(); } catch {} }), 500);
}

/* ============================================================
   SVG BUILDERS
   ============================================================ */

/* The Crafter, facing right. Built fresh each time (no <use>) so
   document CSS can reach the wheel/lamp classes. */
function vanSVG(type) {
  const P = 'v' + uid();
  const wheel = (cx) => `
    <g transform="translate(${cx},196)">
      <circle r="35" fill="#1c2528"/><circle r="33" fill="#28343a"/>
      <g class="wheelspin">
        <circle r="19" fill="#d8dcd4"/>
        <circle r="18.5" fill="none" stroke="#9aa59e" stroke-width="1.5"/>
        ${[0, 72, 144, 216, 288].map((a) =>
          `<rect x="-2.4" y="-17" width="4.8" height="13" rx="2" fill="#75807a" transform="rotate(${a})"/>`).join('')}
        <circle r="5" fill="#5b655f"/>
        <circle cy="-11" r="1.8" fill="#39423d"/>
      </g>
    </g>`;
  const acc = {
    beach: `<g>
      <path d="M70 30 Q170 12 292 26 Q170 46 70 30 Z" fill="#f4e8ce" stroke="#16323c" stroke-width="2"/>
      <path d="M92 29 Q176 18 270 27" fill="none" stroke="#ffa019" stroke-width="3"/>
      <rect x="124" y="22" width="6" height="16" rx="2" fill="#16323c"/>
      <rect x="232" y="20" width="6" height="16" rx="2" fill="#16323c"/>
    </g>`,
    mountain: `<g>
      <rect x="92" y="20" width="168" height="19" rx="9.5" fill="#1f3a45" stroke="#0d2027" stroke-width="1.5"/>
      <circle cx="124" cy="29.5" r="2.2" fill="#efe9dc" opacity="0.8"/>
      <circle cx="228" cy="29.5" r="2.2" fill="#efe9dc" opacity="0.8"/>
    </g>`,
    city: '',
  }[type] || '';

  return `<svg class="van" viewBox="0 0 500 250" aria-hidden="true">
    <defs>
      <linearGradient id="${P}-glass" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#bcd6d8"/><stop offset="1" stop-color="#7fa6ab"/>
      </linearGradient>
      <linearGradient id="${P}-beam" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#ffe9b0" stop-opacity="0.9"/>
        <stop offset="1" stop-color="#ffe9b0" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="${P}-body">
        <path d="M44 200 L44 78 Q44 58 64 56 L286 47 Q314 45 330 62 L362 104 L398 111 Q412 114 414 130 L414 176 Q414 192 399 196 L362 199 A37 37 0 0 0 288 199 L172 199 A37 37 0 0 0 98 199 L52 199 Q44 199 44 192 Z"/>
      </clipPath>
    </defs>
    <g class="van-rig">
      <ellipse cx="226" cy="234" rx="186" ry="9" fill="rgba(10,22,26,0.3)"/>
      <polygon class="beam" points="416,124 500,106 500,160 416,144" fill="url(#${P}-beam)"/>
      ${acc}
      <rect x="88" y="40" width="118" height="12" rx="2" fill="#24414d"/>
      <path d="M118 40 v12 M148 40 v12 M178 40 v12" stroke="#efe9dc" stroke-width="1.2" opacity="0.35"/>
      <rect x="224" y="38" width="40" height="14" rx="3" fill="#d8dcd4" stroke="#16323c" stroke-opacity="0.3"/>
      <path d="M44 200 L44 78 Q44 58 64 56 L286 47 Q314 45 330 62 L362 104 L398 111 Q412 114 414 130 L414 176 Q414 192 399 196 L362 199 A37 37 0 0 0 288 199 L172 199 A37 37 0 0 0 98 199 L52 199 Q44 199 44 192 Z"
        fill="#f2ede0" stroke="#16323c" stroke-width="2.5" stroke-linejoin="round"/>
      <g clip-path="url(#${P}-body)">
        <rect x="40" y="140" width="380" height="12" fill="#ffa019"/>
        <rect x="40" y="154" width="380" height="7" fill="#16323c"/>
        <rect x="360" y="176" width="60" height="26" fill="#25333a"/>
        <rect x="40" y="186" width="330" height="16" fill="#e6dfcd"/>
      </g>
      <path d="M298 60 Q313 59 322 70 L350 106 L296 109 Z" fill="url(#${P}-glass)" stroke="#16323c" stroke-width="2"/>
      <path d="M304 64 L318 80" stroke="#ffffff" stroke-width="3" opacity="0.55" stroke-linecap="round"/>
      <path d="M238 64 L290 62 L290 110 L238 112 Z" fill="url(#${P}-glass)" stroke="#16323c" stroke-width="2"/>
      <g>
        <rect x="84" y="70" width="132" height="46" rx="9" fill="url(#${P}-glass)" stroke="#16323c" stroke-width="2"/>
        <path d="M90 74 q4 20 16 36 l-16 2 Z" fill="#dcc9a2" opacity="0.95"/>
        <path d="M210 74 q-4 20 -16 36 l16 2 Z" fill="#dcc9a2" opacity="0.95"/>
      </g>
      <path d="M232 60 L232 196" stroke="#16323c" stroke-width="1.5" opacity="0.3"/>
      <path d="M294 62 L294 140" stroke="#16323c" stroke-width="1.5" opacity="0.3"/>
      <rect x="244" y="122" width="26" height="6" rx="3" fill="#16323c"/>
      <rect x="300" y="122" width="20" height="6" rx="3" fill="#16323c"/>
      <path d="M330 64 L342 64" stroke="#16323c" stroke-width="2"/>
      <rect x="338" y="60" width="11" height="17" rx="3" fill="#16323c"/>
      <g fill="#16323c" opacity="0.85">
        <rect x="378" y="158" width="30" height="3" rx="1.5"/>
        <rect x="378" y="165" width="30" height="3" rx="1.5"/>
        <rect x="378" y="172" width="30" height="3" rx="1.5"/>
      </g>
      <circle cx="392" cy="148" r="6" fill="none" stroke="#16323c" stroke-width="2"/>
      <rect x="400" y="122" width="13" height="15" rx="3" fill="#fff3cf" stroke="#c9a85a" stroke-width="1.5"/>
      <circle class="blinker" cx="407" cy="146" r="4" fill="#ffa019"/>
      <rect x="44" y="122" width="7" height="17" rx="2" fill="#c9442e"/>
      <circle class="blinker" cx="48" cy="148" r="3.5" fill="#ffa019"/>
      <g fill="#b9c2bc">
        <circle class="puff" cx="38" cy="194" r="6" style="--pd:0s"/>
        <circle class="puff" cx="38" cy="194" r="6" style="--pd:0.35s"/>
        <circle class="puff" cx="38" cy="194" r="6" style="--pd:0.7s"/>
      </g>
      ${wheel(135)}${wheel(325)}
    </g>
  </svg>`;
}

/* Landscape scenes. viewBox 1600×1400, bottom-anchored slice; the focal
   composition sits in x 500–1100 so portrait crops still frame it. Layers
   extend to x≈2600 to survive the parallax drift. */
function sceneSVG(type) {
  const P = 's' + uid();
  const road = `
    <g class="l-road">
      <rect x="-200" y="1240" width="3000" height="180" fill="#1a2125"/>
      <rect x="-200" y="1240" width="3000" height="5" fill="#2a3338"/>
      ${Array.from({ length: 22 }, (_, i) =>
        `<rect x="${-160 + i * 140}" y="1314" width="56" height="9" rx="3" fill="#e8dfc8" opacity="0.85"/>`).join('')}
    </g>`;

  let defs = '', far = '', mid = '', near = '';

  if (type === 'beach') {
    defs = `<linearGradient id="${P}-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe3b3"/><stop offset="0.5" stop-color="#ffb870"/>
      <stop offset="0.78" stop-color="#e8845c"/><stop offset="1" stop-color="#c96a52"/>
    </linearGradient>`;
    far = `
      <circle cx="850" cy="930" r="150" fill="#fff3d0" opacity="0.35"/>
      <circle cx="850" cy="930" r="105" fill="#fff3d0"/>
      <path d="M540 700 q14 -10 28 0 q14 10 28 0" stroke="#8a5a48" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M1080 620 q11 -8 22 0 q11 8 22 0" stroke="#8a5a48" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <rect x="-200" y="1016" width="3000" height="124" fill="#3e7e86"/>
      <rect x="-200" y="1016" width="3000" height="4" fill="#fff3d0" opacity="0.5"/>
      ${Array.from({ length: 16 }, (_, i) =>
        `<rect x="${60 + i * 170 + (i * 53) % 40}" y="${1040 + (i * 37) % 60}" width="${36 + (i * 29) % 30}" height="3" rx="1.5" fill="#ffe9c4" opacity="0.55"/>`).join('')}`;
    mid = `
      <path d="M-200 1140 Q200 1080 560 1118 T1280 1108 T2000 1120 T2700 1100 L2800 1400 L-200 1400 Z" fill="#d2a876"/>`;
    near = `
      <path d="M-200 1196 Q300 1148 760 1180 T1600 1172 T2400 1186 L2800 1400 L-200 1400 Z" fill="#c09465"/>
      ${Array.from({ length: 14 }, (_, i) => {
        const x = 80 + i * 190 + (i * 71) % 50, y = 1190 + (i * 31) % 36;
        return `<path d="M${x} ${y} q-7 -26 -3 -34 M${x} ${y} q2 -26 9 -32 M${x} ${y} q9 -20 15 -23" stroke="#7a6a45" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
      }).join('')}`;
  } else if (type === 'mountain') {
    defs = `<linearGradient id="${P}-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2b4d"/><stop offset="0.55" stop-color="#41557a"/>
      <stop offset="0.82" stop-color="#8f7a82"/><stop offset="1" stop-color="#c98f6b"/>
    </linearGradient>`;
    const peaks = (pts, fill) => `<path d="${pts}" fill="${fill}"/>`;
    far = `
      <circle cx="1040" cy="420" r="64" fill="#e8e4d8"/>
      <circle cx="1062" cy="404" r="58" fill="#1b2b4d"/>
      ${Array.from({ length: 26 }, (_, i) =>
        `<circle cx="${(i * 311) % 1600}" cy="${80 + (i * 197) % 460}" r="${1.4 + (i % 3) * 0.7}" fill="#e8e4d8" opacity="${0.4 + (i % 4) * 0.13}"/>`).join('')}
      ${peaks('M-200 1160 L240 700 L420 880 L640 600 L900 940 L1120 660 L1380 980 L1620 760 L1900 1000 L2160 720 L2460 1020 L2800 860 L2800 1400 L-200 1400 Z', '#33425f')}
      <path d="M240 700 L300 770 L260 768 L330 845 L200 840 Z M1120 660 L1180 738 L1138 734 L1205 812 L1062 800 Z M2160 720 L2216 792 L2178 788 L2240 858 L2108 850 Z" fill="#e8e4d8" opacity="0.9"/>`;
    mid = `${peaks('M-200 1230 L160 880 L400 1080 L700 830 L1020 1110 L1300 900 L1620 1130 L1960 920 L2300 1140 L2620 980 L2800 1400 L-200 1400 Z', '#243450')}
      <rect x="-200" y="1130" width="3000" height="60" fill="#9fb0c5" opacity="0.22"/>`;
    near = Array.from({ length: 30 }, (_, i) => {
      const x = -160 + i * 95 + (i * 41) % 30;
      const h = 90 + (i * 67) % 70, base = 1252;
      return `<path d="M${x} ${base} L${x + 26} ${base - h} L${x + 52} ${base} Z M${x + 6} ${base - h * 0.45} L${x + 26} ${base - h - h * 0.32} L${x + 46} ${base - h * 0.45} Z" fill="#131f2c"/>`;
    }).join('');
  } else {
    defs = `<linearGradient id="${P}-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0e1830"/><stop offset="0.6" stop-color="#22386a"/>
      <stop offset="0.88" stop-color="#7a5a64"/><stop offset="1" stop-color="#e0995c"/>
    </linearGradient>`;
    far = `
      ${Array.from({ length: 30 }, (_, i) =>
        `<circle cx="${(i * 277) % 1600}" cy="${60 + (i * 173) % 540}" r="${1.2 + (i % 3) * 0.6}" fill="#efe9dc" opacity="${0.35 + (i % 4) * 0.14}"/>`).join('')}
      <circle cx="980" cy="380" r="46" fill="#efe9dc" opacity="0.9"/>
      ${Array.from({ length: 19 }, (_, i) => {
        const x = -180 + i * 150, w = 96 + (i * 37) % 50, h = 220 + (i * 101) % 260;
        const wins = Array.from({ length: 12 }, (_, j) =>
          ((i + j) % 3 === 0)
            ? `<rect x="${x + 12 + (j % 3) * 26}" y="${1248 - h + 24 + Math.floor(j / 3) * 44}" width="11" height="15" fill="#f8c871" opacity="0.85"/>`
            : '').join('');
        return `<rect x="${x}" y="${1248 - h}" width="${w}" height="${h}" fill="#1b2c4f"/>${wins}`;
      }).join('')}`;
    mid = Array.from({ length: 14 }, (_, i) => {
      const x = -150 + i * 205, w = 130 + (i * 53) % 60, h = 360 + (i * 131) % 320;
      const wins = Array.from({ length: 16 }, (_, j) =>
        ((i * 5 + j) % 4 === 0)
          ? `<rect x="${x + 16 + (j % 4) * 28}" y="${1250 - h + 30 + Math.floor(j / 4) * 60}" width="12" height="17" fill="#ffd98e" opacity="0.9"/>`
          : '').join('');
      return `<rect x="${x}" y="${1250 - h}" width="${w}" height="${h}" fill="#14223d"/>${wins}<rect x="${x + w * 0.32}" y="${1250 - h - 14}" width="4" height="14" fill="#14223d"/>`;
    }).join('');
    near = Array.from({ length: 8 }, (_, i) => {
      const x = 40 + i * 360;
      return `<g>
        <rect x="${x}" y="1108" width="7" height="134" fill="#0c1424"/>
        <rect x="${x - 16}" y="1100" width="39" height="9" rx="4" fill="#0c1424"/>
        <circle cx="${x + 20}" cy="1112" r="9" fill="#ffd98e"/>
        <circle cx="${x + 20}" cy="1112" r="26" fill="#ffd98e" opacity="0.16"/>
      </g>`;
    }).join('') + `<rect x="-200" y="1238" width="3000" height="4" fill="#2c3a55"/>`;
  }

  return `<svg viewBox="0 0 1600 1400" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs>${defs}</defs>
    <rect x="-200" y="0" width="3000" height="1400" fill="url(#${P}-sky)"/>
    <g class="l-far">${far}</g>
    <g class="l-mid">${mid}</g>
    <g class="l-near">${near}</g>
    ${road}
  </svg>`;
}

/* ============================================================
   VIEWS
   ============================================================ */
let justStamped = null;
let prevRoadP = null;
let editingTpl = null;
let lastP = 0;

function vChecklist() {
  const t = tpl();
  if (!t) {
    return `
    <p class="kicker">${esc(S.van)} · Pre-departure</p>
    <h1 class="trip-title">${esc(S.trip.name)}</h1>
    <div class="card">
      <h3>Noch kein Template</h3>
      <p class="footnote">Leg im Templates-Tab deine erste Checkliste an — sie wird auf diesem Gerät gespeichert und steht in jeder neuen Tour zur Verfügung.</p>
      <div class="btn-row"><button class="btn amber" data-action="gotoTemplates">Templates öffnen</button></div>
    </div>`;
  }
  const it = allItems();
  const done = it.filter((i) => S.checked[i.id]).length;
  const p = it.length ? done / it.length : 0;
  const my = me();
  const dep = S.trip.departAt ? fmtDateTime(new Date(S.trip.departAt).getTime()) : null;

  let idx = 0;
  const zones = t.zones.map((z, zi) => {
    const zdone = z.items.filter((i) => S.checked[i.id]).length;
    const rows = z.items.map((i) => {
      const ck = S.checked[i.id];
      const rot = (hash(i.id) % 9) - 4;
      return `<li>
        <button class="item ${ck ? 'done' : ''} ${justStamped === i.id ? 'fresh' : ''} ${canEdit() ? '' : 'locked'}"
          data-action="toggle" data-id="${i.id}" ${canEdit() ? '' : 'disabled'}>
          <span class="box">${ck ? '<svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg>' : ''}</span>
          <span class="item-label"><span class="item-text">${esc(i.label)}</span>
            ${ck ? `<span class="item-meta"><b>✓ ${esc(ck.by)}</b> · ${fmtTime(ck.at)}</span>` : ''}
          </span>
          ${ck ? `<span class="stamp" style="--r:${rot}deg">GEPRÜFT</span>` : ''}
        </button>
      </li>`;
    }).join('');
    idx = zi + 1;
    return `<section class="zone">
      <div class="zone-head">
        <span class="zone-idx">${String(zi + 1).padStart(2, '0')}</span>
        <span class="zone-name">${esc(z.name)}</span>
        <span class="zone-count">${zdone}/${z.items.length}</span>
      </div>
      <ul class="items">${rows || '<li class="empty-note">Nothing here yet — add items in Templates.</li>'}</ul>
    </section>`;
  }).join('');

  const remaining = it.length - done;
  return `<div class="cl ${remaining === 1 ? 'final-stretch' : ''}">
    <p class="kicker">${esc(S.van)} · Pre-departure</p>
    <h1 class="trip-title">${esc(S.trip.name)}</h1>
    <div class="trip-meta">
      <span class="chip">${esc(t.name)}</span>
      ${dep ? `<span class="chip amber">Departure ${esc(dep)}</span>` : ''}
      ${my.role === 'view' ? '<span class="chip">View only</span>' : ''}
    </div>
    ${S.trip.startedAt ? `
      <div class="banner">
        <span>Underway · departed ${fmtTime(S.trip.startedAt)} — Gute Fahrt!</span>
        <button class="btn small" data-action="newTrip">New trip</button>
      </div>` : ''}
    <div class="road-head">
      <span class="road-count">${remaining === 1 ? 'One latch to go.' : `${done} of ${it.length} checked`}</span>
      <span class="road-pct ${justStamped ? 'pop' : ''}">${Math.round(p * 100)}%${p === 1 ? '<span class="ready">READY</span>' : ''}</span>
    </div>
    <div class="road">
      <div class="road-strip"></div>
      <div class="road-van">${vanSVG(t.type)}</div>
      <div class="road-goal">ZIEL</div>
    </div>
    ${zones}</div>`;
}

function vTemplates() {
  const cards = S.templates.map((t, ti) => {
    const n = t.zones.reduce((s, z) => s + z.items.length, 0);
    const active = t.id === S.trip.templateId;
    const editing = editingTpl === t.id;
    const editor = editing ? `
      <div class="tpl-editor">
        <div class="field"><label>Name</label>
          <input type="text" value="${esc(t.name)}" data-field="tplName" data-tpl="${t.id}"></div>
        <div class="field"><label>Landscape</label>
          <select data-field="tplType" data-tpl="${t.id}">
            ${['beach', 'mountain', 'city'].map((ty) =>
              `<option value="${ty}" ${t.type === ty ? 'selected' : ''}>${ty[0].toUpperCase() + ty.slice(1)}</option>`).join('')}
          </select></div>
        ${t.zones.map((z, zi) => `
          <div class="tpl-zone">
            <div class="tpl-zone-head">
              <input type="text" value="${esc(z.name)}" data-field="zoneName" data-tpl="${t.id}" data-z="${zi}">
              <button class="iconbtn" data-action="rmZone" data-tpl="${t.id}" data-z="${zi}" title="Remove zone">×</button>
            </div>
            ${z.items.map((i, ii) => `
              <div class="tpl-item-row">
                <input type="text" value="${esc(i.label)}" data-field="itemLabel" data-tpl="${t.id}" data-z="${zi}" data-i="${ii}">
                <button class="iconbtn" data-action="rmItem" data-tpl="${t.id}" data-z="${zi}" data-i="${ii}" title="Remove item">×</button>
              </div>`).join('')}
            <div class="btn-row">
              <button class="btn ghost small" data-action="addItem" data-tpl="${t.id}" data-z="${zi}">+ Item</button>
            </div>
          </div>`).join('')}
        <div class="btn-row">
          <button class="btn ghost small" data-action="addZone" data-tpl="${t.id}">+ Zone</button>
          <button class="btn danger small" data-action="rmTpl" data-tpl="${t.id}" ${active ? 'disabled' : ''}>Delete</button>
        </div>
      </div>` : '';
    return `<div class="card tpl-card">
      <div class="tpl-thumb">${sceneSVG(t.type)}<span class="tpl-type">${esc(t.type)}</span><span class="tpl-no">DOSSIER ${String(ti + 1).padStart(2, '0')}</span></div>
      <div class="tpl-body">
        <div class="tpl-name">${esc(t.name)}${active ? '<span class="tpl-active-tag">ACTIVE</span>' : ''}</div>
        <div class="tpl-sub">${t.zones.length} zones · ${n} items</div>
        <div class="btn-row">
          ${active ? '' : `<button class="btn amber small" data-action="useTpl" data-tpl="${t.id}">Use for this trip</button>`}
          <button class="btn ghost small" data-action="toggleEdit" data-tpl="${t.id}">${editing ? 'Done' : 'Edit'}</button>
          <button class="btn ghost small" data-action="dupTpl" data-tpl="${t.id}">Duplicate</button>
        </div>
        ${editor}
      </div>
    </div>`;
  }).join('');

  return `
    <p class="kicker">Trip presets</p>
    <h1 class="trip-title">Templates</h1>
    ${cards || '<p class="empty-note">Noch keine Templates — leg unten dein erstes an. Es wird auf diesem Gerät gespeichert und in jede neue Tour übernommen.</p>'}
    <div class="btn-row"><button class="btn" data-action="newTpl">+ New template</button></div>`;
}

function vCrew() {
  const my = me();
  const total = allItems().length;
  const counts = {};
  for (const id in S.checked) {
    const by = S.checked[id].by;
    counts[by] = (counts[by] || 0) + 1;
  }
  const C = 2 * Math.PI * 20;
  const rows = S.crew.map((c) => {
    const n = counts[c.name] || 0;
    const frac = total ? n / total : 0;
    return `
    <div class="crew-row">
      <span class="avatar-wrap">
        <svg class="ring" viewBox="0 0 44 44" aria-hidden="true">
          <circle class="ring-bg" cx="22" cy="22" r="20"/>
          <circle class="ring-fg" cx="22" cy="22" r="20"
            style="stroke-dasharray:${C.toFixed(1)}; stroke-dashoffset:${(C * (1 - frac)).toFixed(1)}"/>
        </svg>
        <span class="avatar">${esc(c.name.trim()[0] || '?').toUpperCase()}</span>
      </span>
      <span class="crew-name">${esc(c.name)}
        <span class="role-tag">${c.role} · ${n}/${total} checked</span>
      </span>
      ${isOwner() && c.role !== 'owner' ? `
        <select data-field="crewRole" data-id="${c.id}">
          <option value="edit" ${c.role === 'edit' ? 'selected' : ''}>Can edit</option>
          <option value="view" ${c.role === 'view' ? 'selected' : ''}>View only</option>
        </select>
        <button class="iconbtn" data-action="rmCrew" data-id="${c.id}" title="Remove">×</button>` : ''}
    </div>`;
  }).join('');

  const link = location.origin === 'null'
    ? location.pathname + '?room=' + room
    : location.origin + location.pathname + '?room=' + room;

  return `
    <p class="kicker">Who's aboard</p>
    <h1 class="trip-title">Crew</h1>
    <div class="card">
      <h3>Checking off as</h3>
      <div class="me-chips">
        ${S.crew.map((c) =>
          `<button class="me-chip ${c.id === my.id ? 'on' : ''}" data-action="setMe" data-id="${c.id}">${esc(c.name)}</button>`).join('')}
      </div>
      <p class="footnote">Pick who you are on this device — check-offs get stamped with that name.</p>
    </div>
    <div class="card">
      <h3>Crew list</h3>
      ${rows}
      ${isOwner() ? `
        <div class="add-row">
          <input type="text" id="newCrewName" placeholder="Name" maxlength="24">
          <select id="newCrewRole"><option value="edit">Can edit</option><option value="view">View only</option></select>
          <button class="btn amber small" data-action="addCrew">Add</button>
        </div>` : ''}
    </div>
    <div class="card">
      <h3>Invite link</h3>
      <button class="invite-link" data-action="copyInvite" title="Tap to copy">${esc(link)}</button>
      <div class="btn-row">
        <button class="btn small" data-action="copyInvite">Copy link</button>
        <span class="chip amber">Trip code ${esc(room)}</span>
      </div>
      <p class="footnote">Sync runs over PartyKit WebSockets — changes appear on every device in real time. The dot in the header shows your connection status.</p>
    </div>`;
}

function vSettings() {
  return `
    <p class="kicker">The rig & the trip</p>
    <h1 class="trip-title">Settings</h1>
    <div class="card">
      <h3>Trip</h3>
      <div class="field"><label>Trip name</label>
        <input type="text" value="${esc(S.trip.name)}" data-field="tripName" maxlength="48"></div>
      <div class="field"><label>Departure</label>
        <input type="datetime-local" value="${esc(S.trip.departAt)}" data-field="departAt"></div>
      <div class="field"><label>Van name</label>
        <input type="text" value="${esc(S.van)}" data-field="vanName" maxlength="32"></div>
    </div>
    <div class="card">
      <h3>Cabin lights</h3>
      <div class="switchrow">
        <span class="lbl">Night drive theme<span class="sub">Deepwater cabin, amber lamps</span></span>
        <label class="switch"><input type="checkbox" data-field="themeT" ${local.theme === 'night' ? 'checked' : ''}><span class="knob"></span></label>
      </div>
      <div class="switchrow">
        <span class="lbl">Sound<span class="sub">Engine rumble & check clicks (synthesized)</span></span>
        <label class="switch"><input type="checkbox" data-field="soundT" ${local.sound ? 'checked' : ''}><span class="knob"></span></label>
      </div>
    </div>
    <div class="card">
      <h3>Notifications</h3>
      <div class="switchrow">
        <span class="lbl">Departure reminder<span class="soon">SOON</span></span>
        <label class="switch"><input type="checkbox" disabled><span class="knob"></span></label>
      </div>
      <div class="switchrow">
        <span class="lbl">Crew check-off pings<span class="soon">SOON</span></span>
        <label class="switch"><input type="checkbox" disabled><span class="knob"></span></label>
      </div>
    </div>
    <div class="card">
      <h3>Sequence</h3>
      <div class="btn-row">
        <button class="btn amber" data-action="preview">Preview departure</button>
        <button class="btn danger" data-action="resetTrip">Reset checklist</button>
      </div>
    </div>
    <div class="card">
      <h3>Archive</h3>
      <p class="footnote">Stamps this trip complete, files it in the logbook on the landing page, and clears the checklist for the next run.</p>
      <div class="btn-row">
        <button class="btn danger" data-action="archiveTrip">Archive this trip</button>
      </div>
    </div>`;
}

/* ---------- render ---------- */
const VIEW = $('#view');
function render() {
  if (!S) return;
  document.documentElement.dataset.theme = local.theme;
  $('#roomChip').textContent = room;
  VIEW.innerHTML =
    local.tab === 'checklist' ? vChecklist()
    : local.tab === 'templates' ? vTemplates()
    : local.tab === 'crew' ? vCrew()
    : vSettings();
  justStamped = null;
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === local.tab));
  animateRoad();
}

/* FLIP the road van so it drives (not jumps) to its new position. */
function animateRoad() {
  const v = $('.road-van');
  if (!v) { prevRoadP = null; return; }
  const p = progress();
  const set = (x) => {
    v.style.left = x * 100 + '%';
    v.style.transform = `translateX(${-x * 100}%)`;
  };
  if (prevRoadP !== null && prevRoadP !== p) {
    const from = prevRoadP;
    v.style.transition = 'none';
    set(from);
    v.getBoundingClientRect();
    requestAnimationFrame(() => { v.style.transition = ''; set(p); });
  } else {
    set(p);
  }
  prevRoadP = p;
}

/* ============================================================
   ACTIONS
   ============================================================ */
const actions = {
  toggle(d) {
    if (!canEdit()) return;
    const id = d.id;
    if (S.checked[id]) {
      delete S.checked[id];
    } else {
      S.checked[id] = { by: me().name, at: Date.now() };
      justStamped = id;
      if (local.sound) sndClick();
    }
    const before = lastP;
    commit();
    lastP = progress();
    if (lastP === 1 && before < 1 && !S.trip.startedAt) setTimeout(() => runDeparture(false), 700);
  },
  useTpl(d) {
    if (Object.keys(S.checked).length && !confirm('Switch template? Current check-offs reset.')) return;
    S.trip.templateId = d.tpl;
    S.checked = {};
    S.trip.startedAt = null;
    lastP = 0; prevRoadP = null;
    commit();
    setTab('checklist');
  },
  gotoTemplates() { setTab('templates'); },
  toggleEdit(d) { editingTpl = editingTpl === d.tpl ? null : d.tpl; render(); },
  newTpl() {
    const t = { id: uid(), name: 'New Template', type: 'beach', zones: [zone('Zone 1', [])] };
    S.templates.push(t);
    if (!S.trip.templateId) S.trip.templateId = t.id;
    editingTpl = t.id;
    commitTemplates();
  },
  dupTpl(d) {
    const src = S.templates.find((t) => t.id === d.tpl);
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid();
    copy.name = src.name + ' Copy';
    copy.zones.forEach((z) => z.items.forEach((i) => { i.id = uid(); }));
    S.templates.push(copy);
    commitTemplates();
  },
  rmTpl(d) {
    if (d.tpl === S.trip.templateId) return;
    if (!confirm('Delete this template?')) return;
    S.templates = S.templates.filter((t) => t.id !== d.tpl);
    editingTpl = null;
    commitTemplates();
  },
  addZone(d) {
    const t = S.templates.find((x) => x.id === d.tpl);
    t.zones.push(zone('New zone', []));
    commitTemplates();
  },
  rmZone(d) {
    const t = S.templates.find((x) => x.id === d.tpl);
    if (!confirm('Remove this zone and its items?')) return;
    t.zones.splice(+d.z, 1);
    commitTemplates();
  },
  addItem(d) {
    const t = S.templates.find((x) => x.id === d.tpl);
    t.zones[+d.z].items.push({ id: uid(), label: 'New item' });
    commitTemplates();
  },
  rmItem(d) {
    const t = S.templates.find((x) => x.id === d.tpl);
    const item = t.zones[+d.z].items.splice(+d.i, 1)[0];
    if (item) delete S.checked[item.id];
    commitTemplates();
  },
  setMe(d) { local.meId = d.id; saveLocal(); render(); },
  addCrew() {
    const name = $('#newCrewName').value.trim();
    if (!name) return;
    S.crew.push({ id: uid(), name, role: $('#newCrewRole').value });
    commit();
  },
  rmCrew(d) {
    S.crew = S.crew.filter((c) => c.id !== d.id);
    if (local.meId === d.id) { local.meId = S.crew[0].id; saveLocal(); }
    commit();
  },
  copyInvite(d, el) {
    const link = location.origin === 'null'
      ? location.href.split('?')[0] + '?room=' + room
      : location.origin + location.pathname + '?room=' + room;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
      .then(() => {
        const old = el.textContent;
        el.textContent = 'COPIED ✓';
        setTimeout(() => { el.textContent = old; }, 1400);
      })
      .catch(() => prompt('Copy the invite link:', link));
  },
  preview() { runDeparture(true); },
  resetTrip() {
    if (!confirm('Uncheck everything and reset departure?')) return;
    S.checked = {};
    S.trip.startedAt = null;
    lastP = 0; prevRoadP = null;
    commit();
  },
  newTrip() {
    S.checked = {};
    S.trip.startedAt = null;
    lastP = 0; prevRoadP = null;
    commit();
  },
  closeDeparture(d) {
    if (d.preview !== '1' && !S.trip.startedAt) {
      S.trip.startedAt = Date.now();
      commit();
    }
    const D = $('#departure');
    D.className = 'departure';
    D.hidden = true;
    document.body.classList.remove('scene-open');
  },
  startTrip() { enterApp(newRoomCode()); },
  joinTrip() {
    const inp = $('#joinCode');
    const code = (inp.value || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!code) {
      inp.classList.remove('shake');
      void inp.offsetWidth;
      inp.classList.add('shake');
      inp.focus();
      return;
    }
    enterApp(code);
  },
  resumeTrip(d) { enterApp(d.code); },
  toggleAmbient(d, el) {
    if (ambient) {
      stopAmbient();
      el.textContent = 'Sound on';
    } else {
      startAmbient();
      el.textContent = ambient ? 'Sound off' : 'Sound on';
    }
  },
  archiveTrip() {
    if (!confirm('Archive this trip? It moves to the logbook and the checklist resets.')) return;
    recordTrip({ completedAt: Date.now() });
    S.checked = {};
    S.trip.startedAt = null;
    S.ts = Date.now();
    localStorage.setItem(KEY, JSON.stringify(S));
    if (sync) sync.send(S);
    exitToLanding();
  },
};

const fields = {
  tripName(v) { S.trip.name = v.trim() || 'Untitled Trip'; commit(); },
  departAt(v) { S.trip.departAt = v; commit(); },
  vanName(v) { S.van = v.trim() || 'The Crafter'; commit(); },
  themeT(v, el) { local.theme = el.checked ? 'night' : 'day'; saveLocal(); render(); },
  soundT(v, el) { local.sound = el.checked; saveLocal(); },
  tplName(v, el) {
    const t = S.templates.find((x) => x.id === el.dataset.tpl);
    t.name = v.trim() || 'Untitled';
    commitTemplates();
  },
  tplType(v, el) {
    const t = S.templates.find((x) => x.id === el.dataset.tpl);
    t.type = v;
    commitTemplates();
  },
  zoneName(v, el) {
    const t = S.templates.find((x) => x.id === el.dataset.tpl);
    t.zones[+el.dataset.z].name = v.trim() || 'Zone';
    commitTemplates();
  },
  itemLabel(v, el) {
    const t = S.templates.find((x) => x.id === el.dataset.tpl);
    t.zones[+el.dataset.z].items[+el.dataset.i].label = v.trim() || 'Item';
    commitTemplates();
  },
  crewRole(v, el) {
    const c = S.crew.find((x) => x.id === el.dataset.id);
    if (c && c.role !== 'owner') c.role = v;
    commit();
  },
};

/* ============================================================
   DEPARTURE SEQUENCE
   ============================================================ */
async function runDeparture(preview) {
  const D = $('#departure');
  const type = tpl()?.type || 'beach';
  const seq = D.dataset.seq = uid(); // cancels stale async runs if reopened

  $('#sceneMount').innerHTML = sceneSVG(type) + `<div class="dep-van${reducedMotion ? ' stay' : ''}">${vanSVG(type)}</div>`;
  const n = allItems().length;
  $('#depCard').innerHTML = `
    <div class="dep-stamp">ABGEFAHREN</div>
    <p class="dep-kicker">Pre-departure complete · ${n}/${n}</p>
    <h2 class="dep-trip">${esc(S.trip.name)}</h2>
    <p class="dep-time">Departed ${fmtDateTime(Date.now())} · ${esc(S.van)}</p>
    <p class="dep-bless">Gute Fahrt!</p>
    <button class="btn amber" data-action="closeDeparture" data-preview="${preview ? '1' : '0'}">Back to the checklist</button>`;

  D.hidden = false;
  D.className = 'departure';
  document.body.classList.add('scene-open');
  await wait(40);
  if (D.dataset.seq !== seq) return;
  D.classList.add('open');

  if (reducedMotion) {
    // Static illustration, gentle fade, straight to the stamp.
    D.classList.add('arrived');
    return;
  }

  if (local.sound) sndEngine();
  await wait(700);
  if (D.dataset.seq !== seq) return;
  D.classList.add('ignition');
  await wait(1900);
  if (D.dataset.seq !== seq) return;
  D.classList.remove('ignition');
  D.classList.add('rolling');
  await wait(3650);
  if (D.dataset.seq !== seq) return;
  D.classList.remove('rolling');
  D.classList.add('arrived');
}

/* ============================================================
   LANDING
   ============================================================ */
const LAND = $('#landing');
let landIO = null;
let landScrollFn = null;

/* One logbook postcard — completed trips are stamped memories, open ones glow. */
function landTripCard(t, i) {
  const done = !!t.completedAt;
  const when = fmtDateTime(t.completedAt || t.startedAt || Date.now());
  const rot = ((hash(t.code) % 5) - 2) * 0.6;
  return `<button class="land-trip reveal ${done ? 'done' : ''}" data-action="resumeTrip"
    data-code="${esc(t.code)}" style="--rot:${rot}deg; --d:${i * 70}ms">
    <div class="lt-thumb">${sceneSVG(t.template || 'beach')}</div>
    <div class="lt-body">
      <span class="lt-name">${esc(t.name || 'Untitled Trip')}</span>
      <span class="lt-meta">${esc(t.code)} · ${esc(when)}</span>
      <div class="lt-bar"><i style="width:${t.progress || 0}%"></i></div>
      ${done ? '<span class="lt-stamp">ABGEFAHREN</span>' : `<span class="lt-pct">${t.progress || 0}%</span>`}
    </div>
  </button>`;
}

function renderLanding() {
  const trips = loadTrips().sort((a, b) => (b.completedAt || b.startedAt || 0) - (a.completedAt || a.startedAt || 0));
  const heroType = (trips[0] && trips[0].template) || 'beach';
  LAND.innerHTML = `<div class="land-wrap">
    <div class="land-hero">
      <div class="land-stage">
        <div class="land-scene">${sceneSVG(heroType)}</div>
        <div class="land-van" id="landVan">${vanSVG(heroType)}</div>
        <div class="land-grain"></div>
        <div class="land-head">
          <p class="kicker">One van · one crew · one list</p>
          <h1 class="land-brand">ABFAHRT<span>.</span></h1>
          <p class="land-tag">The walkaround before every departure — shared live with everyone aboard The Crafter, until every latch is checked.</p>
        </div>
        <button class="land-sound" data-action="toggleAmbient">Sound on</button>
        <div class="land-scrollhint">Roll on<span class="land-arrow">↓</span></div>
      </div>
    </div>
    <section class="land-cta">
      <p class="kicker reveal">Ready up</p>
      <h2 class="land-h2 reveal" style="--d:60ms">Wohin geht's?</h2>
      <div class="land-cards">
        <div class="card land-card reveal" style="--d:120ms">
          <h3>New trip</h3>
          <p>Fresh checklist, fresh code — share it with whoever rides along.</p>
          <button class="btn amber" data-action="startTrip">Start a trip</button>
        </div>
        <div class="card land-card reveal" style="--d:200ms">
          <h3>Join with a code</h3>
          <p>Someone already started the list? Hop on with the trip code.</p>
          <div class="land-join">
            <input id="joinCode" type="text" placeholder="CRAFT-XXXX" maxlength="14"
              autocapitalize="characters" autocomplete="off" spellcheck="false">
            <button class="btn" data-action="joinTrip">Join</button>
          </div>
        </div>
      </div>
    </section>
    <section class="land-trips">
      <p class="kicker reveal">Logbook</p>
      <h2 class="land-h2 reveal" style="--d:60ms">Your trips</h2>
      ${trips.length
        ? `<div class="land-tripgrid">${trips.map(landTripCard).join('')}</div>`
        : '<p class="empty-note reveal" style="--d:120ms">No trips yet — the logbook fills itself once you roll out.</p>'}
    </section>
    <footer class="land-foot reveal">
      <span class="land-foot-brand">ABFAHRT<span>.</span></span>
      <span>Built for The Crafter · checked is checked</span>
    </footer>
  </div>`;
  initLandingFx();
}

/* Scroll mechanics: the van idles, creeps forward as you scroll, parks at the CTA.
   Eased translateX + distance-true wheel rotation; far/mid layers drift slower. */
function initLandingFx() {
  if (landIO) landIO.disconnect();
  landIO = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('in'); landIO.unobserve(en.target); }
    });
  }, { threshold: 0.12 });
  LAND.querySelectorAll('.reveal').forEach((el) => landIO.observe(el));

  if (landScrollFn) { removeEventListener('scroll', landScrollFn); landScrollFn = null; }
  if (reducedMotion) { LAND.classList.add('static'); return; }

  const van = $('#landVan');
  const far = LAND.querySelector('.land-scene .l-far');
  const mid = LAND.querySelector('.land-scene .l-mid');
  const hero = LAND.querySelector('.land-hero');
  let raf = null;
  landScrollFn = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      if (!van.isConnected) return;
      const range = Math.max(1, hero.offsetHeight - innerHeight);
      const p = Math.min(1, Math.max(0, scrollY / range));
      const eased = 1 - Math.pow(1 - p, 3);
      const dx = eased * Math.min(innerWidth * 0.52, 620);
      van.style.transform = `translateX(${dx}px)`;
      van.classList.toggle('moving', p > 0.02 && p < 0.96);
      van.querySelectorAll('.wheelspin').forEach((w) => { w.style.transform = `rotate(${dx * 3.2}deg)`; });
      if (far) far.style.transform = `translateX(${-eased * 55}px)`;
      if (mid) mid.style.transform = `translateX(${-eased * 150}px)`;
    });
  };
  addEventListener('scroll', landScrollFn, { passive: true });
  landScrollFn();
}

function showLanding() {
  document.body.classList.add('landing');
  LAND.hidden = false;
  LAND.classList.remove('leave');
  renderLanding();
  scrollTo(0, 0);
}

/* Animated swap into the app: freeze the landing where it is, lift it out. */
function enterApp(code) {
  stopAmbient();
  const wrap = LAND.querySelector('.land-wrap');
  if (wrap) wrap.style.transform = `translateY(${-scrollY}px)`;
  LAND.classList.add('leave');
  if (landScrollFn) { removeEventListener('scroll', landScrollFn); landScrollFn = null; }
  bootRoom(code);
  document.body.classList.remove('landing');
  scrollTo(0, 0);
  setTimeout(() => { LAND.hidden = true; LAND.innerHTML = ''; }, 750);
}

function exitToLanding() {
  if (location.protocol !== 'file:') history.replaceState(null, '', location.pathname);
  local.room = null;
  saveLocal();
  showLanding();
}

/* ============================================================
   WIRING
   ============================================================ */
function setTab(tab) { local.tab = tab; saveLocal(); render(); }

document.body.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
  const b = e.target.closest('[data-action]');
  if (b && actions[b.dataset.action]) actions[b.dataset.action](b.dataset, b, e);
});
document.body.addEventListener('change', (e) => {
  const f = e.target.closest('[data-field]');
  if (f && fields[f.dataset.field]) fields[f.dataset.field](f.value, f);
});
document.body.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'joinCode') actions.joinTrip();
});

// Invite links drop straight into the trip; everyone else gets the landing.
if (urlRoom) {
  bootRoom(urlRoom);
} else {
  showLanding();
}
