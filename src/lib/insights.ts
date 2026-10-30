import type { AppState, CardProgress, Film, Rating, ReviewLog, Word } from './types.ts';
import { getFilmProgress, percent } from './films.ts';
import { DAY_MS, localDayKey } from './scheduler.ts';

/** Memory stages by the current review interval; «Закреплено» keeps the 21-day rule of getStats. */
export type Stage = 'new' | 'learning' | 'familiar' | 'confident' | 'mastered';
export const STAGES: Stage[] = ['new', 'learning', 'familiar', 'confident', 'mastered'];

export function stageOf(card: CardProgress | undefined): Stage {
  if (!card) return 'new';
  if (card.interval < 1) return 'learning';
  if (card.interval < 7) return 'familiar';
  if (card.interval < 21 || card.state !== 'review') return 'confident';
  return 'mastered';
}

export function countStages(words: readonly Word[], state: AppState): Record<Stage, number> {
  const counts = { new: 0, learning: 0, familiar: 0, confident: 0, mastered: 0 };
  for (const word of words) counts[stageOf(state.cards[word.id])]++;
  return counts;
}

/** Earliest review after which a card may first reach 21 days, if one is answered «Помню». */
export function firstMasteryDate(words: readonly Word[], state: AppState): number | undefined {
  let first: number | undefined;
  for (const word of words) {
    const card = state.cards[word.id];
    if (!card || stageOf(card) === 'mastered' || card.interval < 1) continue;
    if (Math.ceil(card.interval * card.ease) >= 21 && (first === undefined || card.due < first)) first = card.due;
  }
  return first;
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Reviews due on each of the next local days; day 0 also holds overdue cards. */
export function reviewForecast(words: readonly Word[], state: AppState, now: number, days = 14): number[] {
  const counts = Array<number>(days).fill(0);
  const today = startOfDay(now);
  for (const word of words) {
    const card = state.cards[word.id];
    if (!card) continue;
    const day = card.due <= now ? 0 : Math.round((startOfDay(card.due) - today) / DAY_MS);
    if (day < days) counts[day]++;
  }
  return counts;
}

/** Answers per local calendar day. */
export function answersByDay(reviews: readonly ReviewLog[]): Map<string, number> {
  const days = new Map<string, number>();
  for (const review of reviews) {
    const key = localDayKey(review.at);
    days.set(key, (days.get(key) ?? 0) + 1);
  }
  return days;
}

const PAUSE_MS = 3 * 60_000;
const DEFAULT_CARD_SECONDS = 8;

/** Typical seconds per answer: the median gap between recent answers, pauses excluded. */
export function secondsPerCard(reviews: readonly ReviewLog[]): number {
  const recent = reviews.slice(-300).map((review) => review.at).sort((a, b) => a - b);
  const gaps = recent.slice(1).map((at, index) => at - recent[index]).filter((gap) => gap > 0 && gap <= PAUSE_MS).sort((a, b) => a - b);
  if (gaps.length < 10) return DEFAULT_CARD_SECONDS;
  return Math.max(2, Math.round(gaps[Math.floor(gaps.length / 2)] / 1000));
}

export interface HardWord {
  wordId: string;
  again: number;
  hard: number;
}

export interface DaySummary {
  answers: number;
  /** Share of «Помню» and «Легко», 0–100. */
  recalled: number;
  minutes: number;
  newWords: number;
  /** Words answered «Не помню» or «Сложно» today, the most missed first. */
  hardWords: HardWord[];
}

export function successShare(reviews: readonly ReviewLog[]): number {
  if (!reviews.length) return 0;
  return Math.round((reviews.filter((review) => review.rating === 'good' || review.rating === 'easy').length / reviews.length) * 100);
}

export function summarizeDay(state: AppState, now: number): DaySummary {
  const today = localDayKey(now);
  const reviews = state.reviews.filter((review) => review.at <= now && localDayKey(review.at) === today)
    .sort((a, b) => a.at - b.at);
  let active = reviews.length ? DEFAULT_CARD_SECONDS * 1000 : 0;
  for (let i = 1; i < reviews.length; i++) {
    const gap = reviews[i].at - reviews[i - 1].at;
    active += gap <= PAUSE_MS ? gap : DEFAULT_CARD_SECONDS * 1000;
  }
  const hard = new Map<string, HardWord & { last: number }>();
  for (const review of reviews) {
    if (review.rating !== 'again' && review.rating !== 'hard') continue;
    const entry = hard.get(review.wordId) ?? { wordId: review.wordId, again: 0, hard: 0, last: 0 };
    entry[review.rating]++;
    entry.last = review.at;
    hard.set(review.wordId, entry);
  }
  return {
    answers: reviews.length,
    recalled: successShare(reviews),
    minutes: Math.round(active / 60_000),
    newWords: new Set(reviews.filter((review) => review.isNew).map((review) => review.wordId)).size,
    hardWords: [...hard.values()]
      .sort((a, b) => b.again - a.again || b.hard - a.hard || b.last - a.last)
      .map(({ wordId, again, hard: hardCount }) => ({ wordId, again, hard: hardCount })),
  };
}

export function historyOf(state: AppState, wordId: string): { at: number; rating: Rating }[] {
  return state.reviews.filter((review) => review.wordId === wordId)
    .sort((a, b) => a.at - b.at)
    .map(({ at, rating }) => ({ at, rating }));
}

export interface FilmReadiness {
  film: Film;
  /** Share of the film's speech covered by learned words, 0–100. */
  speech: number;
  /** Share of the mode's words learned, 0–100. */
  words: number;
  /** Words of the mode still to learn. */
  remaining: number;
  /** At least one of the film's own cards was answered. */
  started: boolean;
  /** Latest answer on the film's own cards. */
  lastStudied: number;
}

export function filmReadiness(films: readonly Film[], state: AppState): FilmReadiness[] {
  const last = new Map<string, number>();
  for (const review of state.reviews) last.set(review.wordId, Math.max(last.get(review.wordId) ?? 0, review.at));
  return films.map((film) => {
    const progress = getFilmProgress(film, state);
    const lastStudied = Math.max(0, ...film.cards.map((card) => last.get(card.id) ?? 0));
    return {
      film,
      speech: percent(progress.speech),
      words: percent(progress.words),
      remaining: progress.words.total - progress.words.learned,
      started: film.cards.some((card) => state.cards[card.id]),
      lastStudied,
    };
  });
}

/** Films closest to watching, two at a time; the pair moves on to the next ones every local day. */
export function dailySuggestions<T extends FilmReadiness>(films: readonly T[], activeId: string | null, now: number, size = 2): T[] {
  const candidates = films.filter((item) => item.film.id !== activeId)
    .sort((a, b) => b.speech - a.speech || a.film.title.localeCompare(b.film.title, 'ru'));
  if (candidates.length <= size) return candidates;
  const pairs = Math.ceil(candidates.length / size);
  const day = Math.floor(startOfDay(now) / DAY_MS);
  const start = (day % pairs) * size;
  const pick = candidates.slice(start, start + size);
  // The last group may be short; fill it from the top so two films always show.
  return pick.length === size ? pick : [...pick, ...candidates.slice(0, size - pick.length)];
}
