'use strict';

// Her own local mode: one model, Qwen3-8B (Q2_K, ISTA-DASLab/Qwen3-8B-GGUF-GSQ), run by llama.cpp's
// `llama-server` on this PC. Never on by itself: you pick "Capri local" in her AI menu, and the
// download and the server only happen then. Equivalent of:
//   huggingface-cli download ISTA-DASLab/Qwen3-8B-GGUF-GSQ Qwen3-8B-Q2_K.gguf --local-dir <models>

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const os = require('node:os');

// outside Electron (tests), the data folder is CAPRI_HOME's
let app = null;
try { ({ app } = require('electron')); } catch { /* not in Electron */ }

const REPO = 'ISTA-DASLab/Qwen3-8B-GGUF-GSQ';
const FILE = 'Qwen3-8B-Q2_K.gguf';
const NAME = 'Qwen3-8B-Q2_K';
const PORT = 18080;
const PORT_NOW = () => Number(process.env.CAPRI_LLAMA_PORT) || PORT;
const URL_BASE = `http://127.0.0.1:${PORT}`;

const dir = () => (app?.getPath ? path.join(app.getPath('userData'), 'models') : path.join(process.env.CAPRI_HOME || path.join(os.homedir(), '.capri'), 'models'));
const modelPath = () => path.join(dir(), FILE);
const downloaded = () => fs.existsSync(modelPath());
const fail = (message, code) => Object.assign(new Error(message), { code });

// Fetches the model from Hugging Face (resumes a partial download): onProgress(done, total).
async function download(onProgress, signal) {
  fs.mkdirSync(dir(), { recursive: true });
  const part = `${modelPath()}.part`;
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(`${(process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '')}/${REPO}/resolve/main/${FILE}`, {
    headers: have ? { range: `bytes=${have}-` } : {}, signal, redirect: 'follow',
  });
  if (!res.ok && res.status !== 206) throw fail(`Hugging Face answered ${res.status}`, 'download');
  const resumed = res.status === 206;
  const total = (Number(res.headers.get('content-length')) || 0) + (resumed ? have : 0);
  const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
  let done = resumed ? have : 0;
  try {
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      done += chunk.length;
      onProgress?.(done, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (total && done < total) throw fail('download incomplete', 'download');
  fs.renameSync(part, modelPath());
}

function binary(cfg) {
  return cfg.llamaServer || process.env.LLAMA_SERVER || 'llama-server';
}

// Two llama-servers can run on the model: `chat` (port P) and `embed` (P+1). Embeddings get their own
// instance because a server started with --embeddings serves only embeddings, not chat completions.
const slots = {
  chat: { child: null, starting: null, port: () => PORT_NOW() },
  embed: { child: null, starting: null, port: () => PORT_NOW() + 1 },
};

async function healthy(slot) {
  const res = await fetch(`http://127.0.0.1:${slot.port()}/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  return Boolean(res?.ok);
}

function argsFor(kind, cfg) {
  const base = ['-m', modelPath(), '--host', '127.0.0.1'];
  if (kind === 'embed') {
    // CPU by default (localEmbedGpuLayers): the model's weights are already on the GPU for chat
    return [...base, '--port', String(slots.embed.port()), '-c', '2048', '--embeddings', '--pooling', 'mean', '-ngl', String(cfg.localEmbedGpuLayers ?? 0)];
  }
  return [...base, '--port', String(slots.chat.port()), '-c', String(cfg.localContext ?? 16384), '--jinja', '-ngl', String(cfg.localGpuLayers ?? 99),
    ...(cfg.localCacheType ? ['--cache-type-k', cfg.localCacheType, '--cache-type-v', cfg.localCacheType] : [])];
}

// Starts (when needed) and waits for one llama-server. Throws with a code: 'nolocal' (not downloaded),
// 'nobin' (llama-server not found), 'start' (it didn't come up).
async function boot(kind, cfg) {
  const slot = slots[kind];
  if (!downloaded()) throw fail('Capri local: model not downloaded yet (AI model menu → Download)', 'nolocal');
  if (await healthy(slot)) return;
  if (!slot.starting) {
    slot.starting = (async () => {
      const child = spawn(binary(cfg), argsFor(kind, cfg), { stdio: 'ignore', windowsHide: true });
      let gone = null;
      child.on('error', (err) => { gone = err.code === 'ENOENT' ? fail('llama-server not found: install llama.cpp or set llamaServer in config.json', 'nobin') : err; });
      child.on('exit', () => { if (slot.child === child) slot.child = null; gone ||= fail('llama-server stopped', 'start'); });
      slot.child = child;
      for (let i = 0; i < 120 && !gone; i++) {
        if (await healthy(slot)) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
      slot.child?.kill();
      slot.child = null;
      throw gone || fail('llama-server took too long to start', 'start');
    })().finally(() => { slot.starting = null; });
  }
  await slot.starting;
}

async function ensure(cfg) {
  await boot('chat', cfg);
  return [NAME];
}

// Vectors for some texts (from the embeddings instance, started on first use): [[number]]
async function embed(cfg, texts) {
  await boot('embed', cfg);
  const res = await fetch(`http://127.0.0.1:${slots.embed.port()}/v1/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: texts }), signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw fail(`embeddings answered ${res.status}`, 'embed');
  const { data = [] } = await res.json();
  return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function stop() {
  for (const slot of Object.values(slots)) {
    const child = slot.child;
    slot.child = null;
    child?.kill();
  }
}

module.exports = { NAME, URL_BASE, downloaded, download, ensure, embed, stop, modelPath };
