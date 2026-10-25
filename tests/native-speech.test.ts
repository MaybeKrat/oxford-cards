import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNativeSpeechService } = require('../desktop/native-speech.cjs');
const workerPath = fileURLToPath(new URL('../desktop/speech-worker.ps1', import.meta.url));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function wav() {
  const audio = Buffer.alloc(46);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(38, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(2, 40);
  audio.writeInt16LE(1000, 44);
  return audio.toString('base64');
}

class FakeWorker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  requests: Array<{ id: string; text: string }> = [];
  constructor() {
    super();
    this.stdin.on('data', (data) => this.requests.push(JSON.parse(data.toString())));
  }
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
  reply(index = 0, overrides = {}) {
    this.stdout.write(JSON.stringify({
      id: this.requests[index].id,
      audioBase64: wav(),
      voice: 'Microsoft David Desktop',
      lang: 'en-US',
      ...overrides,
    }) + '\n');
  }
}

function fixture(texts = ['apple', 'banana', 'cherry'], dependencies = {}) {
  const children: FakeWorker[] = [];
  const launches: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const service = createNativeSpeechService({ workerPath, allowedTexts: new Set(texts), cacheDir: '' }, {
    spawnProcess(command: string, args: string[], options: Record<string, unknown>) {
      const child = new FakeWorker();
      children.push(child);
      launches.push({ command, args, options });
      return child;
    },
    ...dependencies,
  });
  return { service, children, launches };
}

test('Speech accepts only catalog text and sends it through JSON stdin, never a shell command', async () => {
  const special = "a'; $(Write-Host injected)";
  const { service, children, launches } = fixture(['apple', special]);
  try {
    for (const input of ['', 'unknown', 'Apple', 'a'.repeat(201), null]) {
      await assert.rejects(service.prepare(input), /vocabulary/);
    }
    assert.equal(children.length, 0);
    const result = service.prepare(` ${special} `);
    assert.deepEqual(children[0].requests[0], { id: '1', text: special });
    const launch = launches[0];
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.windowsHide, true);
    assert.ok(launch.command.endsWith('powershell.exe'));
    assert.ok(launch.args.includes('-NoProfile'));
    assert.ok(launch.args.includes('-NonInteractive'));
    const source = Buffer.from(launch.args.at(-1)!, 'base64').toString('utf16le');
    assert.equal(source.includes(special), false);
    assert.ok(source.includes('$synthesizer.Speak([string]$request.text)'));
    assert.equal(source.includes('SetOutputToDefaultAudioDevice'), false);
    children[0].reply();
    assert.equal((await result).lang, 'en-US');
  } finally { service.dispose(); }
});

test('Speech deduplicates preparation, serializes the worker and caches complete WAV audio', async () => {
  const { service, children } = fixture();
  try {
    const first = service.prepare('apple');
    assert.equal(service.prepare(' apple '), first);
    const second = service.prepare('banana');
    assert.equal(children[0].requests.length, 1);
    children[0].reply();
    const firstValue = await first;
    await tick();
    assert.equal(children[0].requests.length, 2);
    assert.equal(children[0].requests[1].text, 'banana');
    children[0].reply(1);
    await second;
    assert.equal(await service.prepare('apple'), firstValue);
    assert.equal(children[0].requests.length, 2);
    assert.equal(Buffer.from(firstValue.audioBase64, 'base64').toString('ascii', 0, 4), 'RIFF');
    assert.equal(Object.isFrozen(firstValue), true);
  } finally { service.dispose(); }
});

test('Speech rejects a wrong response id, cancels queued work and can start a fresh owned worker', async () => {
  const { service, children } = fixture();
  try {
    const first = assert.rejects(service.prepare('apple'), /Invalid response/);
    const queued = assert.rejects(service.prepare('banana'), /Invalid response/);
    children[0].reply(0, { id: 'unrequested' });
    await Promise.all([first, queued]);
    assert.equal(children[0].killed, true);
    const next = service.prepare('apple');
    assert.equal(children.length, 2);
    children[1].reply();
    await next;
  } finally { service.dispose(); }
});

test('Speech rejects malformed and truncated WAV files instead of caching or playing them', async () => {
  for (const audioBase64 of [
    'bm90LWF1ZGlv',
    Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE').toString('base64'),
    wav().slice(0, -4),
  ]) {
    const { service, children } = fixture();
    try {
      const rejected = assert.rejects(service.prepare('apple'), /audio|WAV/);
      children[0].reply(0, { audioBase64 });
      await rejected;
      assert.equal(children[0].killed, true);
    } finally { service.dispose(); }
  }
});

test('A stalled synthesis times out, kills only its owned worker and permits a later retry', async () => {
  const { service, children } = fixture(undefined, { timeoutMs: 25 });
  try {
    const first = assert.rejects(service.prepare('apple'), /timed out/);
    const second = assert.rejects(service.prepare('banana'), /timed out/);
    await Promise.all([first, second]);
    assert.equal(children[0].killed, true);
    const retry = service.prepare('apple');
    children[1].reply();
    await retry;
    assert.equal(children[1].killed, false);
  } finally { service.dispose(); }
});

test('Speech limits pending work and evicts the least recently used cached recording', async () => {
  const { service, children } = fixture(undefined, { maxQueue: 2, cacheLimit: 2 });
  try {
    const apple = service.prepare('apple');
    const banana = service.prepare('banana');
    await assert.rejects(service.prepare('cherry'), /Too many/);
    children[0].reply();
    await apple;
    await tick();
    children[0].reply(1);
    await banana;
    await service.prepare('apple');
    const cherry = service.prepare('cherry');
    children[0].reply(2);
    await cherry;
    await service.prepare('apple');
    const bananaAgain = service.prepare('banana');
    assert.equal(children[0].requests.length, 4);
    assert.equal(children[0].requests[3].text, 'banana');
    children[0].reply(3);
    await bananaAgain;
  } finally { service.dispose(); }
});

test('Dispose rejects active and queued synthesis, stops the owned worker and prevents new work', async () => {
  const { service, children } = fixture();
  const first = assert.rejects(service.prepare('apple'), /closed/);
  const queued = assert.rejects(service.prepare('banana'), /closed/);
  service.dispose();
  service.dispose();
  await Promise.all([first, queued]);
  assert.equal(children[0].killed, true);
  await assert.rejects(service.prepare('apple'), /closed/);
  assert.equal(children.length, 1);
});

test('A worker error is reported without caching and a bounded valid error permits the next word', async () => {
  const { service, children } = fixture();
  try {
    const first = assert.rejects(service.prepare('apple'), /generation unavailable/);
    const second = service.prepare('banana');
    children[0].stdout.write(JSON.stringify({ id: '1', error: 'generation unavailable' }) + '\n');
    await first;
    await tick();
    children[0].reply(1);
    await second;
    assert.equal(children[0].killed, false);
    const retry = service.prepare('apple');
    children[0].reply(2);
    await retry;
    assert.equal(children[0].requests.length, 3);
  } finally { service.dispose(); }
});
