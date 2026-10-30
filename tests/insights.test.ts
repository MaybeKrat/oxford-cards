import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countStages,
  dailySuggestions,
  reviewForecast,
  stageOf,
  summarizeDay,
} from '../src/lib/insights.ts';
import { DAY_MS, defaultState } from '../src/lib/scheduler.ts';
import type { AppState, CardProgress, Film, Word } from '../src/lib/types.ts';

const NOW = new Date(2026, 9, 31, 12).getTime();
const words: Word[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, word: id, translation: id, pos: 'сущ.', level: 'A1' }));

function card(interval: number, due: number, state: CardProgress['state'] = 'review'): CardProgress {
  return { due, interval, ease: 2.5, repetitions: 2, lapses: 0, lastReviewed: NOW - DAY_MS, startedAt: NOW - 5 * DAY_MS, state };
}

test('Stages follow the review interval and keep the 21-day mastery rule', () => {
  assert.equal(stageOf(undefined), 'new');
  assert.equal(stageOf(card(1 / 1440, NOW, 'relearning')), 'learning');
  assert.equal(stageOf(card(6, NOW)), 'familiar');
  assert.equal(stageOf(card(7, NOW)), 'confident');
  assert.equal(stageOf(card(21, NOW)), 'mastered');
  const state: AppState = { ...defaultState(), cards: { a: card(1 / 24, NOW), b: card(3, NOW), c: card(30, NOW) } };
  assert.deepEqual(countStages(words, state), { new: 2, learning: 1, familiar: 1, confident: 0, mastered: 1 });
});

test('Forecast puts overdue cards on today and later ones on their local day', () => {
  const state: AppState = {
    ...defaultState(),
    cards: { a: card(1, NOW - DAY_MS), b: card(1, NOW + DAY_MS), c: card(3, NOW + 3 * DAY_MS), d: card(30, NOW + 30 * DAY_MS) },
  };
  assert.deepEqual(reviewForecast(words, state, NOW, 5), [1, 1, 0, 1, 0]);
});

test('Day summary counts answers, active minutes and the most missed words first', () => {
  const at = (minutes: number) => NOW - 60 * 60_000 + minutes * 60_000;
  const state: AppState = {
    ...defaultState(),
    reviews: [
      { wordId: 'a', at: NOW - DAY_MS, rating: 'again', isNew: true },
      { wordId: 'a', at: at(0), rating: 'hard', isNew: false },
      { wordId: 'b', at: at(1), rating: 'again', isNew: true },
      { wordId: 'b', at: at(2), rating: 'again', isNew: false },
      { wordId: 'c', at: at(30), rating: 'good', isNew: true },
    ],
  };
  const day = summarizeDay(state, NOW);
  assert.equal(day.answers, 4);
  assert.equal(day.recalled, 25);
  assert.equal(day.newWords, 2);
  // Two one-minute gaps count; the 28-minute pause is replaced by one typical answer.
  assert.equal(day.minutes, 2);
  assert.deepEqual(day.hardWords, [{ wordId: 'b', again: 2, hard: 0 }, { wordId: 'a', again: 0, hard: 1 }]);
});

test('Daily suggestions skip the active film and move to the next pair the next day', () => {
  const film = (id: string, speech: number) => ({ film: { id, title: id } as Film, speech, words: 0, remaining: 0, started: false, lastStudied: 0 });
  const films = [film('a', 70), film('b', 90), film('c', 80), film('d', 60), film('active', 99)];
  const today = dailySuggestions(films, 'active', NOW).map((item) => item.film.id);
  const tomorrow = dailySuggestions(films, 'active', NOW + DAY_MS).map((item) => item.film.id);
  assert.equal(today.length, 2);
  assert.ok(!today.includes('active'));
  assert.notDeepEqual(today, tomorrow);
  assert.deepEqual([...today, ...tomorrow].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(dailySuggestions(films.slice(0, 1), null, NOW).map((item) => item.film.id), ['a']);
});
