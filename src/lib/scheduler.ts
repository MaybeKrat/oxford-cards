import type { AppState, CardProgress, Film, Level, Rating, StudyStats, Word } from './types.ts';
import { getActiveFilm } from './films.ts';
import { MAX_COUNTER, MAX_INTERVAL, MAX_TIMESTAMP, timestamp, validCard } from './validation.ts';

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;
export const MAX_DAILY_EXTRA = 10_000;
export const ALL_LEVELS: Level[] = ['A1', 'A2', 'B1', 'B2'];

export function defaultState(): AppState {
  return {
    version: 1,
    cards: {},
    reviews: [],
    settings: {
      dailyNewLimit: 20,
      levels: [...ALL_LEVELS],
      direction: 'en-ru',
      autoSpeak: false,
      theme: 'system',
      film: null,
      voice: 'ryan',
    },
  };
}

/** A study day starts at 04:00, so answers late at night belong to the evening before. */
export const DAY_START_HOUR = 4;

/** Start of the local study day that contains the moment. */
export function studyDayStart(at: number): number {
  const date = new Date(at);
  if (date.getHours() < DAY_START_HOUR) date.setDate(date.getDate() - 1);
  date.setHours(DAY_START_HOUR, 0, 0, 0);
  return date.getTime();
}

/** Start of the study day that comes the given number of days after the moment. */
function studyDaysLater(at: number, days: number): number {
  const date = new Date(studyDayStart(at));
  date.setDate(date.getDate() + days);
  date.setHours(DAY_START_HOUR, 0, 0, 0);
  return date.getTime();
}

/** Stable number in [-1, 1] for a card and its previous answer (FNV-1a). */
function spread(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 0x01000193);
  return ((hash >>> 0) / 0xffffffff) * 2 - 1;
}

/** Four-button adaptation of SM-2, with a one-minute retry and hard/easy bonuses.
 * Intervals from one day are due at the start of a study day; the daily quota uses the device's local date.
 * With a seed (the card id), intervals from three days spread by ±5%, at least a day, so cards started
 * together do not all return on the same day; the same card and answer always get the same spread.
 * Source: https://www.super-memory.com/english/ol/sm2.htm
 */
export function scheduleCard(previous: CardProgress | undefined, rating: Rating, now: number, seed?: string): CardProgress {
  if (!timestamp(now)) throw new Error('Некорректное время повторения.');
  if (!['again', 'hard', 'good', 'easy'].includes(rating)) throw new Error('Неизвестная оценка ответа.');
  if (previous && !validCard(previous)) throw new Error('Некорректный прогресс карточки.');
  if (previous && now < previous.lastReviewed) throw new Error('Проверьте дату и время на устройстве.');

  const oldEase = previous?.ease ?? 2.5;
  // Misses before the word was ever recalled are part of learning it and do not lower the ease.
  const neverRecalled = !previous || previous.state === 'learning';
  const quality = { again: 1, hard: 3, good: 4, easy: 5 }[rating];
  const ease = rating === 'again' && neverRecalled ? oldEase : Math.max(1.3, Math.min(5, Math.round(
    (oldEase + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)) * 100,
  ) / 100));
  const startedAt = previous?.startedAt ?? now;

  if (rating === 'again') {
    if (now > MAX_TIMESTAMP - MINUTE_MS) throw new Error('Дата повторения выходит за допустимый диапазон.');
    return {
      due: now + MINUTE_MS,
      interval: 1 / 1440,
      ease,
      repetitions: 0,
      lapses: Math.min(MAX_COUNTER, (previous?.lapses ?? 0) + (previous?.state === 'review' ? 1 : 0)),
      lastReviewed: now,
      startedAt,
      state: previous && previous.state !== 'learning' ? 'relearning' : 'learning',
    };
  }

  // After a step shorter than a day (a miss or the first «Сложно») the chain of successes starts again from one day.
  const repetitions = !previous || previous.interval < 1 ? 1 : Math.min(MAX_COUNTER, previous.repetitions + 1);
  const oldInterval = previous?.interval ?? 0;
  const shift = seed === undefined ? 0 : spread(`${seed}:${previous?.lastReviewed ?? 0}`);
  const fuzz = (days: number) => days < 3 ? days : days + Math.round(shift * Math.max(1, days * 0.05));
  const good = fuzz(repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.max(1, Math.ceil(oldInterval * oldEase)));
  let interval: number;
  if (rating === 'hard') interval = previous ? Math.min(good, fuzz(Math.max(1, Math.ceil(oldInterval * 1.2)))) : 1 / 24;
  // Easy always beats Good, including the fixed six-day step of the second review.
  else if (rating === 'easy') interval = Math.max(fuzz(Math.max(4, Math.ceil(oldInterval * oldEase * 1.3))), good + 1);
  else interval = good;
  interval = Math.max(rating === 'hard' && !previous ? 1 / 24 : 1, Math.min(MAX_INTERVAL, interval));

  const due = interval < 1 ? now + interval * DAY_MS : studyDaysLater(now, interval);
  if (!timestamp(due)) throw new Error('Дата повторения выходит за допустимый диапазон.');
  return {
    due,
    interval,
    ease,
    repetitions,
    lapses: previous?.lapses ?? 0,
    lastReviewed: now,
    startedAt,
    state: 'review',
  };
}

export function localDayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function getDailyNewLimit(state: AppState, now: number): number {
  const extra = state.dailyExtra?.day === localDayKey(now) ? state.dailyExtra.count : 0;
  return state.settings.dailyNewLimit + extra;
}

/** Extend today's allowance without changing the recurring daily setting. */
export function addExtraNewWords(state: AppState, count: number, now: number): AppState {
  if (!timestamp(now)) throw new Error('Некорректная дата занятия.');
  const day = localDayKey(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Некорректная дата занятия.');
  if (!Number.isInteger(count) || count <= 0 || count > MAX_DAILY_EXTRA) {
    throw new Error('Некорректное количество дополнительных слов.');
  }
  const previous = state.dailyExtra?.day === day ? state.dailyExtra.count : 0;
  const total = previous + count;
  if (total > MAX_DAILY_EXTRA) throw new Error('Достигнут предел дополнительных слов на сегодня.');
  return { ...state, dailyExtra: { day, count: total } };
}

/** Cards that may be studied: selected Oxford levels plus every card of the active film mode. */
export function getAvailableWords(words: readonly Word[], state: AppState, films: readonly Film[] = []): Word[] {
  return availableWords(words, state, getActiveFilm(films, state));
}

function availableWords(words: readonly Word[], state: AppState, film: Film | undefined): Word[] {
  const levels = new Set(state.settings.levels);
  const mode = new Set(film?.entries.map((entry) => entry.id));
  return [...words.filter((word) => (word.level && levels.has(word.level)) || mode.has(word.id)), ...(film?.cards ?? [])];
}

/** Unstarted cards in study order: the active film mode first (most used first), then Oxford by level and topic. */
export function getNewWords(words: readonly Word[], state: AppState, films: readonly Film[] = []): Word[] {
  const film = getActiveFilm(films, state);
  const available = availableWords(words, state, film);
  const byId = new Map(available.map((word) => [word.id, word]));
  const mode = (film?.entries ?? []).map((entry) => byId.get(entry.id))
    .filter((word): word is Word => !!word && !state.cards[word.id]);
  const inMode = new Set(mode.map((word) => word.id));
  const levels = new Set(state.settings.levels);
  return [...mode, ...words.filter((word) => word.level && levels.has(word.level) && !state.cards[word.id] && !inMode.has(word.id))];
}

export function getStudyQueue(words: readonly Word[], state: AppState, now: number, films: readonly Film[] = []): Word[] {
  const available = availableWords(words, state, getActiveFilm(films, state));
  const due = available.filter((word) => state.cards[word.id]?.due <= now)
    .sort((a, b) => state.cards[a.id]!.due - state.cards[b.id]!.due || a.id.localeCompare(b.id));
  const today = localDayKey(now);
  const newToday = new Set(state.reviews.filter((review) => review.isNew && review.at <= now && localDayKey(review.at) === today)
    .map((review) => review.wordId));
  const remaining = Math.max(0, getDailyNewLimit(state, now) - newToday.size);
  return [...due, ...getNewWords(words, state, films).slice(0, remaining)];
}

export function getStats(words: Word[], state: AppState, now: number, films: readonly Film[] = []): StudyStats {
  const queue = getStudyQueue(words, state, now, films);
  const knownIds = new Set(words.map((word) => word.id));
  const cards = Object.entries(state.cards).filter(([id]) => knownIds.has(id)).map(([, card]) => card);
  const learned = cards.filter((card) => card.state === 'review' && card.interval >= 21).length;
  const reviews = state.reviews.filter((review) => knownIds.has(review.wordId) && review.at <= now);
  const today = localDayKey(now);
  const days = new Set(reviews.map((review) => localDayKey(review.at)));
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  if (!days.has(today)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(localDayKey(cursor.getTime()))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return {
    due: queue.filter((word) => Boolean(state.cards[word.id])).length,
    newAvailable: queue.filter((word) => !state.cards[word.id]).length,
    learning: cards.length - learned,
    learned,
    reviewedToday: new Set(reviews.filter((review) => localDayKey(review.at) === today).map((review) => review.wordId)).size,
    streak,
    started: cards.length,
    total: words.length,
  };
}
