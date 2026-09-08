import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import ts from '../dapp/node_modules/typescript/lib/typescript.js';

// Execute the production handlers/modules with network and storage doubles. No live writes.
function load(file, mocks = {}, globals = {}) {
  const path = resolve(file), req = createRequire(path);
  const source = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  runInNewContext('(function(require,module,exports){' + source + '\n})', { Buffer, Uint8Array, AbortSignal, console, ...globals }, { filename: path })((name) => name in mocks ? mocks[name] : req(name), module, module.exports);
  return module.exports;
}
const points = { good: '1'.padStart(64, '0') + '2'.padStart(64, '0'), bad: '3'.padStart(64, '0') + '4'.padStart(64, '0') };
function shield(answers, calls = []) {
  return load('dapp/src/lib/shield/chain.ts', {
    snarkjs: {}, '../../config': { ENDPOINTS: ['https://one', 'https://two', 'https://three'], SHIELD: { contract: 'xprshield' } },
    '../crypto/babyjub': {}, './notes': { words: (h) => h.match(/.{64}/g).map((w) => BigInt('0x' + w)) },
  }, { fetch: async (url, options) => {
    const ep = new URL(url).hostname, body = JSON.parse(options.body);
    calls.push(body);
    const answer = answers[ep];
    if (answer instanceof Error) throw answer;
    return { ok: true, json: async () => typeof answer === 'function' ? answer(body) : { rows: answer, more: false } };
  } });
}
const row = (key = points.good) => ({ owner: 'bob', pubkey: key });
test('recipient key fails closed with only one reachable server, including repeated reads', async () => {
  const sh = shield({ one: [row(points.bad)], two: new Error('offline'), three: new Error('offline') });
  await assert.rejects(sh.registeredKeys(), /two independent servers/);
  await assert.rejects(sh.registeredKey('bob'), /two independent servers/);
});
test('two honest servers defeat a substituted key and recipient names stay local', async () => {
  const calls = [], sh = shield({ one: [row(points.bad)], two: [row()], three: [row()] }, calls);
  assert.equal(String(await sh.registeredKey('bob')), '1,2');
  await sh.registeredKey('bob');
  assert.equal(calls.length, 3, 'only quorum-confirmed data is cached');
  assert.ok(calls.every((body) => !JSON.stringify(body).includes('bob')));
});
test('disagreeing servers cannot authorize a recipient key', async () => {
  const sh = shield({ one: [row(points.bad)], two: [row()], three: new Error('offline') });
  assert.equal(await sh.registeredKey('bob'), null);
});
test('duplicate rows cannot supply additional votes', async () => {
  const sh = shield({ one: [row(), row()], two: new Error('offline'), three: new Error('offline') });
  await assert.rejects(sh.registeredKey('bob'), /two independent servers/);
});
test('pagination retains keys past 20,000 rows', async () => {
  const names = Array.from({length: 21001}, (_, i) => 'u' + i.toString(32).replace(/./g, (c) => 'abcdefghijklmnopqrstuvwxyz12345.'[parseInt(c, 32)]));
  const page = (body) => { const n = Number(body.lower_bound ?? 0), end = Math.min(n + 1000, names.length); return { rows: names.slice(n, end).map((owner) => ({ owner, pubkey: points.good })), more: end < names.length, next_key: String(end) }; };
  const sh = shield({ one: page, two: page, three: new Error('offline') });
  assert.equal((await sh.registeredKeys()).size, 21001);
  assert.equal(String(await sh.registeredKey(names.at(-1))), '1,2');
});
test('a repeating pagination cursor fails instead of looping or trusting partial data', async () => {
  const page = () => ({ rows: [row()], more: true, next_key: '1' });
  await assert.rejects(shield({ one: page, two: page, three: page }).registeredKeys(), /two independent servers/);
});
const files = load('ceremony-web/shared/files.ts');
const hash = 'a'.repeat(64), token = 'private-lock-token';
const state = { version: 1, phase: 1, head: { index: 0, sha256: 'b'.repeat(64) }, lock: { actor: 'alice', until: new Date(Date.now() + 60000).toISOString(), tokenHash: createHash('sha256').update(token).digest('hex') }, contributions: [] };
const stateModule = { readState: async () => state, lockActive: () => true, writeState: () => { throw new Error('unexpected mutation'); } };
function response() { return { code: 200, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; }, end() { return this; } }; }
function contribution(overrides = {}) {
  return { actor: 'alice', token, phase: 1, index: 1, inputSha256: state.head.sha256, outputSha256: hash, signature: 'invalid', ...overrides };
}
function contributeHandler() {
  return load('ceremony-web/api/contribute.ts', {
    './_lib/state.js': stateModule, '../shared/files.js': files,
    './_lib/verify.js': { noteFor: () => 'note', verifyAttestation: async () => { throw new Error('invalid signature'); } },
    './_lib/chain.js': { fetchToTmp: () => assert.fail('download before authentication') },
    '@vercel/blob': { head: () => assert.fail('blob access before authentication') },
  }).default;
}
test('unauthenticated contribution cannot reach file verification', async () => {
  const res = response(); await contributeHandler()({ method: 'POST', body: contribution({ token: '' }) }, res);
  assert.equal(res.code, 403);
});
test('invalid attestation is rejected before any download', async () => {
  const res = response(); await contributeHandler()({ method: 'POST', body: contribution() }, res);
  assert.equal(res.code, 400); assert.match(res.body.error, /invalid signature/);
});
test('replaying a lock request cannot rotate an active holder token', async () => {
  const handler = load('ceremony-web/api/lock.ts', { './_lib/state.js': stateModule, './_lib/verify.js': {} }).default;
  const res = response(); await handler({ method: 'POST', body: { actor: 'alice', ts: Date.now(), signature: 'replayed' } }, res);
  assert.equal(res.code, 409);
});
test('upload token cannot delete or overwrite a file and is bound to its content hash', async () => {
  const pathname = files.contributionPath(1, 1, 'alice', hash);
  const handler = load('ceremony-web/api/upload-token.ts', {
    './_lib/state.js': stateModule, '../shared/files.js': files,
    '@vercel/blob': { del: () => assert.fail('retry must not delete a transcript file') },
    '@vercel/blob/client': { handleUpload: async ({ onBeforeGenerateToken }) => onBeforeGenerateToken(pathname, JSON.stringify({ actor: 'alice', token, outputSha256: hash })) },
  }).default;
  const res = response(); await handler({ method: 'POST', body: {} }, res);
  assert.equal(res.code, 200); assert.equal(res.body.allowOverwrite, false);
  assert.notEqual(pathname, files.contributionPath(1, 1, 'alice', 'c'.repeat(64)));
});
