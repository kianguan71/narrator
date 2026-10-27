// tts-worker.js - runs the Kokoro voice model off the main thread.
// Messages in:  {type:'load'} | {type:'synth', id, text, voice, speed}
// Messages out: {type:'progress', loaded, total} | {type:'ready', threads}
//               {type:'audio', id, data(Float32Array) | error} | {type:'error', message}
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

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'q8', device: 'wasm', progress_callback: reportProgress,
      });
      // warm up so the first real sentence starts quickly
      await tts.generate('Ready.', { voice: 'af_heart', speed: 1 });
      self.postMessage({ type: 'ready', threads: self.crossOriginIsolated === true });
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
