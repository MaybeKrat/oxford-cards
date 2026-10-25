export type SpeechStatus = 'idle' | 'loading' | 'speaking';

type Synthesis = Pick<SpeechSynthesis, 'getVoices' | 'speak' | 'cancel' | 'resume' | 'paused' | 'speaking' | 'pending' | 'addEventListener' | 'removeEventListener'>;

export interface SpeechTimers {
  set: (callback: () => void, delay: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface SpeechControllerOptions {
  synthesis: Synthesis;
  createUtterance: (text: string) => SpeechSynthesisUtterance;
  onError: (message: string) => void;
  onStatus?: (status: SpeechStatus, text: string) => void;
  timers?: SpeechTimers;
}

export interface SpeechController {
  speak: (text: string) => void;
  stop: () => void;
  dispose: () => void;
}

const RESET_DELAY = 120;
const VOICES_TIMEOUT = 1_000;
const START_TIMEOUT = 5_000;
const SPEAKING_TIMEOUT = 10_000;

function englishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const language = (voice: SpeechSynthesisVoice) => voice.lang.trim().replaceAll('_', '-').toLowerCase();
  const rank = (voice: SpeechSynthesisVoice) => (voice.localService ? 0 : 2) + (language(voice) === 'en-gb' ? 0 : 1);
  return voices
    .filter((voice) => language(voice) === 'en' || language(voice).startsWith('en-'))
    .sort((a, b) => rank(a) - rank(b) || Number(b.default) - Number(a.default)
      || a.voiceURI.localeCompare(b.voiceURI) || a.name.localeCompare(b.name))[0];
}

function speechError(error: string): string {
  if (error === 'voice-unavailable' || error === 'language-unavailable') {
    return 'Английский голос недоступен. Проверьте английские голоса в настройках речи Windows.';
  }
  if (error === 'not-allowed') return 'Озвучивание заблокировано. Нажмите кнопку звука ещё раз.';
  if (error === 'audio-busy' || error === 'audio-hardware') {
    return 'Не удалось включить звук. Проверьте устройство вывода и нажмите кнопку звука ещё раз.';
  }
  return 'Не удалось озвучить слово. Нажмите кнопку звука ещё раз.';
}

/** One owned utterance at a time; cancelled requests can never restart playback. */
export function createSpeechController(options: SpeechControllerOptions): SpeechController {
  const { synthesis, createUtterance, onError, onStatus } = options;
  const timers = options.timers ?? {
    set: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  interface Request {
    text: string;
    utterance?: SpeechSynthesisUtterance;
    queued: boolean;
    started: boolean;
    retried: boolean;
    timers: Set<unknown>;
    voicesListener?: () => void;
  }
  let active: Request | undefined;
  let disposed = false;

  // Reading voices starts asynchronous discovery before the first pronunciation.
  // An unavailable engine is reported only if the user actually requests speech.
  try { synthesis.getVoices(); } catch { /* First use can retry initialization. */ }

  const isActive = (request: Request) => !disposed && active === request;

  function later(request: Request, callback: () => void, delay: number): unknown {
    const handle = timers.set(() => {
      request.timers.delete(handle);
      if (isActive(request)) callback();
    }, delay);
    request.timers.add(handle);
    return handle;
  }

  function clearTimer(request: Request, handle: unknown) {
    timers.clear(handle);
    request.timers.delete(handle);
  }

  function detachUtterance(request: Request) {
    request.queued = false;
    if (!request.utterance) return;
    request.utterance.onstart = null;
    request.utterance.onend = null;
    request.utterance.onerror = null;
    request.utterance.onboundary = null;
    request.utterance = undefined;
  }

  function removeVoicesListener(request: Request) {
    if (!request.voicesListener) return;
    synthesis.removeEventListener('voiceschanged', request.voicesListener);
    request.voicesListener = undefined;
  }

  function release(request: Request) {
    // Invalidate before cancel(): some engines emit cancellation events synchronously.
    if (active === request) active = undefined;
    for (const handle of request.timers) timers.clear(handle);
    request.timers.clear();
    removeVoicesListener(request);
    detachUtterance(request);
  }

  function cancelIfBusy(owned: boolean) {
    if (owned || synthesis.speaking || synthesis.pending) synthesis.cancel();
  }

  function cancelQuietly(owned: boolean) {
    try { cancelIfBusy(owned); } catch { /* Cleanup must also work if the audio engine has failed. */ }
  }

  function finish(request: Request, error?: string) {
    if (!isActive(request)) return;
    const queued = request.queued;
    release(request);
    if (error) cancelQuietly(queued);
    onStatus?.('idle', '');
    if (error) onError(error);
  }

  function start(request: Request, voice: SpeechSynthesisVoice) {
    if (!isActive(request)) return;
    try {
      const utterance = createUtterance(request.text);
      // Keep a strong reference for the entire playback, including native callbacks.
      request.utterance = utterance;
      request.started = false;
      utterance.voice = voice;
      utterance.lang = voice.lang.replaceAll('_', '-');
      utterance.rate = 0.85;
      utterance.pitch = 1;
      utterance.volume = 1;
      const isCurrent = () => isActive(request) && request.utterance === utterance;
      const startTimer = later(request, () => {
        if (!isCurrent() || request.started) return;
        // A missing start event does not prove that the user heard nothing.
        if (!request.retried && !synthesis.speaking) {
          request.retried = true;
          const queued = request.queued;
          detachUtterance(request);
          try {
            cancelIfBusy(queued);
            later(request, () => loadVoice(request), RESET_DELAY);
          } catch {
            finish(request, 'Не удалось перезапустить озвучивание. Нажмите кнопку звука ещё раз.');
          }
        } else {
          finish(request, 'Озвучивание не запустилось. Нажмите кнопку звука ещё раз.');
        }
      }, START_TIMEOUT);
      const markStarted = () => {
        if (!isCurrent() || request.started) return;
        request.started = true;
        clearTimer(request, startTimer);
        onStatus?.('speaking', request.text);
        later(request, () => finish(request, 'Озвучивание зависло и было остановлено. Нажмите кнопку звука ещё раз.'),
          Math.max(SPEAKING_TIMEOUT, Math.min(60_000, request.text.length * 120)));
      };
      utterance.onstart = markStarted;
      utterance.onboundary = markStarted;
      utterance.onend = () => { if (isCurrent()) finish(request); };
      utterance.onerror = (event) => { if (isCurrent()) finish(request, speechError(event.error)); };
      // cancel() does not clear the paused state; resume only before new playback.
      if (synthesis.paused) synthesis.resume();
      request.queued = true;
      synthesis.speak(utterance);
    } catch {
      finish(request, 'Не удалось запустить озвучивание. Нажмите кнопку звука ещё раз.');
    }
  }

  function loadVoice(request: Request) {
    if (!isActive(request)) return;
    try {
      const voice = englishVoice(synthesis.getVoices());
      if (voice) {
        start(request, voice);
        return;
      }
      const voicesTimer = later(request, () => {
        removeVoicesListener(request);
        try {
          const voices = synthesis.getVoices();
          const readyVoice = englishVoice(voices);
          if (readyVoice) start(request, readyVoice);
          else finish(request, voices.length
            ? 'Английский голос не найден. Добавьте английский голос в настройках речи Windows.'
            : 'Английский голос ещё не готов. Нажмите кнопку звука ещё раз.');
        } catch {
          finish(request, 'Не удалось загрузить английский голос. Нажмите кнопку звука ещё раз.');
        }
      }, VOICES_TIMEOUT);
      request.voicesListener = () => {
        if (!isActive(request)) return;
        try {
          const readyVoice = englishVoice(synthesis.getVoices());
          if (!readyVoice) return;
          removeVoicesListener(request);
          clearTimer(request, voicesTimer);
          start(request, readyVoice);
        } catch {
          finish(request, 'Не удалось загрузить английский голос. Нажмите кнопку звука ещё раз.');
        }
      };
      synthesis.addEventListener('voiceschanged', request.voicesListener);
    } catch {
      finish(request, 'Не удалось загрузить английский голос. Нажмите кнопку звука ещё раз.');
    }
  }

  function stop() {
    if (disposed) return;
    const queued = active?.queued ?? false;
    if (active) release(active);
    cancelQuietly(queued);
    onStatus?.('idle', '');
  }

  return {
    speak(text) {
      if (disposed) return;
      if (!text.trim()) { stop(); return; }
      const queued = active?.queued ?? false;
      if (active) release(active);
      const request: Request = { text: text.trim(), queued: false, started: false, retried: false, timers: new Set() };
      active = request;
      onStatus?.('loading', request.text);
      try {
        cancelIfBusy(queued);
        // Debounce rapid requests, and let any cancellation reach the native engine.
        later(request, () => loadVoice(request), RESET_DELAY);
      } catch {
        finish(request, 'Не удалось подготовить озвучивание. Нажмите кнопку звука ещё раз.');
      }
    },
    stop,
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
    },
  };
}
