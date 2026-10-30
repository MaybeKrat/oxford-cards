import assert from 'node:assert/strict';
import test from 'node:test';
import { createBufferedSpeechController } from '../src/lib/buffered-speech.ts';
import type { PreparedSpeech } from '../src/lib/buffered-speech.ts';
import type { SpeechStatus, SpeechTimers } from '../src/lib/speech.ts';

class Clock implements SpeechTimers {
  now = 0;
  nextId = 0;
  jobs = new Map<number, { at: number; callback: () => void }>();
  set = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.jobs.set(id, { at: this.now + delay, callback });
    return id;
  };
  clear = (handle: unknown) => { this.jobs.delete(handle as number); };
  advance(ms: number) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.jobs.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 15; index++) await Promise.resolve();
}

function buffer(length = 10, channels = 1, sampleRate = 10): AudioBuffer {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return { length, numberOfChannels: channels, sampleRate, duration: length / sampleRate,
    getChannelData: (channel: number) => data[channel] } as AudioBuffer;
}

const wav: PreparedSpeech = {
  audioBase64: Buffer.from(`RIFF${'\0'.repeat(4)}WAVE${'\0'.repeat(32)}`, 'binary').toString('base64'),
  voice: 'English voice', lang: 'en-US',
};

class Source {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  starts: number[][] = [];
  stops = 0;
  connections = 0;
  disconnections = 0;
  start = (...values: number[]) => { this.starts.push(values); };
  stop = () => { this.stops++; };
  connect = () => { this.connections++; };
  disconnect = () => { this.disconnections++; };
  end = () => { this.onended?.(); };
}

function fixture(load?: (text: string) => Promise<ArrayBuffer | null>) {
  const clock = new Clock();
  const statuses: [SpeechStatus, string][] = [];
  const errors: string[] = [];
  const words: string[] = [];
  const sources: Source[] = [];
  const original = buffer();
  original.getChannelData(0).set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  let prepare = async (_text: string): Promise<PreparedSpeech> => wav;
  let decode = async (_bytes: ArrayBuffer): Promise<AudioBuffer> => original;
  let resume = async () => { context.state = 'running'; };
  const context = {
    state: 'suspended',
    destination: {},
    creates: 0,
    resumes: 0,
    closes: 0,
    decodes: [] as ArrayBuffer[],
    resume: () => { context.resumes++; return resume(); },
    close: async () => { context.closes++; context.state = 'closed'; },
    decodeAudioData: (bytes: ArrayBuffer) => { context.decodes.push(bytes); return decode(bytes); },
    createBuffer: (channels: number, length: number, rate: number) => buffer(length, channels, rate),
    createBufferSource: () => {
      const source = new Source();
      sources.push(source);
      return source;
    },
  };
  const controller = createBufferedSpeechController({
    load,
    prepare: (text) => { words.push(text); return prepare(text); },
    createContext: () => { context.creates++; return context as unknown as AudioContext; },
    onError: (message) => { errors.push(message); },
    onStatus: (status, text) => { statuses.push([status, text]); },
    timers: clock,
    now: () => clock.now,
  });
  return { controller, clock, statuses, errors, words, sources, original, context,
    setPrepare: (fn: typeof prepare) => { prepare = fn; },
    setDecode: (fn: typeof decode) => { decode = fn; },
    setResume: (fn: typeof resume) => { resume = fn; },
    async speak(text = 'apple') { controller.speak(text); clock.advance(80); await flush(); },
  };
}

test('prefetch is deduplicated, silent, and reused by the first explicit playback', async () => {
  const f = fixture();
  f.controller.prepare(' apple ');
  f.controller.prepare('apple');
  await flush();
  assert.deepEqual(f.words, ['apple']);
  assert.equal(f.context.creates, 0);
  assert.equal(f.context.decodes.length, 0);
  assert.deepEqual(f.statuses, []);
  await f.speak();
  assert.deepEqual(f.words, ['apple']);
  assert.equal(f.sources.length, 1);
  f.controller.dispose();
});

test('cold playback waits for the complete recording and decoding, then includes real leading silence', async () => {
  const f = fixture();
  const recording = deferred<PreparedSpeech>();
  const decoding = deferred<AudioBuffer>();
  f.setPrepare(() => recording.promise);
  f.setDecode(() => decoding.promise);
  await f.speak();
  assert.equal(f.context.resumes, 1);
  assert.equal(f.context.decodes.length, 0);
  assert.equal(f.sources.length, 0);
  assert.deepEqual(f.statuses.at(-1), ['loading', 'apple']);
  recording.resolve(wav);
  await flush();
  assert.equal(f.context.decodes[0].byteLength, 44);
  assert.equal(f.sources.length, 0);
  decoding.resolve(f.original);
  await flush();
  const source = f.sources[0];
  assert.deepEqual(source.starts, [[0, 0]]);
  assert.deepEqual(Array.from(source.buffer!.getChannelData(0)), [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(Array.from(f.original.getChannelData(0)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'cached speech is not mutated');
  assert.deepEqual(f.statuses.at(-1), ['speaking', 'apple']);
  source.end();
  assert.deepEqual(f.statuses.at(-1), ['idle', '']);
  assert.equal(source.disconnections, 1);
  assert.equal(f.clock.jobs.size, 0);
  f.controller.dispose();
});

test('warm replay uses the same complete recording and context with a fresh source starting at zero', async () => {
  const f = fixture();
  await f.speak();
  f.sources[0].end();
  await f.speak();
  assert.equal(f.context.creates, 1);
  assert.equal(f.context.decodes.length, 1);
  assert.deepEqual(f.words, ['apple']);
  assert.notEqual(f.sources[0], f.sources[1]);
  assert.equal(f.sources[1].buffer, f.original);
  assert.deepEqual(f.sources[1].starts, [[0, 0]]);
  f.controller.dispose();
});

test('first playback after idle includes the full lead-in again', async () => {
  const f = fixture();
  await f.speak();
  f.sources[0].end();
  f.clock.advance(3_000);
  await f.speak();
  assert.equal(f.sources[1].buffer!.length, 14);
  assert.equal(f.context.decodes.length, 1);
  f.controller.dispose();
});

test('rapid clicks debounce to the latest whole word', async () => {
  const f = fixture();
  f.controller.speak('apple');
  f.clock.advance(50);
  f.controller.speak('book');
  f.clock.advance(50);
  f.controller.speak('courage');
  f.clock.advance(79);
  await flush();
  assert.deepEqual(f.words, []);
  f.clock.advance(1);
  await flush();
  assert.deepEqual(f.words, ['courage']);
  assert.equal(f.sources.length, 1);
  assert.deepEqual(f.statuses.at(-1), ['speaking', 'courage']);
  f.controller.dispose();
});

test('a cancelled native preparation cannot interrupt or start over a newer word', async () => {
  const f = fixture();
  const old = deferred<PreparedSpeech>();
  f.setPrepare((text) => text === 'apple' ? old.promise : Promise.resolve(wav));
  await f.speak('apple');
  await f.speak('book');
  assert.equal(f.sources.length, 1);
  old.resolve(wav);
  await flush();
  assert.equal(f.sources.length, 1);
  assert.deepEqual(f.statuses.at(-1), ['speaking', 'book']);
  assert.deepEqual(f.errors, []);
  f.controller.dispose();
});

test('stop during decoding prevents playback and ignores late completion', async () => {
  const f = fixture();
  const decoding = deferred<AudioBuffer>();
  f.setDecode(() => decoding.promise);
  await f.speak();
  f.controller.stop();
  decoding.resolve(f.original);
  await flush();
  assert.equal(f.sources.length, 0);
  assert.equal(f.clock.jobs.size, 0);
  assert.deepEqual(f.statuses.at(-1), ['idle', '']);
  f.controller.dispose();
});

test('replacing active playback stops only its owned source and ignores a late ended event', async () => {
  const f = fixture();
  await f.speak();
  const old = f.sources[0];
  const staleEnded = old.onended!;
  await f.speak('book');
  assert.equal(old.stops, 1);
  assert.equal(old.disconnections, 1);
  assert.equal(old.onended, null);
  staleEnded();
  assert.deepEqual(f.statuses.at(-1), ['speaking', 'book']);
  assert.equal(f.sources[1].stops, 0);
  f.controller.stop();
  assert.equal(f.sources[1].stops, 1);
  assert.equal(f.clock.jobs.size, 0);
  f.controller.dispose();
});

test('suspended output must resume before any buffer starts', async () => {
  const f = fixture();
  const resumed = deferred<void>();
  f.setResume(() => resumed.promise);
  await f.speak();
  assert.equal(f.context.decodes.length, 1);
  assert.equal(f.sources.length, 0);
  f.context.state = 'running';
  resumed.resolve();
  await flush();
  assert.equal(f.sources.length, 1);
  f.controller.dispose();
});

test('output suspended while synthesis is pending is resumed and receives a new lead-in', async () => {
  const f = fixture();
  await f.speak();
  f.sources[0].end();
  const recording = deferred<PreparedSpeech>();
  f.setPrepare(() => recording.promise);
  await f.speak('book');
  f.context.state = 'suspended';
  recording.resolve(wav);
  await flush();
  assert.equal(f.context.resumes, 2);
  assert.equal(f.sources[1].buffer!.length, 14);
  f.controller.dispose();
});

test('a failed preparation is quiet during prefetch and manual playback retries it', async () => {
  const f = fixture();
  f.setPrepare(async () => { throw new Error('Native synthesis failed'); });
  f.controller.prepare('apple');
  await flush();
  assert.deepEqual(f.errors, []);
  await f.speak();
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.statuses.at(-1), ['idle', '']);
  assert.equal(f.clock.jobs.size, 0);
  f.setPrepare(async () => wav);
  await f.speak();
  assert.equal(f.sources.length, 1);
  assert.equal(f.words.length, 3);
  f.controller.dispose();
});

test('a decoding failure clears the damaged recording and does not automatically replay', async () => {
  const f = fixture();
  f.setDecode(async () => { throw new Error('Invalid audio'); });
  await f.speak();
  assert.equal(f.errors.length, 1);
  assert.equal(f.sources.length, 0);
  f.clock.advance(40_000);
  await flush();
  assert.equal(f.words.length, 1);
  f.setDecode(async () => f.original);
  await f.speak();
  assert.equal(f.words.length, 2);
  assert.equal(f.sources.length, 1);
  f.controller.dispose();
});

test('failed resume surfaces an error without starting or leaving pending work', async () => {
  const f = fixture();
  f.setResume(async () => { throw new Error('No output device'); });
  await f.speak();
  assert.equal(f.errors.length, 1);
  assert.equal(f.sources.length, 0);
  assert.equal(f.clock.jobs.size, 0);
  f.controller.dispose();
});

test('a hung request times out and cannot start if its recording eventually arrives', async () => {
  const f = fixture();
  const recording = deferred<PreparedSpeech>();
  f.setPrepare(() => recording.promise);
  await f.speak();
  f.clock.advance(30_000);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.statuses.at(-1), ['idle', '']);
  assert.equal(f.clock.jobs.size, 0);
  recording.resolve(wav);
  await flush();
  assert.equal(f.sources.length, 0);
  f.controller.dispose();
});

test('a missing ended event stops playback at a bounded deadline without replaying', async () => {
  const f = fixture();
  await f.speak();
  f.clock.advance(6_400);
  assert.equal(f.errors.length, 1);
  assert.equal(f.sources[0].stops, 1);
  assert.equal(f.clock.jobs.size, 0);
  assert.deepEqual(f.statuses.at(-1), ['idle', '']);
  f.controller.dispose();
});

test('dispose cancels active playback, closes output once, and ignores further calls', async () => {
  const f = fixture();
  await f.speak();
  f.controller.dispose();
  f.controller.dispose();
  f.controller.speak('book');
  f.controller.prepare('book');
  f.controller.stop();
  f.clock.advance(40_000);
  await flush();
  assert.equal(f.context.closes, 1);
  assert.equal(f.sources[0].stops, 1);
  assert.equal(f.sources.length, 1);
  assert.equal(f.clock.jobs.size, 0);
  assert.deepEqual(f.words, ['apple']);
  assert.deepEqual(f.errors, []);
});

test('dispose during native preparation prevents decoding into a closed context', async () => {
  const f = fixture();
  const recording = deferred<PreparedSpeech>();
  f.setPrepare(() => recording.promise);
  await f.speak();
  f.controller.dispose();
  recording.resolve(wav);
  await flush();
  assert.equal(f.context.decodes.length, 0);
  assert.equal(f.sources.length, 0);
  assert.equal(f.context.closes, 1);
  assert.deepEqual(f.errors, []);
});

test('recording and decoded caches are bounded; eviction prepares the old word afresh', async () => {
  const f = fixture();
  for (let index = 0; index < 25; index++) {
    await f.speak(`word${index}`);
    f.sources.at(-1)!.end();
  }
  await f.speak('word0');
  assert.equal(f.words.filter((word) => word === 'word0').length, 2);
  assert.equal(f.context.decodes.length, 26);
  assert.equal(f.context.creates, 1);
  f.controller.dispose();
});

test('a malformed or oversized recording never reaches the decoder or output', async () => {
  for (const encoded of ['invalid', 'A'.repeat(3_000_000)]) {
    const f = fixture();
    f.setPrepare(async () => ({ ...wav, audioBase64: encoded }));
    await f.speak();
    assert.equal(f.errors.length, 1);
    assert.equal(f.context.decodes.length, 0);
    assert.equal(f.sources.length, 0);
    f.controller.dispose();
  }
});

test('bundled recordings play without synthesis; words without one fall back to the system voice', async () => {
  const recorded = new Uint8Array([1, 2, 3]).buffer;
  const f = fixture(async (text) => (text === 'apple' ? recorded : null));
  await f.speak('apple');
  assert.deepEqual(f.words, []);
  assert.deepEqual([...new Uint8Array(f.context.decodes[0])], [1, 2, 3]);
  await f.speak('spice');
  assert.deepEqual(f.words, ['spice']);
  assert.deepEqual(f.errors, []);
  f.controller.dispose();
});
