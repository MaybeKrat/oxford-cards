import type { AppState, CardProgress, Level, Rating, ReviewLog, Settings } from './types.ts';
import { defaultState, MAX_DAILY_EXTRA } from './scheduler.ts';
import { finiteRange, isRecord, timestamp, validCard } from './validation.ts';
import { isVoice } from './voices.ts';

export const STORAGE_KEY = 'oxford-cards:v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function invalid(detail: string): never {
  throw new Error(`Не удалось загрузить прогресс: ${detail}`);
}

function validId(value: unknown, known?: Set<string>): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && !['__proto__', 'constructor', 'prototype'].includes(value) && (!known || known.has(value));
}

function validDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

function validateState(raw: string, validWordIds?: Set<string>): AppState {
  if (raw.length > 15_000_000) invalid('файл слишком большой (максимум 15 МБ).');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { invalid('файл содержит некорректный JSON.'); }
  if (!isRecord(parsed) || parsed.version !== 1) invalid('неподдерживаемая версия файла.');
  if (!isRecord(parsed.cards) || Object.keys(parsed.cards).length > 10_000) invalid('некорректный список карточек.');
  const cards: Record<string, CardProgress> = {};
  for (const [id, value] of Object.entries(parsed.cards)) {
    const displayId = id.slice(0, 80);
    if (!validId(id, validWordIds)) invalid(`неизвестная карточка «${displayId}».`);
    if (!validCard(value)) invalid(`некорректные интервалы или даты карточки «${id.slice(0, 80)}».`);
    cards[id] = {
      due: value.due, interval: value.interval, ease: value.ease, repetitions: value.repetitions,
      lapses: value.lapses, lastReviewed: value.lastReviewed, startedAt: value.startedAt, state: value.state,
    };
  }
  if (!Array.isArray(parsed.reviews) || parsed.reviews.length > 250_000) invalid('некорректная история повторений.');
  const reviews: ReviewLog[] = parsed.reviews.map((review: unknown) => {
    if (!isRecord(review) || !validId(review.wordId, validWordIds) || !timestamp(review.at)
      || typeof review.rating !== 'string' || !['again', 'hard', 'good', 'easy'].includes(review.rating) || typeof review.isNew !== 'boolean') {
      invalid('некорректная запись в истории повторений.');
    }
    return { wordId: review.wordId, at: review.at, rating: review.rating as Rating, isNew: review.isNew };
  });
  const settings = parsed.settings;
  if (!isRecord(settings) || !finiteRange(settings.dailyNewLimit, 0, 200) || !Number.isInteger(settings.dailyNewLimit)
    || !Array.isArray(settings.levels) || settings.levels.length === 0 || settings.levels.length > 4
    || settings.levels.some((level) => !['A1', 'A2', 'B1', 'B2'].includes(level))
    || new Set(settings.levels).size !== settings.levels.length
    || typeof settings.direction !== 'string' || !['en-ru', 'ru-en'].includes(settings.direction) || typeof settings.autoSpeak !== 'boolean') {
    invalid('некорректные настройки обучения.');
  }
  if (settings.theme !== undefined
    && (typeof settings.theme !== 'string' || !['system', 'light', 'dark'].includes(settings.theme))) {
    invalid('некорректная тема оформления.');
  }
  // An unknown but well-formed film id keeps the backup usable: the app then works without a mode.
  if (settings.film !== undefined && settings.film !== null
    && (typeof settings.film !== 'string' || !/^[a-z0-9-]{1,64}$/.test(settings.film))) {
    invalid('некорректный мод фильма.');
  }
  if (settings.voice !== undefined && !isVoice(settings.voice)) invalid('некорректный голос озвучки.');
  let dailyExtra: AppState['dailyExtra'];
  if (parsed.dailyExtra !== undefined) {
    const extra = parsed.dailyExtra;
    if (!isRecord(extra) || !validDayKey(extra.day) || !finiteRange(extra.count, 1, MAX_DAILY_EXTRA)
      || !Number.isInteger(extra.count)) {
      invalid('некорректный дополнительный лимит новых слов.');
    }
    dailyExtra = { day: extra.day, count: extra.count };
  }
  return {
    version: 1, cards, reviews,
    ...(dailyExtra ? { dailyExtra } : {}),
    settings: {
      dailyNewLimit: settings.dailyNewLimit,
      levels: [...settings.levels] as Level[],
      direction: settings.direction as Settings['direction'],
      autoSpeak: settings.autoSpeak,
      // Older version-1 backups follow the operating system without losing progress.
      theme: (settings.theme ?? 'system') as Settings['theme'],
      // Backups made before film modes start without a mode.
      film: (settings.film ?? null) as Settings['film'],
      // Backups made before recorded voices get the default voice.
      voice: (settings.voice ?? 'ryan') as Settings['voice'],
    },
  };
}

/** Import is atomic: validate the complete backup before replacing live state. */
export function parseBackup(raw: string, validWordIds: Set<string>): AppState {
  return validateState(raw, validWordIds);
}

function browserStorage(): StorageLike {
  try {
    if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage;
  } catch { /* SecurityError is surfaced below. */ }
  throw new Error('Хранилище браузера недоступно. Разрешите сохранение данных для этого сайта.');
}

export function readState(storage: StorageLike = browserStorage(), validWordIds?: Set<string>): AppState {
  let raw: string | null;
  try { raw = storage.getItem(STORAGE_KEY); }
  catch { throw new Error('Не удалось прочитать прогресс из хранилища браузера.'); }
  return raw === null ? defaultState() : validateState(raw, validWordIds);
}

export function writeState(state: AppState, storage: StorageLike = browserStorage()): void {
  const raw = JSON.stringify(state);
  validateState(raw);
  try { storage.setItem(STORAGE_KEY, raw); }
  catch { throw new Error('Не удалось сохранить прогресс. Возможно, хранилище браузера переполнено или заблокировано. Экспортируйте резервную копию.'); }
}
