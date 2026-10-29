// piper-worker.js - Piper voices for Narrator: small, fast neural voices (about 63 MB each).
// Much lighter than Kokoro, so phones can make speech faster than it is spoken.
// Messages in:  {type:'load', voice} | {type:'synth', id, text, voice, speed}
// Messages out: {type:'engine', engine} | {type:'cached', cached} | {type:'progress', loaded, total}
//               {type:'ready', engine, threads} | {type:'audio', id, data | error} | {type:'error', message}
// Libraries come from the jsDelivr CDN at fixed versions (the browser keeps its own copy).
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const PHON_BASE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/';
let ort = null;                  // loaded on first use (the worker must listen for messages at once)
const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const VOICE_PATHS = {
  'en_US-lessac-medium': 'en/en_US/lessac/medium/',
  'en_US-ryan-medium': 'en/en_US/ryan/medium/',
  'en_GB-jenny_dioco-medium': 'en/en_GB/jenny_dioco/medium/',
  'en_GB-northern_english_male-medium': 'en/en_GB/northern_english_male/medium/',
};
const OUT_SR = 24000;            // the app plays everything at 24 kHz
const CACHE = 'piper-voices';

const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1;
async function runtime() {
  if (!ort) {
    ort = await import(ORT_BASE + 'ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = threads;
  }
  return ort;
}

// ---- text -> phoneme ids (espeak-ng, compiled to WebAssembly) -----------------------------
let phon = null, onLine = null;
async function phonemizer() {
  if (!phon) {
    // the phonemizer is a classic script: load it as a module by adding an export
    const src = await (await fetch(PHON_BASE + 'piper_phonemize.js')).text();
    const url = URL.createObjectURL(new Blob([src + '\nexport default createPiperPhonemize;\n'], { type: 'text/javascript' }));
    const createPiperPhonemize = (await import(url)).default;
    phon = await createPiperPhonemize({
      print: line => { const f = onLine; onLine = null; if (f) f(line); },
      printErr: msg => console.warn('phonemize:', msg),
      locateFile: f => PHON_BASE + f.replace(/^.*\//, ''),
    });
  }
  return phon;
}
function phonemeIds(text, cfg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onLine = null; reject(new Error('phonemizer timed out')); }, 15000);
    onLine = line => { clearTimeout(timer); try { resolve(JSON.parse(line).phoneme_ids); } catch (e) { reject(e); } };
    try {
      phon.callMain(['-l', cfg.espeak.voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
    } catch (e) { clearTimeout(timer); onLine = null; reject(e); }
  });
}

// ---- voice files: downloaded once, kept in the browser's storage --------------------------
const files = new Map();   // url -> {loaded,total}
function progress(url, loaded, total) {
  files.set(url, { loaded, total });
  let L = 0, T = 0;
  for (const f of files.values()) { L += f.loaded; T += f.total; }
  self.postMessage({ type: 'progress', loaded: L, total: T });
}
async function fetchCached(url, report) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* no cache storage */ }
  const hit = cache && await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download failed (${resp.status})`);
  const total = +resp.headers.get('content-length') || 0;
  const reader = resp.body.getReader(), parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); loaded += value.length;
    if (report) progress(url, loaded, total || loaded);
  }
  const buf = new Uint8Array(loaded);
  let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  if (cache) { try { await cache.put(url, new Response(buf)); } catch { /* storage full: still works this time */ } }
  return buf;
}
async function isCached(url) {
  try { return !!(await (await caches.open(CACHE)).match(url)); } catch { return false; }
}

const voices = new Map();  // key -> Promise<{session, cfg}>
function voice(key) {
  if (!VOICE_PATHS[key]) key = 'en_US-lessac-medium';
  if (!voices.has(key)) {
    const p = (async () => {
      const url = VOICE_BASE + VOICE_PATHS[key] + key + '.onnx';
      const cfg = JSON.parse(new TextDecoder().decode(await fetchCached(url + '.json', false)));
      const model = await fetchCached(url, true);
      const session = await (await runtime()).InferenceSession.create(model, { executionProviders: ['wasm'] });
      return { session, cfg };
    })();
    p.catch(() => voices.delete(key));
    voices.set(key, p);
  }
  return voices.get(key);
}

// ---- synthesis ---------------------------------------------------------------------------
function resample(x, from, to) {
  if (from === to) return Float32Array.from(x);
  const n = Math.floor(x.length * to / from), y = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) {
    const t = i * r, k = Math.floor(t), f = t - k;
    y[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f;
  }
  return y;
}
const big = a => BigInt64Array.from(a, v => BigInt(v));
async function synth(text, key, speed) {
  const { session, cfg } = await voice(key);
  await phonemizer();
  const ids = await phonemeIds(text, cfg);
  const inf = cfg.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', big(ids), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', big([ids.length]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / speed, inf.noise_w ?? 0.8]), [3]),
  };
  if ((cfg.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', big([0]), [1]);
  const out = await session.run(feeds);
  return resample(out.output.data, cfg.audio.sample_rate, OUT_SR);
}

// one request at a time, in order
let chain = Promise.resolve();
self.onmessage = e => {
  const m = e.data;
  if (m.type === 'load') {
    chain = chain.then(async () => {
      try {
        self.postMessage({ type: 'engine', engine: 'piper' });
        const key = VOICE_PATHS[m.voice] ? m.voice : 'en_US-lessac-medium';
        self.postMessage({ type: 'cached', cached: await isCached(VOICE_BASE + VOICE_PATHS[key] + key + '.onnx') });
        await Promise.all([phonemizer(), voice(key)]);
        await synth('Ready.', key, 1);                    // warm-up
        self.postMessage({ type: 'ready', engine: 'piper', threads: threads > 1 });
      } catch (err) {
        self.postMessage({ type: 'error', message: String(err && err.message || err) });
      }
    });
  } else if (m.type === 'synth') {
    chain = chain.then(async () => {
      try {
        const data = await synth(m.text, m.voice, Math.max(0.5, Math.min(2, m.speed || 1)));
        self.postMessage({ type: 'audio', id: m.id, data }, [data.buffer]);
      } catch (err) {
        self.postMessage({ type: 'audio', id: m.id, error: String(err && err.message || err) });
      }
    });
  }
};
