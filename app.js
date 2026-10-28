// app.js - Narrator for the web (iPhone, iPad, Android, Mac, Windows).
import { loadBook, chapterIndex, chunkWeight } from './doc.js';

const VERSION = '1.2.3';
const SR = 24000;
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const VOICES = {
  'female-us': ['af_heart', 'Heart (American)'], 'male-us': ['am_michael', 'Michael (American)'],
  'female-uk': ['bf_emma', 'Emma (British)'], 'male-uk': ['bm_george', 'George (British)'],
};
const KEEP_BEHIND = 8;
let engine = '';   // 'gpu' (fast), 'cpu' (compact) or 'system' (the device's built-in voices), set when voices load
const lookahead = () => engine === 'gpu' ? 6 : 14;  // read further ahead when synthesis is slow
const MOCK = new URLSearchParams(location.search).has('mock');   // testing without the voice model
// iPhone / iPad (iPadOS reports itself as a Mac, but has a touch screen)
const APPLE_MOBILE = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const HAS_SPEECH = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
const $ = id => document.getElementById(id);

// ------------------------------------------------------------------ storage
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };
const S = Object.assign({ gender: 'female', accent: 'us', speed: 1, font: 18, theme: 'auto',
  keepAwake: true, follow: true, volume: 100, engine: 'auto', sysVoiceURI: '' }, load('narrator.settings', {}));
const saveSettings = () => save('narrator.settings', S);
let positions = load('narrator.positions', {});
let bookmarks = load('narrator.bookmarks', {});
let recent = load('narrator.recent', []);          // [{key,name,title,size,opened}]

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('narrator', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('books', { keyPath: 'key' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('books', mode); const st = tx.objectStore('books');
    const req = fn(st); tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error);
  });
}
const bookPut = rec => idbDo('readwrite', st => st.put(rec)).catch(() => {});
const bookGet = key => idbDo('readonly', st => st.get(key)).catch(() => null);
const bookDel = key => idbDo('readwrite', st => st.delete(key)).catch(() => {});

// ------------------------------------------------------------------ helpers
const fmt = s => {
  s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const voiceId = () => VOICES[`${S.gender}-${S.accent}`][0];
const voiceLabel = () => VOICES[`${S.gender}-${S.accent}`][1];
const speedLabel = s => `${s}×`;
let flashMsg = '', flashUntil = 0;
const flash = (msg, ms = 3500) => { flashMsg = msg; flashUntil = Date.now() + ms; updateStatus(); };

// pitch-preserving slow-down, used only for 0.25x
function wsola(x, stretch, frame = 1024, hop = 256, tol = 256) {
  if (stretch <= 1 || x.length < frame * 3) return x;
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frame - 1));
  const outLen = Math.floor(x.length * stretch) + frame;
  const y = new Float32Array(outLen), w = new Float32Array(outLen);
  const hopIn = hop / stretch;
  let prev = -1;
  for (let k = 0; ; k++) {
    const nominal = Math.round(k * hopIn);
    if (nominal + frame + tol >= x.length) break;
    let start = nominal;
    if (prev >= 0 && prev + hop + frame <= x.length) {
      const lo = Math.max(0, nominal - tol), hi = Math.min(x.length - frame, nominal + tol);
      let best = -Infinity;
      for (let s = lo; s <= hi; s += 4) {
        let c = 0;
        for (let j = 0; j < frame; j += 8) c += x[s + j] * x[prev + hop + j];
        if (c > best) { best = c; start = s; }
      }
    }
    const o = k * hop;
    if (o + frame > outLen) break;
    for (let j = 0; j < frame; j++) { y[o + j] += x[start + j] * win[j]; w[o + j] += win[j]; }
    prev = start;
  }
  const n = Math.floor(x.length * stretch);
  for (let i = 0; i < n; i++) y[i] = w[i] > 1e-3 ? y[i] / w[i] : y[i];
  return y.subarray(0, n);
}

// ------------------------------------------------------------------ voice worker
let worker, ttsReady = false, ttsError = null, dl = { loaded: 0, total: 0 }, threads = false, dlCached = false, loadingEngine = '';

// Which engine to start. On iPhone/iPad the AI voice engines are too heavy for the browser
// (the fast one runs out of memory, the compact one is slower than speech), so Automatic
// uses the device's own voices there.
function resolveEngine() {
  const v = S.engine;
  if (v === 'system') return HAS_SPEECH ? 'system' : 'cpu';
  if (v === 'gpu') return 'gpu';
  if (v === 'cpu') return 'cpu';
  if (APPLE_MOBILE) return HAS_SPEECH ? 'system' : 'cpu';
  if (localStorage.getItem('narrator.gpuFailed') === '1') return 'cpu';
  return 'auto';                       // the worker picks gpu when available, otherwise cpu
}

// Crash guard: if the page died while a voice engine was loading or playing, don't try it again.
let crashNote = '';
(function checkLastRun() {
  const loading = localStorage.getItem('narrator.loading');
  const active = localStorage.getItem('narrator.active');
  localStorage.removeItem('narrator.loading'); localStorage.removeItem('narrator.active');
  const died = loading || active;
  if (!died || died === 'system') return;
  if (died === 'gpu') {
    localStorage.setItem('narrator.gpuFailed', '1');
    if (S.engine === 'gpu') { S.engine = 'auto'; saveSettings(); }
  } else if (died === 'cpu' && APPLE_MOBILE && HAS_SPEECH && S.engine === 'cpu') { S.engine = 'system'; saveSettings(); }
  else return;
  crashNote = died === 'gpu'
    ? 'The fast voice engine ran out of memory last time, so a lighter engine is used now.'
    : 'The compact voice engine ran out of memory last time, so the built-in voices are used now.';
})();

function startWorker() {
  const r = resolveEngine();
  if (r === 'system' && !MOCK) { startSystem(); return; }
  if (MOCK) {
    worker = {
      postMessage(m) {
        setTimeout(() => {
          if (m.type === 'load') {
            onWorker({ data: { type: 'progress', loaded: 46e6, total: 92e6 } });
            setTimeout(() => onWorker({ data: { type: 'ready', threads: false } }), 300);
          } else if (m.type === 'synth') {
            const dur = Math.max(0.3, m.text.length / 15 / m.speed);
            const a = new Float32Array(Math.floor(dur * SR));
            for (let i = 0; i < a.length; i++) a[i] = 0.05 * Math.sin(i / SR * 2 * Math.PI * 220);
            onWorker({ data: { type: 'audio', id: m.id, data: a } });
          }
        }, m.type === 'synth' ? 120 : 50);
      },
    };
  } else {
    worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorker;
    worker.onerror = e => { ttsError = e.message || 'The voice engine could not start.'; updateStatus(); };
  }
  worker.postMessage({ type: 'load', engine: r });
}
function onWorker(e) {
  const m = e.data;
  if (m.type === 'progress') { dl = m; updateStatus(); }
  else if (m.type === 'engine') { loadingEngine = m.engine; markActive(); }
  else if (m.type === 'cached') { dlCached = m.cached; updateStatus(); }
  else if (m.type === 'ready') {
    loadingEngine = ''; try { localStorage.removeItem('narrator.loading'); } catch { /* ignore */ }
    ttsReady = true; threads = m.threads; engine = m.engine || 'cpu'; updateStatus(); pump();
    $('voiceNote').hidden = true;
  } else if (m.type === 'error') {
    loadingEngine = ''; try { localStorage.removeItem('narrator.loading'); } catch { /* ignore */ }
    const network = /fetch|network|load failed|offline|internet/i.test(m.message || '');
    if (!network && self.crossOriginIsolated && localStorage.getItem('narrator.noThreads') !== '1') {
      // fall back to single-threaded mode once, which works everywhere
      localStorage.setItem('narrator.noThreads', '1');
      registerSW(true).then(() => location.reload());
      return;
    }
    ttsError = network ? 'no internet connection - tap here to try again' : m.message; updateStatus();
  } else if (m.type === 'audio') onAudio(m);
}

// ------------------------------------------------------------------ built-in (device) voices
// Uses the speech voices that come with the device (on iPhone/iPad: Settings > Accessibility >
// Spoken Content > Voices). Nothing to download and no heavy processing, so it never pauses.
const FEMALE_RE = /samantha|ava|allison|susan|zoe|nicky|joelle|noelle|kate|serena|stephanie|martha|karen|moira|tessa|fiona|victoria|veena|catherine|kathy|vicki|shelley|sandy|flo|grandma|zira|aria|jenny|libby|sonia|hazel|emma|olivia|female|woman/i;
const MALE_RE = /alex|\btom\b|aaron|evan|nathan|fred|daniel|arthur|oliver|rishi|gordon|\blee\b|reed|eddy|rocko|ralph|grandpa|david|\bmark\b|\bguy\b|ryan|thomas|george|james|christopher|eric|roger|brian|male|\bman\b/i;
const NOVELTY_RE = /bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|junior|ralph|princess|deranged|hysterical/i;
// older, robotic-sounding voices: used only when nothing better is available
const ELOQUENCE_RE = /\b(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|fred|kathy)\b/i;
// the most natural Apple voices: chosen first whenever Safari makes them available
const PREFERRED_RE = { female: /\b(zoe|ava)\b/i, male: /\b(evan|nathan)\b/i };
let sysVoice = null;
const SV = { gen: 0, queued: -1, frac: 0, startChar: 0, tStart: 0, lastEvent: 0 };

function sysVoices() { try { return speechSynthesis.getVoices().filter(v => /^en([-_]|$)/i.test(v.lang)); } catch { return []; } }
function sysQuality(v) {
  const id = `${v.voiceURI} ${v.name}`;
  if (NOVELTY_RE.test(v.name)) return -2;
  if (ELOQUENCE_RE.test(v.name)) return 0;
  if (/premium|natural|neural/i.test(id)) return 3;
  if (/enhanced|google/i.test(id)) return 2;
  return 1;
}
function sysGender(v) { return FEMALE_RE.test(v.name) ? 'female' : MALE_RE.test(v.name) ? 'male' : ''; }
function sysPick() {
  const list = sysVoices();
  if (S.sysVoiceURI) {                                   // a voice chosen in the menu
    const v = list.find(x => x.voiceURI === S.sysVoiceURI);
    if (v) { sysVoice = v; return v; }
  }
  const accent = S.accent === 'uk' ? /GB/i : /US/i;
  let best = null, bestScore = -1e9;
  for (const v of list) {
    const g = sysGender(v);
    // the chosen gender comes first, then voice quality, then accent
    const score = (g === S.gender ? 40 : g ? 0 : 15) + (PREFERRED_RE[S.gender].test(v.name) ? 25 : 0) + sysQuality(v) * 10 + (accent.test(v.lang) ? 3 : 0) + (v.localService ? 0.5 : 0);
    if (score > bestScore) { bestScore = score; best = v; }
  }
  sysVoice = best;
  return best;
}
const sysName = () => sysVoice ? sysVoice.name.replace(/\s*\((English|United States|United Kingdom)[^)]*\)/i, '').trim() : 'device voice';

async function startSystem() {
  engine = 'system'; dl = { loaded: 0, total: 0 };
  let list = sysVoices();
  for (let i = 0; !list.length && i < 30; i++) {           // voices arrive a moment after start-up
    await new Promise(r => setTimeout(r, 100)); list = sysVoices();
  }
  if (!list.length) {                                       // no voices: use the compact AI engine instead
    if (S.engine === 'system') { ttsError = 'this device has no built-in English voices'; updateStatus(); return; }
    S.engine = 'cpu'; saveSettings(); syncControls(); startWorker(); return;
  }
  sysPick();
  try { speechSynthesis.onvoiceschanged = () => { if (engine === 'system') sysPick(); }; } catch { /* ignore */ }
  ttsReady = true; threads = false; ttsError = null;
  $('voiceNote').hidden = true;
  updateStatus();
}
function sysStop() {
  SV.gen++; SV.queued = -1;
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
}
function sysSpeakFrom(i, frac) {
  sysStop();
  SV.frac = frac; SV.lastEvent = Date.now();
  sysEnqueue(i, frac);
}
function sysEnqueue(i, frac = 0) {
  const b = E.book, n = b.chunks.length;
  while (i < n && !/[A-Za-z0-9]/.test(b.chunks[i].text)) i++;   // nothing to say: skip
  if (i >= n) return;
  const g = SV.gen, full = b.chunks[i].text;
  let start = 0;
  if (frac > 0) {
    start = Math.floor(frac * full.length);
    const sp = full.lastIndexOf(' ', start);
    start = sp > 0 ? sp + 1 : 0;
  }
  const u = new SpeechSynthesisUtterance(full.slice(start));
  if (sysVoice) { u.voice = sysVoice; u.lang = sysVoice.lang; } else u.lang = S.accent === 'uk' ? 'en-GB' : 'en-US';
  u.rate = S.speed; u.volume = S.volume / 100;
  u.onstart = () => {
    if (g !== SV.gen) return;
    SV.lastEvent = Date.now(); SV.tStart = Date.now(); SV.startChar = start;
    if (E.cur !== i) { E.cur = i; refreshHighlight(); }
    SV.frac = start / full.length;
    if (SV.queued <= i && i + 1 < n) sysEnqueue(i + 1);         // keep the next sentence queued: no gap
  };
  u.onboundary = ev => {
    if (g !== SV.gen || E.cur !== i) return;
    SV.lastEvent = Date.now();
    SV.frac = clamp((start + (ev.charIndex || 0)) / full.length, 0, 0.999);
  };
  const done = ev => {
    if (g !== SV.gen) return;
    if (ev && ev.type === 'error' && /interrupted|canceled/.test(ev.error)) return;
    SV.lastEvent = Date.now();
    if (start === 0 && full.length > 40 && SV.tStart) {        // learn how fast this voice speaks (for the timeline)
      const secs = (Date.now() - SV.tStart) / 1000;
      const observed = chunkWeight(b.chunks[i]) / (secs * S.speed);
      if (isFinite(observed) && observed > 3 && observed < 40) E.cps = 0.9 * E.cps + 0.1 * observed;
    }
    if (E.cur === i) SV.frac = 0.999;
    if (SV.queued <= i) {                                        // nothing else queued
      if (i + 1 >= n) { E.playing = false; E.finished = true; onPlayState(); flash('Finished.'); }
      else sysEnqueue(i + 1);
    }
  };
  u.onend = done; u.onerror = done;
  SV.queued = i;
  speechSynthesis.speak(u);
}
// iOS sometimes stops speaking after an interruption (a call, Siri, another app's audio): restart.
function sysWatchdog() {
  if (engine !== 'system' || !E.playing || !E.book) return;
  let busy = false;
  try { busy = speechSynthesis.speaking || speechSynthesis.pending; } catch { /* ignore */ }
  if (!busy && Date.now() - SV.lastEvent > 2500) {
    if (SV.frac < 0.99) sysSpeakFrom(E.cur, SV.frac);
    else if (E.cur + 1 < E.book.chunks.length) { E.cur++; SV.frac = 0; refreshHighlight(); sysSpeakFrom(E.cur, 0); }
    else { E.playing = false; E.finished = true; onPlayState(); }
  }
  else if (busy && speechSynthesis.paused) { try { speechSynthesis.resume(); } catch { /* ignore */ } }
}

// ------------------------------------------------------------------ engine
const E = {
  book: null, key: '', cur: 0, offset: 0, pendingFrac: 0, playing: false, finished: false,
  cache: new Map(), inflight: null, cps: 14.5, ctx: null, gain: null, src: null, startedAt: 0, dur: 0,
  buffering: false, gen: 0,
};
let reqId = 0;
const ckey = i => `${i}|${voiceId()}|${S.speed}`;

function pump() {
  if (!ttsReady || !E.book || E.inflight || engine === 'system') return;
  const n = E.book.chunks.length;
  for (let i = E.cur; i < Math.min(n, E.cur + lookahead()); i++) {
    const k = ckey(i);
    if (!E.cache.has(k)) { request(i, k); return; }
  }
  evict();
}
function request(i, k) {
  const ch = E.book.chunks[i], id = ++reqId;
  E.inflight = { id, i, k, gen: E.gen, speed: S.speed, ch, t0: performance.now() };
  if (!/[A-Za-z0-9]/.test(ch.text)) { setTimeout(() => onAudio({ id, data: new Float32Array(0) })); return; }
  worker.postMessage({ type: 'synth', id, text: ch.text, voice: voiceId(), speed: clamp(S.speed, 0.5, 2) });
}
function onAudio(m) {
  const f = E.inflight;
  if (!f || f.id !== m.id) return;
  E.inflight = null;
  if (f.gen === E.gen) {
    let a = m.data || new Float32Array(Math.round(SR * 0.3));
    if (m.error) console.warn('Voice error:', m.error);
    if (a.length > SR) {                                // how fast the engine works compared with speech
      const r = (performance.now() - f.t0) / 1000 / (a.length / SR);
      E.rtf = E.rtf ? 0.8 * E.rtf + 0.2 * r : r;
    }
    if (f.speed < 0.5 && a.length) a = wsola(a, 0.5 / f.speed);
    if (f.speed >= 0.5 && f.ch.text.length > 40 && a.length) {
      const observed = chunkWeight(f.ch) / (a.length / SR * f.speed);
      if (isFinite(observed) && observed > 3 && observed < 40) E.cps = 0.9 * E.cps + 0.1 * observed;
    }
    let pause = f.ch.heading ? 0.85 : f.ch.paraEnd ? 0.55 : 0.18;
    pause = Math.min(1.6, pause / Math.pow(Math.max(f.speed, 0.25), 0.7));
    const out = new Float32Array(a.length + Math.floor(SR * pause));
    out.set(a, 0);
    E.cache.set(f.k, out);
    if ((f.i === E.cur || f.i === E.cur + 1) && E.playing && !E.src) startSource();
  }
  pump();
}
function evict() {
  const lo = E.cur - KEEP_BEHIND, hi = E.cur + lookahead() + 3, v = voiceId(), s = String(S.speed);
  for (const k of [...E.cache.keys()]) {
    const [i, kv, ks] = k.split('|');
    if (+i < lo || +i > hi || kv !== v || ks !== s) E.cache.delete(k);
  }
}

function ensureAudio() {
  if (!E.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    E.ctx = new AC();
    E.gain = E.ctx.createGain();
    E.gain.gain.value = S.volume / 100;
    E.gain.connect(E.ctx.destination);
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older iOS */ }
    E.ctx.onstatechange = () => {
      if (E.playing && E.ctx.state !== 'running' && document.visibilityState === 'visible') E.ctx.resume().catch(() => {});
    };
  }
  if (E.ctx.state !== 'running') E.ctx.resume().catch(() => {});
}
function stopSource() {
  if (engine === 'system') { sysStop(); return; }
  if (E.src) { const s = E.src; E.src = null; s.onended = null; try { s.stop(); } catch { /* already stopped */ } }
}
function startSource() {
  if (engine === 'system') {
    if (!ttsReady) { E.buffering = true; updateStatus(); return; }
    E.buffering = false; E.preroll = false;
    const f = E.pendingFrac != null ? E.pendingFrac : SV.frac;
    E.pendingFrac = null;
    sysSpeakFrom(E.cur, f >= 0.99 ? 0 : f);
    return;
  }
  const a = E.cache.get(ckey(E.cur));
  const n = E.book.chunks.length;
  const needNext = E.preroll && engine !== 'gpu' && E.cur + 1 < n && !E.cache.has(ckey(E.cur + 1));
  if (!a || needNext) { E.buffering = true; pump(); updateStatus(); return; }
  E.buffering = false; E.preroll = false;
  E.dur = a.length / SR;
  if (E.pendingFrac != null) { E.offset = E.pendingFrac * E.dur; E.pendingFrac = null; }
  if (E.offset >= E.dur - 0.02) { advance(); return; }
  const buf = E.ctx.createBuffer(1, a.length, SR);
  buf.copyToChannel(a, 0);
  const src = E.ctx.createBufferSource();
  src.buffer = buf; src.connect(E.gain);
  src.onended = () => { if (E.src !== src) return; E.src = null; if (E.playing) advance(); };
  E.startedAt = E.ctx.currentTime - E.offset;
  src.start(0, E.offset);
  E.src = src;
  pump();
}
function advance() {
  if (E.cur + 1 >= E.book.chunks.length) {
    E.playing = false; E.finished = true; E.offset = E.dur; onPlayState(); flash('Finished.'); return;
  }
  E.cur++; E.offset = 0; E.pendingFrac = null;
  startSource();
  refreshHighlight();
}
const curOffset = () => (E.src && E.playing) ? Math.max(0, E.ctx.currentTime - E.startedAt) : E.offset;
function curFrac() {
  if (E.pendingFrac != null) return E.pendingFrac;
  if (engine === 'system') return SV.frac;
  const a = E.cache.get(ckey(E.cur));
  return a && a.length ? clamp(curOffset() / (a.length / SR), 0, 1) : 0;
}

// iPhone/iPad mute the built-in speech voices when the phone is in Silent mode. Declaring the
// page a "playback" app and keeping a silent sound playing makes iOS treat the narration like
// music or a podcast: audible in Silent mode, and controllable from the lock screen.
let keepAlive = null;
function silentWavUrl() {
  const sr = 8000, n = sr;                         // 1 second of 8-bit silence
  const b = new Uint8Array(44 + n), v = new DataView(b.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true);
  b.fill(128, 44);                                 // 128 = silence for 8-bit audio
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
function playbackSession(on) {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older iOS */ }
  if (!APPLE_MOBILE || engine !== 'system') return;
  try {
    if (on) {
      if (!keepAlive) {
        keepAlive = document.createElement('audio');
        keepAlive.src = silentWavUrl(); keepAlive.loop = true;
        keepAlive.setAttribute('playsinline', ''); keepAlive.setAttribute('webkit-playsinline', '');
        document.body.appendChild(keepAlive);
      }
      keepAlive.play().catch(() => {});
    } else if (keepAlive) keepAlive.pause();
  } catch { /* ignore */ }
}

function play() {
  if (!E.book) { openPicker(); return; }
  if (engine !== 'system') ensureAudio();
  else {
    playbackSession(true);                         // must happen inside the tap, before speaking
    if (APPLE_MOBILE && !sessionStorage.getItem('narrator.silentHint')) {
      sessionStorage.setItem('narrator.silentHint', '1');
      setTimeout(() => flash('No sound? Turn off Silent mode — iPhone/iPad mute built-in voices in Silent mode.', 8000), 600);
    }
  }
  if (E.finished) { E.cur = 0; E.offset = 0; E.pendingFrac = 0; E.finished = false; SV.frac = 0; }
  E.playing = true; E.preroll = true;
  startSource();
  onPlayState();
}
function pause() {
  if (engine === 'system') E.pendingFrac = curFrac();
  else { E.offset = curOffset(); E.pendingFrac = null; }
  stopSource(); E.playing = false; E.buffering = false;
  onPlayState(); savePosition(true);
}
const togglePlay = () => (E.playing ? pause() : play());
function seek(i, frac = 0) {
  if (!E.book) return;
  stopSource();
  E.cur = clamp(i, 0, E.book.chunks.length - 1); E.offset = 0; E.pendingFrac = clamp(frac, 0, 0.999); E.finished = false;
  E.preroll = true;
  if (E.playing) startSource(); else pump();
  refreshHighlight(true); updateTimes();
}
function reVoice() {          // voice or speed changed: keep the place
  if (engine === 'system') sysPick();
  const frac = curFrac();
  stopSource(); E.offset = 0; E.pendingFrac = frac;
  if (E.playing) startSource(); else pump();
  updateTimes(); updateStatus();
}

// timeline (estimated listening seconds at the current speed)
const rate = () => E.cps * S.speed;
const timeOf = (cur, frac) => (E.book.prefix[cur] + frac * E.book.weights[cur]) / rate();
const totalTime = () => E.book ? E.book.prefix[E.book.chunks.length] / rate() : 0;
const nowTime = () => E.book ? timeOf(E.cur, curFrac()) : 0;
function seekTime(t) {
  if (!E.book) return;
  const b = E.book;
  t = clamp(t, 0, totalTime() - 0.05);
  const w = t * rate();
  let lo = 0, hi = b.chunks.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (b.prefix[m] <= w) lo = m; else hi = m - 1; }
  seek(lo, (w - b.prefix[lo]) / b.weights[lo]);
}
const jump = s => E.book && seekTime(nowTime() + s);

// ------------------------------------------------------------------ book loading
const fileKey = f => `${f.name}|${f.size}`;
let openBusy = false;
function openPicker() { $('file').value = ''; $('file').click(); }
$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  if (!f) return;
  const data = await f.arrayBuffer();
  await openBook({ key: fileKey(f), name: f.name, size: f.size, data }, true);
});

async function openBook(rec, store) {
  if (openBusy) return;
  openBusy = true;
  if (E.book) { savePosition(true); if (E.playing) pause(); }
  flash(`Opening ${rec.name}…`, 60000);
  try {
    const book = await loadBook(rec.data.slice(0), rec.name, p => flash(`Reading ${rec.name}… ${Math.round(p * 100)}%`, 60000));
    E.book = book; E.key = rec.key; E.gen++; E.cache.clear(); E.inflight = null;
    const pos = positions[rec.key];
    E.cur = pos && pos.chunk < book.chunks.length ? pos.chunk : 0;
    if (pos && pos.n !== book.chunks.length && book.pageFirst.has(pos.page)) E.cur = book.pageFirst.get(pos.page);
    E.offset = 0; E.pendingFrac = 0; E.finished = false;
    recent = [{ key: rec.key, name: rec.name, title: book.title, size: rec.size, opened: Date.now() },
      ...recent.filter(r => r.key !== rec.key)].slice(0, 6);
    save('narrator.recent', recent);
    if (store) {
      await bookPut({ key: rec.key, name: rec.name, size: rec.size, data: rec.data });
      const keep = new Set(recent.map(r => r.key));
      const db = await idb();
      const keys = await new Promise(r => { const q = db.transaction('books').objectStore('books').getAllKeys(); q.onsuccess = () => r(q.result); q.onerror = () => r([]); });
      for (const k of keys) if (!keep.has(k)) bookDel(k);
    }
    setupBookUI();
    flash(E.cur ? `Resuming at ${book.pageLabel.toLowerCase()} ${book.chunks[E.cur].page + 1}` :
      `Opened · ${book.chunks.length.toLocaleString()} sentences · ${book.toc.length} chapters`);
    pump();
  } catch (err) {
    console.error(err);
    flashMsg = ''; alert(`Could not open ${rec.name}\n\n${err.message || err}`);
  } finally { openBusy = false; updateStatus(); }
}

// ------------------------------------------------------------------ reading pane
let viewLo = 0, viewHi = 0, shownCur = -1, followPauseUntil = 0, picked = -1;
function setupBookUI() {
  const b = E.book;
  document.title = `${b.title} - Narrator`;
  $('title').textContent = b.title;
  $('welcome').hidden = true; $('text').hidden = false;
  const sel = $('chapter');
  sel.innerHTML = '';
  const minL = Math.min(...b.toc.map(e => e.level), 1);
  b.toc.forEach((e, k) => {
    const o = document.createElement('option');
    o.value = k; o.textContent = ' '.repeat(Math.max(0, e.level - minL)) + e.title;
    sel.appendChild(o);
  });
  sel.disabled = !b.toc.length;
  if (!b.toc.length) sel.innerHTML = '<option>No chapters found</option>';
  $('seek').disabled = false;
  viewLo = viewHi = 0; shownCur = -1;
  refreshHighlight(true, true);
  renderBookmarks(); updateTimes(); updateMedia();
}
function renderWindow(center) {
  const b = E.book, n = b.chunks.length;
  viewLo = Math.max(0, center - 60); viewHi = Math.min(n, center + 180);
  const art = $('text');
  art.textContent = '';
  const frag = document.createDocumentFragment();
  if (viewLo > 0) { const g = document.createElement('p'); g.className = 'gap'; g.textContent = '…'; frag.appendChild(g); }
  let block = null, para = -1;
  for (let i = viewLo; i < viewHi; i++) {
    const c = b.chunks[i];
    if (c.para !== para || !block) {
      block = document.createElement(c.heading ? 'h3' : 'p');
      frag.appendChild(block); para = c.para;
    }
    const s = document.createElement('span');
    s.className = 's'; s.dataset.i = i; s.textContent = c.text;
    block.appendChild(s); block.appendChild(document.createTextNode(' '));
  }
  if (viewHi < n) { const g = document.createElement('p'); g.className = 'gap'; g.textContent = '…'; frag.appendChild(g); }
  art.appendChild(frag);
}
function refreshHighlight(force = false, scroll = false) {
  if (!E.book) return;
  const cur = E.cur, n = E.book.chunks.length;
  const inside = (viewLo === 0 || cur >= viewLo + 15) && (viewHi === n || cur < viewHi - 30) && cur >= viewLo && cur < viewHi;
  if (force || !inside) renderWindow(cur);
  const art = $('text');
  art.querySelector('.s.hl')?.classList.remove('hl');
  const el = art.querySelector(`.s[data-i="${cur}"]`);
  if (el) {
    el.classList.add('hl');
    if (scroll || (S.follow && Date.now() >= followPauseUntil)) el.scrollIntoView({ block: 'center', behavior: scroll ? 'auto' : 'smooth' });
  }
  if (shownCur !== cur) {
    shownCur = cur;
    const k = chapterIndex(E.book, cur);
    if (k >= 0 && $('chapter').value !== String(k)) $('chapter').value = String(k);
    const pg = E.book.chunks[cur].page + 1;
    $('where').textContent = `${E.book.pageLabel === 'Page' ? 'p.' : '§'}${pg}/${E.book.npages}`;
    updateMedia();
    if (sleep.chapter != null && k !== sleep.chapter && E.playing) {
      sleep.chapter = null; $('mSleep').value = '0'; pause(); flash('Sleep timer: paused at the end of the chapter');
    }
  }
  $('nowReading').hidden = !(Date.now() < followPauseUntil);
}
const userScrolled = () => { if (E.book) { followPauseUntil = Date.now() + 10000; $('nowReading').hidden = false; } };
['wheel', 'touchmove'].forEach(ev => $('reader').addEventListener(ev, userScrolled, { passive: true }));
$('nowReading').onclick = () => { followPauseUntil = 0; $('nowReading').hidden = true; refreshHighlight(false, true); };

$('text').addEventListener('click', e => {
  const s = e.target.closest('.s'); if (!s) return;
  $('text').querySelector('.s.picked')?.classList.remove('picked');
  picked = +s.dataset.i; s.classList.add('picked');
  $('readHere').hidden = false;
});
$('text').addEventListener('dblclick', e => {
  const s = e.target.closest('.s'); if (!s) return;
  window.getSelection()?.removeAllRanges();
  readFrom(+s.dataset.i);
});
function readFrom(i) {
  $('readHere').hidden = true; $('text').querySelector('.s.picked')?.classList.remove('picked');
  followPauseUntil = 0; seek(i, 0);
  if (!E.playing) play();
}
$('readHereGo').onclick = () => readFrom(picked);
$('readHereX').onclick = () => { $('readHere').hidden = true; $('text').querySelector('.s.picked')?.classList.remove('picked'); };

// ------------------------------------------------------------------ chapters, pages, bookmarks
$('chapter').addEventListener('change', () => gotoChapter(+$('chapter').value));
function gotoChapter(k) {
  if (!E.book || k < 0 || k >= E.book.toc.length) return;
  followPauseUntil = 0; seek(E.book.toc[k].chunk, 0);
}
function nextChapter() {
  if (!E.book) return;
  const t = E.book.tocStarts.find(([c]) => c > E.cur); if (t) gotoChapter(t[1]);
}
function prevChapter() {
  if (!E.book) return;
  const s = E.book.tocStarts; let j = -1;
  for (let k = 0; k < s.length; k++) if (s[k][0] <= E.cur) j = k;
  if (j >= 0 && E.cur - s[j][0] <= 2) j--;
  if (j >= 0) gotoChapter(s[j][1]); else seek(0);
}
function gotoPage() {
  if (!E.book) return;
  const label = E.book.pageLabel.toLowerCase();
  const v = prompt(`Go to ${label} (1–${E.book.npages}):`); if (!v) return;
  let q = clamp(parseInt(v, 10) - 1, 0, E.book.npages - 1);
  while (q < E.book.npages && !E.book.pageFirst.has(q)) q++;
  if (q < E.book.npages) { followPauseUntil = 0; seek(E.book.pageFirst.get(q)); closeSheets(); }
}
function addBookmark() {
  if (!E.book) return;
  const c = E.book.chunks[E.cur], k = chapterIndex(E.book, E.cur);
  const chap = k >= 0 ? E.book.toc[k].title.slice(0, 32) : '';
  const label = `${E.book.pageLabel === 'Page' ? 'p.' : '§'}${c.page + 1} ${chap ? chap + ' — ' : ''}${c.text.slice(0, 40)}${c.text.length > 40 ? '…' : ''}`;
  (bookmarks[E.key] ||= []).push({ chunk: E.cur, label });
  bookmarks[E.key].sort((a, b) => a.chunk - b.chunk);
  save('narrator.bookmarks', bookmarks); renderBookmarks(); flash('Bookmark added');
}
function renderBookmarks() {
  const box = $('mBookmarks'); box.textContent = '';
  for (const [idx, b] of (bookmarks[E.key] || []).entries()) {
    const row = document.createElement('button');
    row.innerHTML = '<span class="t"></span><span class="x" aria-label="Remove">✕</span>';
    row.querySelector('.t').textContent = '🔖 ' + b.label;
    row.onclick = ev => {
      if (ev.target.classList.contains('x')) {
        bookmarks[E.key].splice(idx, 1); save('narrator.bookmarks', bookmarks); renderBookmarks();
      } else { followPauseUntil = 0; seek(b.chunk); closeSheets(); }
    };
    box.appendChild(row);
  }
}
function renderRecent() {
  const mk = (box, inMenu) => {
    box.textContent = '';
    for (const r of recent) {
      const row = document.createElement('button');
      const pos = positions[r.key];
      row.innerHTML = '<span class="t"></span><span class="m"></span>' + (inMenu ? '<span class="x" aria-label="Remove">✕</span>' : '');
      row.querySelector('.t').textContent = (inMenu ? '' : '▶ Continue: ') + (r.title || r.name);
      row.querySelector('.m').textContent = pos && pos.pct != null ? `${pos.pct}%` : '';
      row.onclick = async ev => {
        if (ev.target.classList.contains('x')) {
          recent = recent.filter(x => x.key !== r.key); save('narrator.recent', recent); bookDel(r.key); renderRecent(); return;
        }
        const rec = await bookGet(r.key);
        closeSheets();
        if (rec) openBook(rec, false);
        else { alert('This book is no longer stored on this device. Please open the file again.'); openPicker(); }
      };
      box.appendChild(row);
    }
  };
  mk($('recentBox'), false);
  mk($('mRecent'), true);
  if (!recent.length) $('mRecent').innerHTML = '<p class="small" style="color:var(--muted)">None yet.</p>';
}

function savePosition(force = false) {
  if (!E.book) return;
  const pct = Math.round(100 * E.book.prefix[E.cur] / E.book.prefix[E.book.chunks.length]);
  const rec = { chunk: E.cur, page: E.book.chunks[E.cur].page, n: E.book.chunks.length, pct, t: Date.now() };
  const old = positions[E.key];
  if (force || !old || old.chunk !== rec.chunk) { positions[E.key] = rec; save('narrator.positions', positions); }
}

// ------------------------------------------------------------------ status, times, media session
function updateTimes() {
  if (!E.book) return;
  const now = nowTime(), tot = totalTime();
  $('elapsed').textContent = fmt(now);
  $('remain').textContent = '-' + fmt(tot - now);
  if (!seeking) $('seek').value = String(Math.round(1000 * now / Math.max(1, tot)));
}
function updateStatus() {
  let s;
  if (Date.now() < flashUntil) s = flashMsg;
  else if (ttsError) s = '⚠ Voices could not load: ' + ttsError;
  else if (!ttsReady) {
    const pct = dl.total ? Math.round(100 * dl.loaded / dl.total) : 0;
    s = !dl.total ? 'Preparing voices…'
      : dlCached ? `Loading voices stored on this device ${pct}%`
      : `Downloading voices ${pct}% (${Math.round(dl.loaded / 1e6)} of ${Math.round(dl.total / 1e6)} MB)`;
  } else if (E.buffering && E.playing) s = 'Preparing audio…';
  else if (!E.book) s = 'Ready — open a book';
  else s = `${E.playing ? 'Playing' : 'Paused'} · ${engine === 'system' ? sysName() : voiceLabel().split(' ')[0]}${sleep.until ? ' · sleep ' + fmt((sleep.until - Date.now()) / 1000) : sleep.chapter != null ? ' · sleep at chapter end' : ''}`;
  $('status').textContent = s;
}
function onPlayState() {
  $('icoPlay').hidden = E.playing; $('icoPause').hidden = !E.playing;
  $('bPlay').setAttribute('aria-label', E.playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = E.playing ? 'playing' : 'paused';
  markActive();
  if (!E.playing) playbackSession(false);
  wakeLock(); updateStatus();
}
function updateMedia() {
  if (!('mediaSession' in navigator) || !E.book) return;
  const k = chapterIndex(E.book, E.cur);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: k >= 0 ? E.book.toc[k].title : E.book.title, artist: E.book.title, album: 'Narrator',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch { /* unsupported */ }
}
if ('mediaSession' in navigator) {
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported */ } };
  h('play', play); h('pause', pause);
  h('seekbackward', () => jump(-10)); h('seekforward', () => jump(30));
  h('previoustrack', prevChapter); h('nexttrack', nextChapter);
}
let lock = null;
async function wakeLock() {
  try {
    if (E.playing && S.keepAwake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      if (!lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); }
    } else if (lock) { await lock.release(); lock = null; }
  } catch { lock = null; }
}
// "active" flag for the crash guard: set while playing on screen, cleared whenever the page
// is paused, hidden or closed normally. If it is still set at the next start, the page crashed.
function markActive() {
  const vis = document.visibilityState === 'visible';
  try {
    if (E.playing && engine && vis) localStorage.setItem('narrator.active', engine);
    else localStorage.removeItem('narrator.active');
    if (loadingEngine && !ttsReady && vis) localStorage.setItem('narrator.loading', loadingEngine);
    else localStorage.removeItem('narrator.loading');
  } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => {
  markActive();
  if (document.visibilityState === 'hidden') savePosition(true);
  else { wakeLock(); if (E.playing && E.ctx && E.ctx.state !== 'running') E.ctx.resume().catch(() => {}); }
});
window.addEventListener('pagehide', () => {
  savePosition(true);
  try { localStorage.removeItem('narrator.active'); localStorage.removeItem('narrator.loading'); } catch { /* ignore */ }
});

// ------------------------------------------------------------------ sleep timer
const sleep = { until: 0, chapter: null };
$('mSleep').addEventListener('change', () => {
  const v = +$('mSleep').value;
  sleep.until = 0; sleep.chapter = null;
  if (v > 0) { sleep.until = Date.now() + v * 60000; flash(`Will pause in ${v} minutes`); }
  else if (v < 0 && E.book) { sleep.chapter = chapterIndex(E.book, E.cur); flash('Will pause at the end of this chapter'); }
  else flash('Sleep timer off');
});

// ------------------------------------------------------------------ controls
let seeking = false;
$('seek').addEventListener('input', () => {
  seeking = true;
  $('elapsed').textContent = fmt(totalTime() * $('seek').value / 1000);
});
$('seek').addEventListener('change', () => { seeking = false; followPauseUntil = 0; seekTime(totalTime() * $('seek').value / 1000); });
$('bPlay').onclick = togglePlay;
$('status').onclick = () => { if (ttsError) location.reload(); };
$('bBack').onclick = () => jump(-10);
$('bFwd').onclick = () => jump(30);
$('bStart').onclick = () => { followPauseUntil = 0; seek(0); };
$('bEnd').onclick = () => { followPauseUntil = 0; E.book && seekTime(totalTime() - 15); };
$('btnOpen').onclick = openPicker;
$('btnOpenBig').onclick = openPicker;
$('bVoice').onclick = () => { setGender(S.gender === 'female' ? 'male' : 'female'); };

function setGender(g) { S.gender = g; S.sysVoiceURI = ''; saveSettings(); syncControls(); reVoice(); flash(`Voice: ${voiceLabel()}`); }
function setAccent(a) { S.accent = a; S.sysVoiceURI = ''; saveSettings(); syncControls(); reVoice(); flash(`Voice: ${voiceLabel()}`); }
function setSpeed(s) { S.speed = s; saveSettings(); syncControls(); reVoice(); flash(`Speed ${speedLabel(s)}`); }
function setTheme(t) {
  S.theme = t; saveSettings();
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  syncControls();
}
function setFont(px) { S.font = clamp(px, 13, 32); saveSettings(); document.documentElement.style.setProperty('--reading-size', S.font + 'px'); }

function buildSeg(box, values, label, onPick) {
  box.textContent = '';
  for (const v of values) {
    const b = document.createElement('button'); b.dataset.v = v; b.textContent = label(v);
    b.onclick = () => onPick(v); box.appendChild(b);
  }
}
buildSeg($('segSpeed'), SPEEDS, speedLabel, setSpeed);
buildSeg($('segSpeed2'), SPEEDS, speedLabel, v => { setSpeed(v); $('speedSheet').close(); });
for (const b of $('segGender').children) b.onclick = () => setGender(b.dataset.v);
for (const b of $('segAccent').children) b.onclick = () => setAccent(b.dataset.v);
for (const b of $('segTheme').children) b.onclick = () => setTheme(b.dataset.v);
function syncControls() {
  const mark = (box, v) => { for (const b of box.children) b.classList.toggle('on', b.dataset.v === String(v)); };
  mark($('segSpeed'), S.speed); mark($('segSpeed2'), S.speed);
  mark($('segGender'), S.gender); mark($('segAccent'), S.accent); mark($('segTheme'), S.theme);
  mark($('segEngine'), S.engine);
  $('bSpeed').textContent = speedLabel(S.speed);
  $('bVoice').textContent = S.gender === 'female' ? '♀ Female' : '♂ Male';
  $('mFollow').checked = S.follow; $('mAwake').checked = S.keepAwake; $('mVolume').value = S.volume;
}
$('bSpeed').onclick = () => $('speedSheet').showModal();
$('btnMenu').onclick = () => { renderRecent(); renderBookmarks(); fillSysVoices(); updateInfo(); $('menu').showModal(); };
// list of the device's own voices (built-in engine only)
function fillSysVoices() {
  const row = $('sysVoiceRow'), sel = $('mSysVoice');
  row.hidden = engine !== 'system';
  if (row.hidden) return;
  sel.textContent = '';
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
  add('', `Automatic (${sysName()})`);
  const list = sysVoices().filter(v => sysQuality(v) > -2)
    .sort((a, b) => sysQuality(b) - sysQuality(a) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  for (const v of list) add(v.voiceURI, `${v.name.replace(/\s*\(English[^)]*\)+$/, '')} (${v.lang.replace('_', '-')})`);
  sel.value = S.sysVoiceURI && list.some(v => v.voiceURI === S.sysVoiceURI) ? S.sysVoiceURI : '';
}
$('mSysVoice').onchange = () => {
  S.sysVoiceURI = $('mSysVoice').value; saveSettings(); reVoice(); flash(`Voice: ${sysName()}`);
};
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
const closeSheets = () => document.querySelectorAll('dialog[open]').forEach(d => d.close());
$('mOpen').onclick = () => { closeSheets(); openPicker(); };
$('mGoto').onclick = gotoPage;
$('mBookmark').onclick = () => { addBookmark(); };
$('mSmaller').onclick = () => setFont(S.font - 1);
$('mLarger').onclick = () => setFont(S.font + 1);
$('mFollow').onchange = () => { S.follow = $('mFollow').checked; saveSettings(); };
$('mAwake').onchange = () => { S.keepAwake = $('mAwake').checked; saveSettings(); wakeLock(); };
$('mVolume').oninput = () => { S.volume = +$('mVolume').value; saveSettings(); if (E.gain) E.gain.gain.value = S.volume / 100; };
for (const b of $('segEngine').children) b.onclick = () => setEngine(b.dataset.v);
function setEngine(v) {
  if (S.engine === v) return;
  S.engine = v; saveSettings(); syncControls();
  if (v === 'gpu') localStorage.removeItem('narrator.gpuFailed');   // chosen on purpose: allow another try
  const wasPlaying = E.playing;
  if (E.playing) pause();
  if (engine === 'system') sysStop();
  if (worker && worker.terminate) worker.terminate();
  worker = null;
  ttsReady = false; ttsError = null; engine = ''; dl = { loaded: 0, total: 0 }; dlCached = false;
  E.cache.clear(); E.inflight = null; E.gen++;
  startWorker();
  flash(v === 'cpu' ? 'Switching to the compact voice engine…' : v === 'system' ? 'Switching to the built-in voices…' : 'Switching voice engine…');
  if (v === 'gpu' && APPLE_MOBILE) setTimeout(() => flash('Fast may run out of memory on iPhone/iPad. If the app restarts, it switches back by itself.', 7000), 3600);
  if (wasPlaying) { const t = setInterval(() => { if (ttsReady) { clearInterval(t); play(); } }, 300); }
}
$('mReset').onclick = async () => {
  if (!confirm('Remove the downloaded voices, stored books, reading positions and settings from this device?')) return;
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* ignore */ }
  try { indexedDB.deleteDatabase('narrator'); } catch { /* ignore */ }
  localStorage.clear();
  location.reload();
};
function updateInfo() {
  const eng = !ttsReady ? 'loading' : engine === 'gpu' ? 'fast (graphics chip)'
    : engine === 'system' ? `built-in voices (${sysVoice ? sysVoice.name : 'default'})`
    : `compact (processor, ${threads ? 'multi-core' : 'single-core'})`;
  const spd = engine !== 'system' && E.rtf ? ` · speed ${(1 / E.rtf).toFixed(1)}× real time${E.rtf > 0.9 ? ' (too slow: expect pauses)' : ''}` : '';
  $('mInfo').textContent = `Version ${VERSION} · voice engine: ${eng}${spd}`;
}

document.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea, dialog')) return;
  const k = e.key;
  const map = {
    ' ': togglePlay, ArrowLeft: () => jump(-10), ArrowRight: () => jump(30),
    ArrowUp: () => seek(E.cur - 1), ArrowDown: () => seek(E.cur + 1),
    PageUp: prevChapter, PageDown: nextChapter, Home: () => seek(0), End: () => E.book && seekTime(totalTime() - 15),
  };
  if (map[k]) { e.preventDefault(); map[k](); }
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'o') { e.preventDefault(); openPicker(); }
});

// ------------------------------------------------------------------ service worker (offline + speed)
async function registerSW(noThreads) {
  if (!('serviceWorker' in navigator) || MOCK) return;
  const nt = noThreads || localStorage.getItem('narrator.noThreads') === '1';
  try {
    const reg = await navigator.serviceWorker.register(`sw.js${nt ? '?coi=0' : ''}`);
    if (!nt && !self.crossOriginIsolated && !sessionStorage.getItem('narrator.coiReload')) {
      // reload once so the page runs with multi-core voice synthesis enabled
      const go = () => { sessionStorage.setItem('narrator.coiReload', '1'); location.reload(); };
      if (navigator.serviceWorker.controller) go();
      else navigator.serviceWorker.addEventListener('controllerchange', go, { once: true });
    }
    return reg;
  } catch (e) { console.warn('Service worker not registered', e); }
}

// ------------------------------------------------------------------ start
setTheme(S.theme); setFont(S.font); syncControls(); renderRecent();
registerSW();
try { navigator.storage?.persist?.(); } catch { /* ignore */ }
startWorker();
if (crashNote) setTimeout(() => flash(crashNote, 9000), 500);
setInterval(sysWatchdog, 1000);
setInterval(() => {
  if (E.book) {
    if (E.cur !== shownCur) refreshHighlight();
    updateTimes();
    if (Date.now() - (E._lastSave || 0) > 5000) { E._lastSave = Date.now(); savePosition(); }
    if (Date.now() >= followPauseUntil && !$('nowReading').hidden) $('nowReading').hidden = true;
  }
  if (sleep.until && Date.now() >= sleep.until) { sleep.until = 0; $('mSleep').value = '0'; if (E.playing) pause(); flash('Sleep timer: paused'); }
  updateStatus();
}, 250);
