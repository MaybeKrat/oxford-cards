const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_CHARS = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4096;

function validateAudioResponse(message, expectedId) {
  if (!message || typeof message !== 'object' || message.id !== expectedId) {
    throw new Error('Invalid response from the speech worker.');
  }
  if (typeof message.error === 'string' && message.error.length <= 1000) {
    return { error: new Error(message.error || 'Speech generation failed.') };
  }
  if (
    typeof message.audioBase64 !== 'string' ||
    message.audioBase64.length > MAX_RESPONSE_CHARS - 4096 ||
    message.audioBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(message.audioBase64) ||
    typeof message.voice !== 'string' || !message.voice.length || message.voice.length > 200 ||
    typeof message.lang !== 'string' || !/^en(?:-[A-Za-z0-9]{2,8})*$/.test(message.lang)
  ) {
    throw new Error('Invalid audio from the speech worker.');
  }
  const audio = Buffer.from(message.audioBase64, 'base64');
  if (
    audio.length < 44 || audio.length > MAX_AUDIO_BYTES ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 12) !== 'WAVE' ||
    audio.readUInt32LE(4) !== audio.length - 8
  ) {
    throw new Error('The speech worker returned an incomplete WAV file.');
  }
  let hasFormat = false;
  let hasAudio = false;
  let offset = 12;
  while (offset + 8 <= audio.length) {
    const kind = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > audio.length) throw new Error('The speech worker returned a truncated WAV chunk.');
    if (kind === 'fmt ') {
      if (size < 16 || audio.readUInt16LE(offset + 8) !== 1) {
        throw new Error('The speech worker returned unsupported WAV audio.');
      }
      hasFormat = true;
    }
    if (kind === 'data' && size > 0) hasAudio = true;
    offset = end + (size % 2);
  }
  if (!hasFormat || !hasAudio || offset !== audio.length) {
    throw new Error('The speech worker returned an empty or malformed WAV file.');
  }
  return {
    value: Object.freeze({
      audioBase64: message.audioBase64,
      voice: message.voice,
      lang: message.lang,
    }),
  };
}

// Dependencies are injectable only from main-process tests; the renderer gets prepare(text).
function createNativeSpeechService({ workerPath, allowedTexts, cacheDir }, dependencies = {}) {
  if (typeof workerPath !== 'string' || !(allowedTexts instanceof Set)) {
    throw new TypeError('A speech worker path and vocabulary allowlist are required.');
  }
  const vocabulary = new Set(allowedTexts);
  const spawnProcess = dependencies.spawnProcess || spawn;
  const timeoutMs = dependencies.timeoutMs || 20000;
  const maxQueue = dependencies.maxQueue || 16;
  const cacheLimit = dependencies.cacheLimit || 64;
  // Audio is cached only in memory. No study profile or user files are touched.
  void cacheDir;
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let worker = null;
  let active = null;
  let nextId = 0;
  let disposed = false;
  let encodedSource;

  function clearJob(job) {
    clearTimeout(job.timer);
    pending.delete(job.text);
  }

  function failWorker(child, error) {
    if (child && child !== worker) return;
    const owned = worker;
    worker = null;
    if (active) {
      clearJob(active);
      active.reject(error);
      active = null;
    }
    for (const job of queue.splice(0)) {
      clearJob(job);
      job.reject(error);
    }
    if (owned && !owned.killed) owned.kill();
  }

  function ensureWorker() {
    if (worker) return worker;
    if (!encodedSource) {
      // Read via Node so this also works when the static script is inside app.asar.
      // Only packaged code is encoded; request text is always sent as JSON on stdin.
      encodedSource = Buffer.from(fs.readFileSync(workerPath, 'utf8'), 'utf16le').toString('base64');
    }
    const executable = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    const child = spawnProcess(executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedSource],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    worker = child;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdout.on('data', (chunk) => {
      if (worker !== child) return;
      stdout += chunk;
      if (stdout.length > MAX_RESPONSE_CHARS) {
        failWorker(child, new Error('The speech worker response exceeded its size limit.'));
        return;
      }
      let newline;
      while ((newline = stdout.indexOf('\n')) !== -1 && worker === child) {
        const line = stdout.slice(0, newline).replace(/\r$/, '');
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try {
          if (!active) throw new Error('Unexpected response from the speech worker.');
          const result = validateAudioResponse(JSON.parse(line), active.id);
          const job = active;
          active = null;
          clearJob(job);
          if (result.error) {
            job.reject(result.error);
          } else {
            cache.set(job.text, result.value);
            while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
            job.resolve(result.value);
          }
          queueMicrotask(pump);
        } catch (error) {
          failWorker(child, error);
        }
      }
    });
    child.on('error', () => failWorker(child, new Error('Could not start the Windows speech worker.')));
    child.on('exit', () => {
      // Bounded stderr is kept for diagnostics only; do not send shell output into the UI.
      void stderr;
      failWorker(child, new Error('The Windows speech worker stopped unexpectedly.'));
    });
    child.stdin.on('error', () => failWorker(child, new Error('Could not contact the Windows speech worker.')));
    return child;
  }

  function pump() {
    if (disposed || active || queue.length === 0) return;
    const job = queue.shift();
    active = job;
    let child;
    try {
      child = ensureWorker();
      job.timer = setTimeout(() => {
        failWorker(child, new Error('Windows speech generation timed out. Please try again.'));
      }, timeoutMs);
      child.stdin.write(JSON.stringify({ id: job.id, text: job.text }) + '\n', (error) => {
        if (error) failWorker(child, new Error('Could not send text to the Windows speech worker.'));
      });
    } catch (error) {
      failWorker(child, error);
    }
  }

  function prepare(text) {
    if (disposed) return Promise.reject(new Error('The speech service has been closed.'));
    if (typeof text !== 'string' || text.length > 200) {
      return Promise.reject(new Error('Only words from the application vocabulary can be spoken.'));
    }
    const normalized = text.trim();
    if (!normalized || !vocabulary.has(normalized)) {
      return Promise.reject(new Error('Only words from the application vocabulary can be spoken.'));
    }
    if (cache.has(normalized)) {
      const value = cache.get(normalized);
      cache.delete(normalized);
      cache.set(normalized, value);
      return Promise.resolve(value);
    }
    if (pending.has(normalized)) return pending.get(normalized).promise;
    if (pending.size >= maxQueue) {
      return Promise.reject(new Error('Too many speech requests. Please try again.'));
    }
    const job = { id: String(++nextId), text: normalized };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    pending.set(normalized, job);
    queue.push(job);
    pump();
    return job.promise;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    failWorker(worker, new Error('The speech service has been closed.'));
    cache.clear();
  }

  return { prepare, dispose };
}

module.exports = { createNativeSpeechService };
