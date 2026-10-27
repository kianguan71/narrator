// tts-worker.js - runs the Kokoro voice model off the main thread.
// Messages in:  {type:'load', engine:'auto'|'gpu'|'cpu'} | {type:'synth', id, text, voice, speed}
// Messages out: {type:'engine', engine} | {type:'cached', cached} | {type:'progress', loaded, total}
//               {type:'ready', engine, threads}
//               {type:'audio', id, data(Float32Array) | error} | {type:'error', message}
//
// Engines:
//   gpu - WebGPU (graphics chip), full-precision model (~330 MB, once). About 8-10x faster than
//         real time on a typical PC, so speech never has to wait.
//   cpu - WebAssembly (processor), compact 8-bit model (~90 MB). Close to real time on a fast PC,
//         slower on phones, so it can pause between sentences.
import { KokoroTTS, env } from './lib/kokoro.web.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
env.wasmPaths = new URL('./lib/', import.meta.url).href;   // self-hosted runtime

let tts = null;
const files = new Map();   // file -> {loaded,total}

function reportProgress(p) {
  if (!p || !p.file) return;
  if (p.status === 'progress' || p.status === 'done') {
    const prev = files.get(p.file) || { loaded: 0, total: 0 };
    const total = p.total || prev.total;
    const loaded = p.status === 'done' ? (total || prev.loaded) : (p.loaded ?? prev.loaded);
    files.set(p.file, { loaded, total });
    let L = 0, T = 0;
    for (const f of files.values()) { L += f.loaded; T += f.total; }
    self.postMessage({ type: 'progress', loaded: L, total: T });
  }
}

async function gpuAvailable() {
  try {
    if (!self.navigator || !self.navigator.gpu) return false;
    const adapter = await self.navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

async function load(engine) {
  files.clear();
  self.postMessage({ type: 'engine', engine });            // lets the page notice if loading crashes it
  try {                                                     // already stored on this device?
    const c = await caches.open('transformers-cache');
    const file = engine === 'gpu' ? 'model.onnx' : 'model_quantized.onnx';
    const hit = await c.match(`https://huggingface.co/${MODEL_ID}/resolve/main/onnx/${file}`);
    self.postMessage({ type: 'cached', cached: !!hit });
  } catch { /* no cache storage */ }
  return KokoroTTS.from_pretrained(MODEL_ID, engine === 'gpu'
    ? { dtype: 'fp32', device: 'webgpu', progress_callback: reportProgress }
    : { dtype: 'q8', device: 'wasm', progress_callback: reportProgress });
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    let engine = m.engine === 'cpu' ? 'cpu' : (await gpuAvailable() ? 'gpu' : 'cpu');
    if (m.engine === 'gpu' && engine !== 'gpu') engine = 'cpu';
    try {
      try {
        tts = await load(engine);
        await tts.generate('Ready.', { voice: 'af_heart', speed: 1 });   // warm-up
      } catch (err) {
        if (engine !== 'gpu') throw err;
        engine = 'cpu';                       // graphics chip failed: fall back to the processor
        tts = await load('cpu');
        await tts.generate('Ready.', { voice: 'af_heart', speed: 1 });
      }
      self.postMessage({ type: 'ready', engine, threads: self.crossOriginIsolated === true });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  } else if (m.type === 'synth') {
    if (!tts) { self.postMessage({ type: 'audio', id: m.id, error: 'not ready' }); return; }
    try {
      const out = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
      const data = new Float32Array(out.audio);   // own copy, transferable
      self.postMessage({ type: 'audio', id: m.id, data }, [data.buffer]);
    } catch (err) {
      self.postMessage({ type: 'audio', id: m.id, error: String(err && err.message || err) });
    }
  }
};
