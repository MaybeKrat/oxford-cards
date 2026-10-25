import type { SpeechController, SpeechStatus, SpeechTimers } from './speech';

export interface PreparedSpeech {
  audioBase64: string;
  voice: string;
  lang: string;
}

export interface BufferedSpeechController extends SpeechController {
  /** Fetches a complete recording silently, without opening the audio output. */
  prepare: (text: string) => void;
}

export interface BufferedSpeechOptions {
  prepare: (text: string) => Promise<PreparedSpeech>;
  createContext?: () => AudioContext;
  onError?: (message: string) => void;
  onStatus?: (status: SpeechStatus, text: string) => void;
  timers?: SpeechTimers;
  now?: () => number;
}

const DEBOUNCE_MS = 80;
const LEAD_IN_SECONDS = 0.4;
const COLD_AFTER_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CACHE_SIZE = 24;
const MAX_WAV_BYTES = 2 * 1024 * 1024;
const ERROR_MESSAGE = 'Не удалось подготовить или воспроизвести слово. Нажмите кнопку звука ещё раз.';

function remember<T>(cache: Map<string, T>, text: string, value: T) {
  cache.delete(text);
  cache.set(text, value);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return value;
}

function wavBytes(recording: PreparedSpeech): ArrayBuffer {
  const encoded = recording?.audioBase64;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_WAV_BYTES / 3) * 4) {
    throw new Error('Invalid recording size');
  }
  const binary = atob(encoded);
  if (binary.length < 44 || binary.length > MAX_WAV_BYTES
    || binary.slice(0, 4) !== 'RIFF' || binary.slice(8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV recording');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

/** Synthesis finishes before playback; no streaming speech engine touches the output. */
export function createBufferedSpeechController(options: BufferedSpeechOptions): BufferedSpeechController {
  const timers = options.timers ?? {
    set: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const now = options.now ?? Date.now;
  const recordings = new Map<string, Promise<PreparedSpeech>>();
  const decoded = new Map<string, Promise<AudioBuffer>>();
  let context: AudioContext | undefined;
  let disposed = false;
  let lastOutputAt = Number.NEGATIVE_INFINITY;
  interface Request {
    text: string;
    timers: Set<unknown>;
    source?: AudioBufferSourceNode;
    startedAt?: number;
  }
  let active: Request | undefined;
  const isActive = (request: Request) => !disposed && active === request;

  function recording(text: string) {
    const cached = recordings.get(text);
    if (cached) return remember(recordings, text, cached);
    // Promise.resolve also turns a synchronous bridge failure into a handled rejection.
    const pending = Promise.resolve().then(() => options.prepare(text)).then((result) => {
      if (!result || typeof result.audioBase64 !== 'string'
        || result.audioBase64.length > Math.ceil(MAX_WAV_BYTES / 3) * 4) {
        throw new Error('Invalid recording');
      }
      return result;
    });
    remember(recordings, text, pending);
    void pending.catch(() => { if (recordings.get(text) === pending) recordings.delete(text); });
    return pending;
  }

  function audioContext() {
    if (!context || context.state === 'closed') {
      decoded.clear();
      context = options.createContext?.() ?? new AudioContext({ latencyHint: 'playback' });
      lastOutputAt = Number.NEGATIVE_INFINITY;
    }
    return context;
  }

  function audioBuffer(text: string, audio: AudioContext) {
    const cached = decoded.get(text);
    if (cached) return remember(decoded, text, cached);
    const pending = recording(text).then((result) => {
      if (disposed || context !== audio) throw new Error('Audio context was released');
      return audio.decodeAudioData(wavBytes(result));
    }).then((buffer) => {
      if (!buffer.length || !Number.isFinite(buffer.duration) || buffer.duration > 30
        || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) {
        throw new Error('Invalid decoded recording');
      }
      return buffer;
    });
    remember(decoded, text, pending);
    void pending.catch(() => {
      if (decoded.get(text) === pending) decoded.delete(text);
      // A damaged recording must be prepared afresh on the next manual attempt.
      recordings.delete(text);
    });
    return pending;
  }

  function later(request: Request, callback: () => void, delay: number) {
    const handle = timers.set(() => {
      request.timers.delete(handle);
      if (isActive(request)) callback();
    }, delay);
    request.timers.add(handle);
    return handle;
  }

  function clearTimers(request: Request) {
    for (const handle of request.timers) timers.clear(handle);
    request.timers.clear();
  }

  function release(request: Request, completed = false) {
    // Invalidate before stop: an ended callback may be delivered synchronously.
    if (active === request) active = undefined;
    clearTimers(request);
    const source = request.source;
    if (!source) return;
    source.onended = null;
    if (completed || (request.startedAt !== undefined && now() - request.startedAt >= LEAD_IN_SECONDS * 1000)) {
      lastOutputAt = now();
    }
    if (!completed) {
      try { source.stop(); } catch { /* A source can already have ended. */ }
    }
    try { source.disconnect(); } catch { /* Cleanup also handles a failed audio context. */ }
    request.source = undefined;
  }

  function finish(request: Request, error = false) {
    if (!isActive(request)) return;
    release(request, !error);
    options.onStatus?.('idle', '');
    if (error) options.onError?.(ERROR_MESSAGE);
  }

  async function play(request: Request, audio: AudioContext, ready: Promise<void>) {
    try {
      const buffer = await audioBuffer(request.text, audio);
      if (!isActive(request)) return;
      await ready;
      if (!isActive(request)) return;
      // A system suspension can happen while native synthesis is still running.
      if (audio.state !== 'running') {
        lastOutputAt = Number.NEGATIVE_INFINITY;
        await audio.resume();
      }
      if (!isActive(request)) return;
      if (audio.state !== 'running') throw new Error('Audio output is not running');

      let playback = buffer;
      if (now() - lastOutputAt >= COLD_AFTER_MS) {
        const leadFrames = Math.ceil(buffer.sampleRate * LEAD_IN_SECONDS);
        playback = audio.createBuffer(buffer.numberOfChannels, buffer.length + leadFrames, buffer.sampleRate);
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          playback.getChannelData(channel).set(buffer.getChannelData(channel), leadFrames);
        }
      }
      const source = audio.createBufferSource();
      request.source = source;
      source.buffer = playback;
      source.onended = () => finish(request);
      source.connect(audio.destination);
      // Start a complete buffer immediately, including its actual leading zero samples.
      // Merely scheduling speech in the future would leave the output graph idle.
      source.start(0, 0);
      request.startedAt = now();
      clearTimers(request);
      options.onStatus?.('speaking', request.text);
      later(request, () => finish(request, true), Math.ceil(playback.duration * 1000) + 5_000);
    } catch {
      finish(request, true);
    }
  }

  function stop() {
    if (disposed) return;
    if (active) release(active);
    options.onStatus?.('idle', '');
  }

  return {
    prepare(text) {
      const value = text.trim();
      if (!disposed && value) void recording(value).catch(() => { /* Report only on an explicit playback attempt. */ });
    },
    speak(text) {
      if (disposed) return;
      const value = text.trim();
      if (!value) { stop(); return; }
      if (active) release(active);
      const request: Request = { text: value, timers: new Set() };
      active = request;
      options.onStatus?.('loading', value);
      try {
        // Initialize/resume during the user action; prefetch never opens an output.
        const audio = audioContext();
        const wasSuspended = audio.state !== 'running';
        if (wasSuspended) lastOutputAt = Number.NEGATIVE_INFINITY;
        const ready = wasSuspended ? audio.resume() : Promise.resolve();
        void ready.catch(() => finish(request, true));
        later(request, () => { void play(request, audio, ready); }, DEBOUNCE_MS);
        later(request, () => finish(request, true), REQUEST_TIMEOUT_MS);
      } catch {
        finish(request, true);
      }
    },
    stop,
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      recordings.clear();
      decoded.clear();
      if (context && context.state !== 'closed') {
        try { void context.close().catch(() => {}); } catch { /* Closing an unavailable output is best effort. */ }
      }
      context = undefined;
    },
  };
}
