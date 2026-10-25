import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeechController } from '../src/lib/speech.ts';
import type { SpeechControllerOptions, SpeechStatus, SpeechTimers } from '../src/lib/speech.ts';

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

function voice(name: string, lang = 'en-GB', localService = true): SpeechSynthesisVoice {
  return { name, lang, localService, default: false, voiceURI: name };
}

function fixture(initialVoices = [voice('English')], failInitialDiscovery = false) {
  const clock = new Clock();
  let voices = initialVoices;
  const spoken: SpeechSynthesisUtterance[] = [];
  const statuses: [SpeechStatus, string][] = [];
  const errors: string[] = [];
  const listeners = new Set<() => void>();
  const engine = {
    paused: false,
    speaking: false,
    pending: false,
    cancels: 0,
    resumes: 0,
    voiceReads: 0,
    onCancel: undefined as (() => void) | undefined,
    getVoices: () => {
      engine.voiceReads++;
      if (failInitialDiscovery && engine.voiceReads === 1) throw new Error('Engine not ready');
      return voices;
    },
    speak: (utterance: SpeechSynthesisUtterance) => { engine.pending = true; spoken.push(utterance); },
    cancel: () => { engine.cancels++; engine.speaking = false; engine.pending = false; engine.onCancel?.(); },
    resume: () => { engine.resumes++; engine.paused = false; },
    addEventListener: (_name: string, callback: () => void) => { listeners.add(callback); },
    removeEventListener: (_name: string, callback: () => void) => { listeners.delete(callback); },
  };
  const controller = createSpeechController({
    synthesis: engine as unknown as SpeechControllerOptions['synthesis'],
    createUtterance: (text) => ({ text, onstart: null, onend: null, onerror: null, onboundary: null }) as unknown as SpeechSynthesisUtterance,
    onError: (message) => { errors.push(message); },
    onStatus: (status, text) => { statuses.push([status, text]); },
    timers: clock,
  });
  const event = (utterance: SpeechSynthesisUtterance, name: 'start' | 'end' | 'boundary') => {
    engine.pending = false;
    if (name === 'start' || name === 'boundary') engine.speaking = true;
    if (name === 'end') engine.speaking = false;
    utterance[`on${name}`]?.call(utterance, {} as SpeechSynthesisEvent);
  };
  return {
    controller, clock, engine, spoken, statuses, errors, listeners, event,
    setVoices(next: SpeechSynthesisVoice[], notify = true) {
      voices = next;
      if (notify) for (const listener of [...listeners]) listener();
    },
  };
}

test('starts voice discovery on creation without cancelling an idle engine', () => {
  const f = fixture();
  assert.equal(f.engine.voiceReads, 1);
  assert.equal(f.engine.cancels, 0);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.statuses, []);
});

test('a failed initial voice discovery stays quiet and does not prevent first use', () => {
  const f = fixture([voice('English')], true);
  assert.equal(f.engine.voiceReads, 1);
  assert.deepEqual(f.errors, []);
  f.controller.speak('apple');
  f.clock.advance(120);
  assert.equal(f.spoken.length, 1);
  assert.deepEqual(f.errors, []);
});

test('idle first playback and a new playback after completion never purge the native engine', () => {
  const f = fixture();
  f.controller.stop();
  f.controller.speak('apple');
  f.clock.advance(120);
  assert.equal(f.engine.cancels, 0);
  f.event(f.spoken[0], 'start');
  f.event(f.spoken[0], 'end');
  f.controller.stop();
  f.controller.speak('book');
  f.clock.advance(120);
  assert.equal(f.engine.cancels, 0);
  f.event(f.spoken[1], 'end');
  f.controller.dispose();
  assert.equal(f.engine.cancels, 0);
});

test('replacing an utterance cancels the owned queue even when native busy flags are stale', () => {
  const f = fixture();
  f.controller.speak('apple');
  f.clock.advance(120);
  f.engine.pending = false;
  f.controller.speak('book');
  assert.equal(f.engine.cancels, 1);
  f.clock.advance(120);
  f.engine.pending = false;
  f.controller.stop();
  assert.equal(f.engine.cancels, 2);
});

test('native queued or speaking audio is cancelled even without an owned utterance', () => {
  const f = fixture();
  f.engine.pending = true;
  f.controller.speak('apple');
  assert.equal(f.engine.cancels, 1);
  f.controller.stop();
  assert.equal(f.engine.cancels, 1, 'stopping the debounce does not purge an idle engine');
  f.engine.speaking = true;
  f.controller.stop();
  assert.equal(f.engine.cancels, 2);
});

test('rapid pronunciation clicks queue only the latest complete word after cancellation settles', () => {
  const f = fixture();
  f.controller.speak('apple');
  f.clock.advance(70);
  f.controller.speak('book');
  f.clock.advance(70);
  f.controller.speak('courage');
  f.clock.advance(119);
  assert.equal(f.spoken.length, 0);
  f.clock.advance(1);
  assert.deepEqual(f.spoken.map((u) => u.text), ['courage']);
  assert.equal(f.engine.cancels, 0, 'requests replaced before enqueueing do not reset the engine');
  assert.deepEqual(f.statuses.at(-1), ['loading', 'courage']);
  f.event(f.spoken[0], 'start');
  assert.deepEqual(f.statuses.at(-1), ['speaking', 'courage']);
  f.event(f.spoken[0], 'end');
  assert.deepEqual(f.statuses.at(-1), ['idle', '']);
  assert.equal(f.clock.jobs.size, 0);
  assert.equal(f.spoken[0].onstart, null);
});

test('cancel errors and late callbacks from an old utterance cannot affect the next request', () => {
  const f = fixture();
  f.controller.speak('apple');
  f.clock.advance(120);
  const old = f.spoken[0];
  const oldError = old.onerror;
  const oldStart = old.onstart;
  const oldEnd = old.onend;
  f.engine.onCancel = () => oldError?.call(old, { error: 'interrupted' } as SpeechSynthesisErrorEvent);
  f.controller.speak('book');
  assert.equal(old.onerror, null);
  f.clock.advance(120);
  f.event(f.spoken[1], 'start');
  oldStart?.call(old, {} as SpeechSynthesisEvent);
  oldEnd?.call(old, {} as SpeechSynthesisEvent);
  oldError?.call(old, { error: 'canceled' } as SpeechSynthesisErrorEvent);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.statuses.at(-1), ['speaking', 'book']);
  f.event(f.spoken[1], 'end');
  assert.equal(f.clock.jobs.size, 0);
});

test('waits for English voice availability and consistently prefers local British English', () => {
  const f = fixture([]);
  f.controller.speak('apple');
  f.clock.advance(120);
  assert.equal(f.listeners.size, 1);
  f.clock.advance(400);
  f.setVoices([voice('Russian', 'ru-RU')]);
  assert.equal(f.spoken.length, 0);
  f.setVoices([voice('Remote British', 'en-GB', false), voice('Local American', 'en-US'), voice('Local British', 'EN_gb')]);
  assert.equal(f.spoken[0].voice?.name, 'Local British');
  assert.equal(f.spoken[0].lang, 'EN-gb');
  assert.equal(f.listeners.size, 0);
  f.event(f.spoken[0], 'end');
  assert.equal(f.clock.jobs.size, 0);
});

test('prefers local English over a remote British voice and remains stable when voice order changes', () => {
  const choices = [voice('Remote', 'en-GB', false), voice('Zeta', 'en-US'), voice('Alpha', 'en-AU')];
  const f = fixture(choices);
  f.controller.speak('apple');
  f.clock.advance(120);
  assert.equal(f.spoken[0].voice?.name, 'Alpha');
  f.setVoices([...choices].reverse());
  f.controller.speak('book');
  f.clock.advance(120);
  assert.equal(f.spoken[1].voice?.name, 'Alpha');
});

test('stop while waiting for voices prevents delayed playback and removes all pending work', () => {
  const f = fixture([]);
  f.controller.speak('apple');
  f.clock.advance(120);
  const staleListener = [...f.listeners][0];
  f.controller.stop();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.clock.jobs.size, 0);
  assert.equal(f.engine.cancels, 0, 'waiting for voices has not queued any audio');
  f.setVoices([voice('English')]);
  staleListener();
  f.clock.advance(20_000);
  assert.equal(f.spoken.length, 0);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.statuses.at(-1), ['idle', '']);
});

test('an unavailable voice gives a bounded error without falling back to Russian; manual retry succeeds', () => {
  for (const voices of [[], [voice('Russian', 'ru-RU')]]) {
    const f = fixture(voices);
    f.controller.speak('apple');
    f.clock.advance(1_120);
    assert.equal(f.spoken.length, 0);
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0], /Английский голос/);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.clock.jobs.size, 0);
    f.setVoices([voice('English')]);
    f.controller.speak('apple');
    f.clock.advance(120);
    assert.equal(f.spoken.length, 1);
  }
});

test('voice readiness is checked at the deadline even if voiceschanged is missing', () => {
  const f = fixture([]);
  f.controller.speak('apple');
  f.clock.advance(120);
  f.setVoices([voice('English')], false);
  f.clock.advance(1_000);
  assert.equal(f.spoken.length, 1);
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.errors, []);
});

test('resumes a previously paused engine before playback, without pause/resume during pronunciation', () => {
  const f = fixture();
  f.engine.paused = true;
  f.controller.speak('apple');
  f.clock.advance(120);
  assert.equal(f.engine.resumes, 1);
  assert.equal(f.engine.paused, false);
  f.event(f.spoken[0], 'start');
  f.clock.advance(4_000);
  assert.equal(f.engine.resumes, 1);
  f.event(f.spoken[0], 'end');
});

test('a silent start timeout retries only once, with a fresh utterance from the beginning', () => {
  const f = fixture();
  f.controller.speak('apple');
  f.clock.advance(120);
  const first = f.spoken[0];
  const lateStart = first.onstart;
  f.clock.advance(5_000);
  assert.equal(first.onstart, null);
  f.clock.advance(120);
  assert.equal(f.spoken.length, 2);
  assert.notEqual(f.spoken[1], first);
  assert.equal(f.spoken[1].text, 'apple');
  lateStart?.call(first, {} as SpeechSynthesisEvent);
  assert.deepEqual(f.statuses.at(-1), ['loading', 'apple']);
  f.clock.advance(5_000);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.statuses.at(-1), ['idle', '']);
  f.clock.advance(60_000);
  assert.equal(f.spoken.length, 2);
  assert.equal(f.clock.jobs.size, 0);
});

test('does not replay audio when the engine is speaking but never emitted start', () => {
  const f = fixture();
  f.controller.speak('apple');
  f.clock.advance(120);
  f.engine.speaking = true;
  f.clock.advance(5_000);
  assert.equal(f.spoken.length, 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.engine.speaking, false);
});

test('a word boundary proves playback began; a later hang is stopped without replay', () => {
  const f = fixture();
  f.controller.speak('apple');
  f.clock.advance(120);
  f.event(f.spoken[0], 'boundary');
  f.clock.advance(10_000);
  assert.equal(f.spoken.length, 1);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /зависло/);
  assert.equal(f.clock.jobs.size, 0);
  f.controller.speak('apple');
  f.clock.advance(120);
  assert.equal(f.spoken.length, 2, 'manual retry remains available');
});

test('a real synthesis error clears playback state and does not start an automatic retry', () => {
  const f = fixture();
  f.controller.speak('apple');
  f.clock.advance(120);
  const utterance = f.spoken[0];
  utterance.onerror?.call(utterance, { error: 'audio-hardware' } as SpeechSynthesisErrorEvent);
  assert.match(f.errors[0], /устройство вывода/);
  assert.deepEqual(f.statuses.at(-1), ['idle', '']);
  assert.equal(f.clock.jobs.size, 0);
  f.clock.advance(30_000);
  assert.equal(f.spoken.length, 1);
});

test('dispose cleans up pending and active requests, and permanently ignores further calls', () => {
  for (const advance of [0, 120]) {
    const f = fixture();
    f.controller.speak('apple');
    f.clock.advance(advance);
    const utterance = f.spoken[0];
    f.controller.dispose();
    const count = f.spoken.length;
    const cancels = f.engine.cancels;
    f.controller.dispose();
    f.controller.speak('book');
    f.controller.stop();
    f.clock.advance(30_000);
    assert.equal(f.spoken.length, count);
    assert.equal(f.engine.cancels, cancels);
    assert.equal(f.clock.jobs.size, 0);
    assert.equal(f.listeners.size, 0);
    if (utterance) assert.equal(utterance.onerror, null);
    assert.deepEqual(f.errors, []);
  }
});
