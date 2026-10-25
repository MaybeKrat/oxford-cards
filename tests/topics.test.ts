import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TOPICS, getTopicName, orderWordsForStudy } from '../src/lib/topics.ts';
import { addExtraNewWords, defaultState, getStudyQueue, scheduleCard } from '../src/lib/scheduler.ts';
import { parseBackup } from '../src/lib/storage.ts';
import { validateTopicAssignments } from '../scripts/check-data.mjs';
import type { Word } from '../src/lib/types.ts';

const NOW = new Date(2026, 9, 25, 12).getTime();
const catalog: Word[] = [
  { id: 'bread', word: 'bread', translation: 'хлеб', pos: 'сущ.', level: 'A1', topic: 'food' },
  { id: 'cousin', word: 'cousin', translation: 'двоюродный брат', pos: 'сущ.', level: 'A2', topic: 'people' },
  { id: 'uncle', word: 'uncle', translation: 'дядя', pos: 'сущ.', level: 'A1', topic: 'people' },
  { id: 'bed', word: 'bed', translation: 'кровать', pos: 'сущ.', level: 'A1', topic: 'home' },
  { id: 'father', word: 'father', translation: 'отец', pos: 'сущ.', level: 'A1', topic: 'people' },
  { id: 'apple', word: 'apple', translation: 'яблоко', pos: 'сущ.', level: 'A1', topic: 'food' },
];
const ordered = orderWordsForStudy(catalog);
const ids = (words: Word[]) => words.map((word) => word.id);

test('New words stay within one topic and level before automatically moving on', () => {
  const original = structuredClone(catalog);
  assert.deepEqual(ids(ordered), ['father', 'uncle', 'bed', 'apple', 'bread', 'cousin']);
  assert.deepEqual(ids(orderWordsForStudy([...catalog].reverse())), ids(ordered));
  assert.deepEqual(catalog, original, 'Ordering must not mutate the dictionary');
  const state = defaultState();
  state.cards.father = scheduleCard(undefined, 'easy', NOW);
  state.cards.uncle = scheduleCard(undefined, 'easy', NOW);
  assert.deepEqual(ids(getStudyQueue(ordered, state, NOW)), ['bed', 'apple', 'bread', 'cousin']);
  state.settings.levels = ['A2'];
  assert.deepEqual(ids(getStudyQueue(ordered, state, NOW)), ['cousin']);
});

test('Thematic introduction preserves review priority, progress, quota and extra words', () => {
  const state = defaultState();
  state.settings.dailyNewLimit = 1;
  state.cards.bread = scheduleCard(undefined, 'again', NOW - 120_000);
  state.cards.apple = scheduleCard(undefined, 'again', NOW - 180_000);
  state.cards.father = scheduleCard(undefined, 'easy', NOW);
  state.reviews = [{ wordId: 'father', at: NOW, rating: 'easy', isNew: true }];
  const original = structuredClone(state);
  assert.deepEqual(ids(getStudyQueue(ordered, state, NOW)), ['apple', 'bread']);
  const extended = addExtraNewWords(state, 2, NOW);
  const reopened = parseBackup(JSON.stringify(extended), new Set(catalog.map((word) => word.id)));
  assert.deepEqual(ids(getStudyQueue(ordered, reopened, NOW)), ['apple', 'bread', 'uncle', 'bed']);
  assert.deepEqual(reopened.cards, original.cards);
  assert.deepEqual(reopened.reviews, original.reviews);
  assert.deepEqual(state, original);
});

test('Every shipped card has an explicit valid topic, with distinct senses kept separate', () => {
  const words: Word[] = JSON.parse(readFileSync(new URL('../src/data/oxford3000.json', import.meta.url), 'utf8'));
  const assignments = JSON.parse(readFileSync(new URL('../src/data/word-topics.json', import.meta.url), 'utf8'));
  assert.equal(TOPICS.length, new Set(TOPICS.map((topic) => topic.id)).size);
  assert.equal(Object.keys(assignments).length, 3000);
  assert.deepEqual(validateTopicAssignments(words, assignments).errors, []);
  for (const [headword, topic] of [['mother', 'people'], ['kitchen', 'home'], ['bread', 'food'], ['airport', 'travel'], ['rain', 'nature']]) {
    const word = words.find((word) => word.word === headword)!;
    assert.ok(word, headword);
    assert.equal(assignments[word.id], topic, headword);
  }
  const banks = words.filter((word) => word.word === 'bank');
  assert.equal(banks.length, 2);
  assert.notEqual(assignments[banks[0].id], assignments[banks[1].id]);
  assert.equal(getTopicName('people'), 'Люди и семья');
});

test('Missing, unknown or malformed topic assignments are reported before packaging', () => {
  const assignments = Object.fromEntries(catalog.map((word) => [word.id, word.topic]));
  assert.deepEqual(validateTopicAssignments(catalog, assignments).errors, []);
  const missing = { ...assignments };
  delete missing.uncle;
  assert.ok(validateTopicAssignments(catalog, missing).errors.some((error: string) => error.includes('Не назначена тема')));
  assert.ok(validateTopicAssignments(catalog, { ...assignments, ghost: 'people' }).errors.some((error: string) => error.includes('Неизвестная карточка')));
  assert.ok(validateTopicAssignments(catalog, { ...assignments, uncle: 'unknown' }).errors.some((error: string) => error.includes('Неизвестная тема')));
  for (const bad of [null, [], 'people', 42]) assert.ok(validateTopicAssignments(catalog, bad).errors.length);
});
