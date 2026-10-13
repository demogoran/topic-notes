// Parakeet TDT inference worker — ONNX Runtime Web, encoder on WebGPU (fallback WASM),
// greedy TDT decoding in JS.
//
// Adapted from mrfakename's "parakeet-redux-webgpu" demo:
// https://huggingface.co/spaces/mrfakename/parakeet-redux-webgpu
// Model: nvidia/parakeet-tdt-0.6b-v3 (21 European languages incl. Ukrainian).
//
// Message protocol:
//   -> { type: 'load', cfg: { repo, files: { pre, enc, dec, vocab } } }
//   -> { type: 'transcribe', id, pcm }          (pcm: Float32Array @16 kHz, transferred)
//   <- { type: 'progress', loaded, total }
//   <- { type: 'status', text }
//   <- { type: 'loaded', device }
//   <- { type: 'result', id, text }
//   <- { type: 'error', id?, message }

import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
ort.env.logLevel = "error";

const CACHE_NAME = "voicenotes-parakeet-v1";
const SR = 16000;
const BLANK = 8192;
const VOCAB = 8193;
const DURATIONS = [0, 1, 2, 3, 4];
const MAX_SYMBOLS = 10;
const CHUNK_SEC = 30;

let state = { pre: null, enc: null, dec: null, vocab: null, encDevice: null };
const post = (type, data = {}) => self.postMessage({ type, ...data });

// ---------------------------------------------------------------- downloads
async function treeSizes(repo) {
  const r = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`);
  if (!r.ok) throw new Error(`tree ${repo}: ${r.status}`);
  const out = {};
  for (const f of await r.json()) out[f.path] = f.lfs?.size ?? f.size;
  return out;
}

async function readInto(resp, buf, offset, onBytes) {
  const reader = resp.body.getReader();
  let pos = offset;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.set(value, pos);
    pos += value.length;
    onBytes(value.length);
  }
  return pos - offset;
}

// Parallel ranged download from the Hub, stored in the Cache API.
async function getFile(url, size, onBytes) {
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch {}
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const ab = await hit.arrayBuffer();
      if (!size || ab.byteLength === size) { onBytes(ab.byteLength, true); return new Uint8Array(ab); }
    }
  }
  let buf;
  const CH = 8 << 20, CONC = 8;
  if (size && size > 2 * CH) {
    buf = new Uint8Array(size);
    const ranges = [];
    for (let s = 0; s < size; s += CH) ranges.push([s, Math.min(size, s + CH) - 1]);
    let next = 0;
    const worker = async () => {
      while (next < ranges.length) {
        const [s, e] = ranges[next++];
        for (let attempt = 0; ; attempt++) {
          let got = 0;
          try {
            const r = await fetch(url, { headers: { Range: `bytes=${s}-${e}` } });
            if (r.status !== 206) throw new Error(`range ${r.status}`);
            const n = await readInto(r, buf, s, (k) => { got += k; onBytes(k); });
            if (n !== e - s + 1) throw new Error("short read");
            break;
          } catch (err) {
            onBytes(-got);
            if (attempt >= 3) throw err;
            await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
          }
        }
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
  } else {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const len = size || +r.headers.get("content-length") || 0;
    if (len) { buf = new Uint8Array(len); await readInto(r, buf, 0, onBytes); }
    else { const ab = await r.arrayBuffer(); onBytes(ab.byteLength); buf = new Uint8Array(ab); }
  }
  if (cache) {
    try { await cache.put(url, new Response(buf, { headers: { "content-type": "application/octet-stream" } })); } catch {}
  }
  return buf;
}

// ---------------------------------------------------------------- model
async function load(cfg) {
  post("status", { text: "Fetching model files…" });
  for (const s of [state.pre, state.enc, state.dec]) { try { await s?.release(); } catch {} }
  state = {};
  const sizes = await treeSizes(cfg.repo).catch(() => ({}));
  const names = Object.values(cfg.files);
  const total = names.reduce((a, n) => a + (sizes[n] || 0), 0);
  let loaded = 0, lastPost = 0;
  const onBytes = (n) => {
    loaded += n;
    const now = performance.now();
    if (now - lastPost > 80) { lastPost = now; post("progress", { loaded, total }); }
  };
  const base = `https://huggingface.co/${cfg.repo}/resolve/main/`;
  const bufs = await Promise.all(names.map((n) => getFile(base + n, sizes[n], onBytes)));
  post("progress", { loaded: total || loaded, total: total || loaded });

  post("status", { text: "Compiling model…" });
  const vocab = [];
  for (const line of new TextDecoder().decode(bufs[3]).split("\n")) {
    if (!line) continue;
    const i = line.lastIndexOf(" ");
    vocab[+line.slice(i + 1)] = line.slice(0, i);
  }
  const wasmOpts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  const pre = await ort.InferenceSession.create(bufs[0], wasmOpts);
  const dec = await ort.InferenceSession.create(bufs[2], wasmOpts);
  let enc, encDevice = "wasm";
  if (navigator.gpu) {
    try {
      enc = await ort.InferenceSession.create(bufs[1], { executionProviders: ["webgpu"], graphOptimizationLevel: "all" });
      encDevice = "webgpu";
    } catch (e) {
      console.warn("WebGPU session failed, falling back to WASM", e);
    }
  }
  if (!enc) enc = await ort.InferenceSession.create(bufs[1], wasmOpts);
  state = { pre, enc, dec, vocab, encDevice };

  post("status", { text: "Warming up…" });
  await transcribePcm(new Float32Array(SR));
  post("loaded", { device: encDevice });
}

// ---------------------------------------------------------------- inference
async function encode(pcm) {
  const wav = new ort.Tensor("float32", pcm, [1, pcm.length]);
  const wl = new ort.Tensor("int64", BigInt64Array.from([BigInt(pcm.length)]), [1]);
  const pf = await state.pre.run({ waveforms: wav, waveforms_lens: wl });
  const feats = pf[state.pre.outputNames[0]];
  const flen = pf[state.pre.outputNames[1]];
  const eo = await state.enc.run({ audio_signal: feats, length: flen });
  const out = eo[state.enc.outputNames[0]];
  const olen = Number(eo[state.enc.outputNames[1]].data[0]);
  const [, D, T] = out.dims;
  const src = out.data; // [1, D, T]
  const frames = Math.min(olen, T);
  const enc = new Float32Array(frames * D);
  for (let d = 0; d < D; d++) {
    const row = d * T;
    for (let t = 0; t < frames; t++) enc[t * D + d] = src[row + t];
  }
  feats.dispose?.(); out.dispose?.();
  return { enc, frames, D };
}

async function greedy({ enc, frames, D }) {
  const dec = state.dec;
  const zeros = () => new ort.Tensor("float32", new Float32Array(2 * 640), [2, 1, 640]);
  let s1 = zeros(), s2 = zeros();
  let last = BLANK, t = 0, steps = MAX_SYMBOLS * frames;
  const tokens = [];
  const tl = new ort.Tensor("int32", Int32Array.from([1]), [1]);
  const fetches = ["outputs", "output_states_1", "output_states_2"];
  while (t < frames && steps > 0) {
    const feeds = {
      encoder_outputs: new ort.Tensor("float32", enc.subarray(t * D, (t + 1) * D), [1, D, 1]),
      targets: new ort.Tensor("int32", Int32Array.from([last]), [1, 1]),
      target_length: tl,
      input_states_1: s1,
      input_states_2: s2,
    };
    const o = await dec.run(feeds, fetches);
    const lg = o.outputs.data;
    let tok = 0, best = -Infinity;
    for (let i = 0; i < VOCAB; i++) if (lg[i] > best) { best = lg[i]; tok = i; }
    let di = 0, bd = -Infinity;
    for (let i = 0; i < DURATIONS.length; i++) if (lg[VOCAB + i] > bd) { bd = lg[VOCAB + i]; di = i; }
    let du = DURATIONS[di];
    if (tok === BLANK && du === 0) du = 1;
    tokens.push(tok);
    t += du;
    if (tok !== BLANK) { last = tok; s1 = o.output_states_1; s2 = o.output_states_2; }
    steps--;
  }
  return tokens;
}

const SKIP = new Set(["<unk>", "<pad>", "<blk>"]);
function decodeText(ids) {
  let s = "";
  for (const i of ids) { const p = state.vocab[i]; if (p !== undefined && !SKIP.has(p)) s += p; }
  return s.replace(/▁/g, " ").trim();
}

// Cut long audio near the quietest 100 ms between 20 s and 30 s into the span.
function chunks(pcm) {
  const cap = CHUNK_SEC * SR;
  if (pcm.length <= cap) return [[0, pcm.length]];
  const out = [];
  let start = 0;
  const win = SR / 10;
  while (pcm.length - start > cap) {
    let bestE = Infinity, bestI = start + cap;
    for (let i = start + 20 * SR; i + win <= start + cap; i += win / 2) {
      let e = 0;
      for (let j = i; j < i + win; j++) e += pcm[j] * pcm[j];
      if (e < bestE) { bestE = e; bestI = i + win / 2; }
    }
    out.push([start, bestI]);
    start = bestI;
  }
  if (pcm.length - start > SR * 0.05) out.push([start, pcm.length]);
  return out;
}

async function transcribePcm(pcm) {
  const parts = [];
  const cs = chunks(pcm);
  for (let c = 0; c < cs.length; c++) {
    const piece = pcm.subarray(cs[c][0], cs[c][1]);
    if (piece.length < 400) continue;
    const encoded = await encode(piece);
    const tokens = await greedy(encoded);
    const text = decodeText(tokens);
    if (text) parts.push(text);
    if (cs.length > 1 && c < cs.length - 1) {
      post("status", { text: `Transcribing… part ${c + 2}/${cs.length}` });
    }
  }
  return { text: parts.join(" ") };
}

let busy = Promise.resolve();
self.onmessage = (ev) => {
  const msg = ev.data;
  busy = busy.then(async () => {
    try {
      if (msg.type === "load") {
        await load(msg.cfg);
      } else if (msg.type === "transcribe") {
        if (!state.enc) throw new Error("Model not loaded");
        const r = await transcribePcm(msg.pcm);
        post("result", { id: msg.id, text: r.text });
      }
    } catch (e) {
      console.error(e);
      post("error", { id: msg.id, message: String(e?.message || e) });
    }
  });
};
