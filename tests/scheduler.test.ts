import assert from 'node:assert/strict';
import test from 'node:test';
import { addExtraNewWords, DAY_MS, defaultState, getDailyNewLimit, getStats, getStudyQueue, localDayKey, MAX_DAILY_EXTRA, MINUTE_MS, scheduleCard } from '../src/lib/scheduler.ts';
import type { AppState, CardProgress, Word } from '../src/lib/types.ts';

const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime();
const words: Word[] = [
  { id: 'a', word: 'apple', translation: 'яблоко', level: 'A1', pos: 'noun' },
  { id: 'b', word: 'book', translation: 'книга', level: 'A1', pos: 'noun' },
  { id: 'c', word: 'courage', translation: 'смелость', level: 'B2', pos: 'noun' },
  { id: 'd', word: 'dog', translation: 'собака', level: 'A1', pos: 'noun' },
];

function matureCard(at = NOW - DAY_MS): CardProgress {
  return { due: at, interval: 30, ease: 2.5, repetitions: 5, lapses: 0, lastReviewed: at - 30 * DAY_MS, startedAt: at - 50 * DAY_MS, state: 'review' };
}

test('Good follows one day, six days and then the previous ease factor', () => {
  const first = scheduleCard(undefined, 'good', NOW);
  assert.equal(first.interval, 1);
  assert.equal(first.due, NOW + DAY_MS);
  const second = scheduleCard(first, 'good', first.due);
  assert.equal(second.interval, 6);
  const third = scheduleCard(second, 'good', second.due);
  assert.equal(third.interval, 15);
  assert.equal(third.repetitions, 3);
  assert.equal(third.startedAt, NOW);
  assert.equal(third.ease, 2.5);
});

test('Again retries in one minute without counting a new card as a lapse', () => {
  const first = scheduleCard(undefined, 'again', NOW);
  assert.equal(first.due, NOW + MINUTE_MS);
  assert.equal(first.state, 'learning');
  assert.equal(first.lapses, 0);
  const second = scheduleCard(first, 'again', first.due);
  assert.equal(second.lapses, 0);
  assert.equal(second.repetitions, 0);
  const recovered = scheduleCard(second, 'good', second.due);
  assert.equal(recovered.interval, 1);
});

test('A failed mature card relearns and resumes from day one', () => {
  const original = matureCard();
  const failed = scheduleCard(original, 'again', NOW);
  assert.equal(failed.state, 'relearning');
  assert.equal(failed.repetitions, 0);
  assert.equal(failed.lapses, 1);
  assert.equal(original.lapses, 0, 'scheduler must not mutate input');
  const failedAgain = scheduleCard(failed, 'again', failed.due);
  assert.equal(failedAgain.state, 'relearning');
  assert.equal(failedAgain.lapses, 1);
  const recovered = scheduleCard(failedAgain, 'good', failedAgain.due);
  assert.equal(recovered.interval, 1);
  assert.equal(recovered.state, 'review');
  assert.equal(recovered.lapses, 1);
});

test('Hard retries a new card in one hour and keeps existing-card scheduling', () => {
  const first = scheduleCard(undefined, 'hard', NOW);
  assert.equal(first.interval, 1 / 24);
  assert.equal(first.due, NOW + 60 * MINUTE_MS);
  const state = defaultState();
  state.settings.dailyNewLimit = 0;
  state.cards.a = first;
  assert.deepEqual(getStudyQueue(words, state, first.due - 1), []);
  assert.deepEqual(getStudyQueue(words, state, first.due).map(word => word.id), ['a']);
  assert.equal(scheduleCard(first, 'hard', first.due).interval, 1);
  const failed = scheduleCard(undefined, 'again', NOW);
  assert.equal(scheduleCard(failed, 'hard', failed.due).interval, 1);
});

test('Easy starts at four days; Hard/Easy retain their mature-card intervals', () => {
  assert.equal(scheduleCard(undefined, 'easy', NOW).interval, 4);
  assert.equal(scheduleCard(matureCard(), 'hard', NOW).interval, 36);
  assert.equal(scheduleCard(matureCard(), 'easy', NOW).interval, 98);
  assert.ok(scheduleCard(matureCard(), 'hard', NOW).ease < 2.5);
  assert.ok(scheduleCard(matureCard(), 'easy', NOW).ease > 2.5);
});

test('Overdue cards are scheduled relative to the actual review time', () => {
  const card = matureCard(NOW - 20 * DAY_MS);
  const updated = scheduleCard(card, 'good', NOW);
  assert.equal(updated.due, NOW + 75 * DAY_MS);
});

test('Repeated failure never makes ease negative; long intervals are bounded', () => {
  let card = scheduleCard(undefined, 'again', NOW);
  for (let i = 0; i < 50; i++) card = scheduleCard(card, 'again', card.due);
  assert.equal(card.ease, 1.3);
  const long = { ...matureCard(), interval: 36_500, ease: 5 };
  assert.equal(scheduleCard(long, 'easy', NOW).interval, 36_500);
  assert.equal(scheduleCard(long, 'easy', NOW).ease, 5);
  for (const bad of [NaN, Infinity, -1, 8_640_000_000_000_000]) {
    assert.throws(() => scheduleCard(undefined, 'good', bad));
  }
  assert.throws(() => scheduleCard({ ...matureCard(), interval: NaN }, 'good', NOW));
  assert.throws(() => scheduleCard(undefined, 'invalid' as never, NOW));
});

test('Due cards come before new cards, oldest due first, with level filtering', () => {
  const state = defaultState();
  state.cards.b = matureCard(NOW - 1);
  state.cards.d = matureCard(NOW - 100);
  state.cards.c = matureCard(NOW - 200);
  state.settings.levels = ['A1'];
  assert.deepEqual(getStudyQueue(words, state, NOW).map((word) => word.id), ['d', 'b', 'a']);
});

test('Daily new quota counts unique new cards across selected levels', () => {
  const state = defaultState();
  state.settings.dailyNewLimit = 2;
  state.settings.levels = ['A1'];
  state.cards.c = scheduleCard(undefined, 'again', NOW - 100);
  state.reviews = [
    { wordId: 'c', at: NOW - 100, rating: 'again', isNew: true },
    { wordId: 'c', at: NOW - 50, rating: 'again', isNew: true },
  ];
  assert.deepEqual(getStudyQueue(words, state, NOW).map((word) => word.id), ['a']);
  state.settings.dailyNewLimit = 0;
  state.cards.b = matureCard();
  assert.deepEqual(getStudyQueue(words, state, NOW).map((word) => word.id), ['b']);
});

test('New quota resets at local midnight, while review cards stay available', () => {
  const now = new Date(2026, 9, 25, 0, 1).getTime();
  const beforeMidnight = new Date(2026, 9, 24, 23, 59).getTime();
  assert.notEqual(localDayKey(now), localDayKey(beforeMidnight));
  const state = defaultState();
  state.settings.dailyNewLimit = 1;
  state.cards.a = scheduleCard(undefined, 'again', beforeMidnight);
  state.reviews = [{ wordId: 'a', at: beforeMidnight, rating: 'again', isNew: true }];
  assert.deepEqual(getStudyQueue(words, state, now).map((word) => word.id), ['a', 'b']);
});

test('Extra new words resume an exhausted queue and only extend the current local day', () => {
  const state = defaultState();
  state.settings.dailyNewLimit = 1;
  state.cards.a = scheduleCard(undefined, 'good', NOW);
  state.reviews = [{ wordId: 'a', at: NOW, rating: 'good', isNew: true }];
  assert.deepEqual(getStudyQueue(words, state, NOW), []);
  const extended = addExtraNewWords(state, 2, NOW);
  assert.equal(getDailyNewLimit(extended, NOW), 3);
  assert.deepEqual(getStudyQueue(words, extended, NOW).map((word) => word.id), ['b', 'c']);
  const tomorrow = new Date(2026, 9, 26, 0, 1).getTime();
  assert.equal(getDailyNewLimit(extended, tomorrow), 1);
  assert.deepEqual(getStudyQueue(words, extended, tomorrow).map((word) => word.id), ['b']);
  assert.equal(extended.settings, state.settings);
  assert.equal(extended.cards, state.cards);
  assert.equal(extended.reviews, state.reviews);
  assert.equal(state.dailyExtra, undefined);
  assert.equal(state.settings.dailyNewLimit, 1);
});

test('Additional allowances accumulate today and start fresh on another local day', () => {
  const beforeMidnight = new Date(2026, 9, 25, 23, 59).getTime();
  const afterMidnight = new Date(2026, 9, 26, 0, 1).getTime();
  const first = addExtraNewWords(defaultState(), 10, beforeMidnight);
  const second = addExtraNewWords(first, 5, beforeMidnight);
  assert.deepEqual(first.dailyExtra, { day: '2026-10-25', count: 10 });
  assert.deepEqual(second.dailyExtra, { day: '2026-10-25', count: 15 });
  assert.equal(getDailyNewLimit(second, beforeMidnight), 35);
  assert.equal(getDailyNewLimit(second, afterMidnight), 20);
  const nextDay = addExtraNewWords(second, 10, afterMidnight);
  assert.deepEqual(nextDay.dailyExtra, { day: '2026-10-26', count: 10 });
  assert.equal(getDailyNewLimit(nextDay, afterMidnight), 30);
});

test('Extra allowance keeps due cards first and respects selected levels and prior new cards', () => {
  const state = defaultState();
  state.settings.dailyNewLimit = 1;
  state.settings.levels = ['A1'];
  state.cards.b = matureCard(NOW - 1);
  state.cards.d = matureCard(NOW - 100);
  state.cards.c = scheduleCard(undefined, 'good', NOW);
  state.reviews = [{ wordId: 'c', at: NOW, rating: 'good', isNew: true }];
  assert.deepEqual(getStudyQueue(words, state, NOW).map((word) => word.id), ['d', 'b']);
  const extended = addExtraNewWords(state, 10, NOW);
  assert.deepEqual(getStudyQueue(words, extended, NOW).map((word) => word.id), ['d', 'b', 'a']);
  assert.equal(getStats(words, extended, NOW).newAvailable, 1);
});

test('An explicit extra allowance works when the recurring new-word limit is zero', () => {
  const state = defaultState();
  state.settings.dailyNewLimit = 0;
  const extended = addExtraNewWords(state, 1, NOW);
  assert.deepEqual(getStudyQueue(words, extended, NOW).map((word) => word.id), ['a']);
  assert.deepEqual(getStudyQueue(words, extended, NOW + DAY_MS), []);
  assert.equal(extended.settings.dailyNewLimit, 0);
});

test('Extra allowances reject invalid amounts, excessive totals and invalid times', () => {
  const state = defaultState();
  for (const count of [NaN, Infinity, -1, 0, 1.5, MAX_DAILY_EXTRA + 1]) {
    assert.throws(() => addExtraNewWords(state, count, NOW));
  }
  for (const at of [NaN, Infinity, -1, 1.5, 8_640_000_000_000_000]) {
    assert.throws(() => addExtraNewWords(state, 10, at));
  }
  const extended = addExtraNewWords(state, MAX_DAILY_EXTRA, NOW);
  assert.equal(extended.dailyExtra?.count, MAX_DAILY_EXTRA);
  assert.throws(() => addExtraNewWords(extended, 1, NOW), /предел/);
  assert.equal(addExtraNewWords(extended, 10, NOW + DAY_MS).dailyExtra?.count, 10);
});

test('Stats count unique cards, mature cards, and consecutive local review days', () => {
  const state: AppState = defaultState();
  state.cards.a = matureCard();
  state.cards.b = scheduleCard(undefined, 'again', NOW - MINUTE_MS);
  state.reviews = [
    { wordId: 'a', at: NOW - 2 * DAY_MS, rating: 'good', isNew: false },
    { wordId: 'a', at: NOW - DAY_MS, rating: 'good', isNew: false },
    { wordId: 'b', at: NOW - MINUTE_MS, rating: 'again', isNew: true },
    { wordId: 'b', at: NOW, rating: 'good', isNew: false },
  ];
  const stats = getStats(words, state, NOW);
  assert.deepEqual(stats, { due: 2, newAvailable: 2, learning: 1, learned: 1, reviewedToday: 1, streak: 3, started: 2, total: 4 });
  assert.equal(getStats(words, state, NOW + DAY_MS).streak, 3);
  assert.equal(getStats(words, state, NOW + 2 * DAY_MS).streak, 0);
});

test('Default states are independent and scheduled future cards do not enter queue', () => {
  const state = defaultState();
  state.settings.levels.pop();
  assert.equal(defaultState().settings.levels.length, 4);
  state.cards.a = scheduleCard(undefined, 'good', NOW);
  assert.ok(!getStudyQueue(words, state, NOW).some((word) => word.id === 'a'));
});

test('Easy is always longer than Good, including the six-day second review', () => {
  let card = scheduleCard(undefined, 'good', NOW);
  for (let review = 0; review < 5; review++) {
    const at = card.due;
    const intervals = (['hard', 'good', 'easy'] as const).map((rating) => scheduleCard(card, rating, at).interval);
    assert.ok(intervals[0] < intervals[1] && intervals[1] < intervals[2], `review ${review + 2}: ${intervals}`);
    card = scheduleCard(card, 'good', at);
  }
  const second = scheduleCard(undefined, 'good', NOW);
  assert.equal(scheduleCard(second, 'good', second.due).interval, 6);
  assert.equal(scheduleCard(second, 'easy', second.due).interval, 7);
});
