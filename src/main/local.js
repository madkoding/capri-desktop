'use strict';

// Her own local mode: one model, Qwen3-8B (Q2_K, ISTA-DASLab/Qwen3-8B-GGUF-GSQ), run by llama.cpp's
// `llama-server` on this PC. Never on by itself: you pick "Capri local" in her AI menu, and the
// download and the server only happen then. Equivalent of:
//   huggingface-cli download ISTA-DASLab/Qwen3-8B-GGUF-GSQ Qwen3-8B-Q2_K.gguf --local-dir <models>

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const REPO = 'ISTA-DASLab/Qwen3-8B-GGUF-GSQ';
const FILE = 'Qwen3-8B-Q2_K.gguf';
const NAME = 'Qwen3-8B-Q2_K';
const PORT = 18080;
const URL_BASE = `http://127.0.0.1:${PORT}`;

let server = null;
let starting = null;

const dir = () => path.join(app.getPath('userData'), 'models');
const modelPath = () => path.join(dir(), FILE);
const downloaded = () => fs.existsSync(modelPath());
const fail = (message, code) => Object.assign(new Error(message), { code });

// Fetches the model from Hugging Face (resumes a partial download): onProgress(done, total).
async function download(onProgress, signal) {
  fs.mkdirSync(dir(), { recursive: true });
  const part = `${modelPath()}.part`;
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(`https://huggingface.co/${REPO}/resolve/main/${FILE}`, {
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

async function healthy() {
  const res = await fetch(`${URL_BASE}/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  return Boolean(res?.ok);
}

// llama-server up on the model (starts it when needed). Throws with a code: 'nolocal' (not downloaded),
// 'nobin' (llama-server not found), 'start' (it didn't come up).
async function ensure(cfg) {
  if (!downloaded()) throw fail('Capri local: model not downloaded yet (AI model menu → Download)', 'nolocal');
  if (await healthy()) return [NAME];
  if (!starting) {
    starting = (async () => {
      const child = spawn(binary(cfg), ['-m', modelPath(), '--host', '127.0.0.1', '--port', String(PORT), '-c', '4096', '--jinja'], {
        stdio: 'ignore', windowsHide: true,
      });
      let gone = null;
      child.on('error', (err) => { gone = err.code === 'ENOENT' ? fail('llama-server not found: install llama.cpp or set llamaServer in config.json', 'nobin') : err; });
      child.on('exit', () => { if (server === child) server = null; gone ||= fail('llama-server stopped', 'start'); });
      server = child;
      for (let i = 0; i < 120 && !gone; i++) {
        if (await healthy()) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
      stop();
      throw gone || fail('llama-server took too long to start', 'start');
    })().finally(() => { starting = null; });
  }
  await starting;
  return [NAME];
}

function stop() {
  const child = server;
  server = null;
  child?.kill();
}

module.exports = { NAME, URL_BASE, downloaded, download, ensure, stop, modelPath };
