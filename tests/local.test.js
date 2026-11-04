'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-local-'));
process.env.CAPRI_HOME = tmp;
const BODY = Buffer.alloc(300000, 7);

test('downloads from the Hugging Face endpoint and resumes a partial file', async () => {
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range || '');
    const from = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, { 'content-length': BODY.length - from });
    res.end(BODY.subarray(from));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.HF_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  const local = require('../src/main/local');
  fs.mkdirSync(path.dirname(local.modelPath()), { recursive: true });
  fs.writeFileSync(`${local.modelPath()}.part`, BODY.subarray(0, 100000)); // an interrupted download
  assert.equal(local.downloaded(), false);
  let last = 0;
  await local.download((done) => { last = done; });
  server.close();
  assert.equal(last, BODY.length);
  assert.equal(fs.statSync(local.modelPath()).size, BODY.length);
  assert.ok(local.downloaded());
});

test('ensure starts llama-server with the GPU/context flags and stops it', async () => {
  const local = require('../src/main/local');
  const argsFile = path.join(tmp, 'args.json');
  const fake = path.join(tmp, 'llama-server');
  fs.writeFileSync(fake, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('http').createServer((q, r) => r.end('ok')).listen(port, '127.0.0.1');
`, { mode: 0o755 });
  process.env.CAPRI_LLAMA_PORT = '18999';
  const names = await local.ensure({ llamaServer: fake, localContext: 16384, localCacheType: 'q8_0' });
  assert.deepEqual(names, [local.NAME]);
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.equal(args[args.indexOf('-ngl') + 1], '99');
  assert.equal(args[args.indexOf('-c') + 1], '16384');
  assert.equal(args[args.indexOf('--cache-type-k') + 1], 'q8_0');
  local.stop();
});

test('ensure explains a missing llama-server', async () => {
  const local = require('../src/main/local');
  process.env.CAPRI_LLAMA_PORT = '18998';
  await assert.rejects(local.ensure({ llamaServer: path.join(tmp, 'nope') }), { code: 'nobin' });
});
