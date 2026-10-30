import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateFilm, validateSharedCards } from '../scripts/check-data.mjs';
import { getFilmProgress, loadFilm, percent } from '../src/lib/films.ts';
import { defaultState, getNewWords, getStudyQueue, scheduleCard } from '../src/lib/scheduler.ts';
import { parseBackup } from '../src/lib/storage.ts';
import type { AppState, Rating, Word } from '../src/lib/types.ts';

const words = JSON.parse(readFileSync(new URL('../src/data/oxford3000.json', import.meta.url), 'utf8'));
const bundled = (id: string) => JSON.parse(readFileSync(new URL(`../src/data/films/${id}.json`, import.meta.url), 'utf8'));
const dune = bundled('dune');
const zootopia = bundled('zootopia');

test('Bundled film modes pass validation and link every new card to the mode', () => {
  for (const film of [dune, zootopia]) {
    const { errors, report } = validateFilm(film, words);
    assert.deepEqual(errors, [], film.id);
    assert.equal(report.entries, report.oxford + report.word + report.term);
    assert.ok(film.entries.slice(0, -1).every((entry, i) => entry.uses[0] + entry.uses[1] >= film.entries[i + 1].uses[0] + film.entries[i + 1].uses[1]),
      `${film.id}: mode queue goes from the most used words to the rarest`);
  }
});

test('A new word of two films is one card with shared progress', () => {
  const duneIds = new Set(dune.cards.map((card) => card.id));
  const shared = zootopia.cards.filter((card) => duneIds.has(card.id));
  assert.ok(shared.some((card) => card.word === 'weird'));
  assert.deepEqual(validateSharedCards([dune, zootopia]), []);
  const changed = structuredClone(zootopia);
  changed.cards.find((card) => card.id === shared[0].id).translation = 'другое';
  assert.equal(validateSharedCards([dune, changed]).length, 1);
});

test('Film validation rejects broken cards and entries', () => {
  const film = structuredClone(dune);
  const term = film.cards.find((card) => card.kind === 'term');
  delete term.note;
  film.cards.push({ ...film.cards[1], id: words[0].id });
  film.entries.push({ id: 'missing', uses: [0, 0], weight: [0] });
  const { errors } = validateFilm(film, words);
  assert.ok(errors.some((error) => error.includes('пояснение')));
  assert.ok(errors.some((error) => error.includes('совпадает с карточкой Oxford')));
  assert.ok(errors.some((error) => error.includes('неизвестная карточка')));
  assert.ok(errors.some((error) => error.includes('weight')));
  assert.ok(errors.some((error) => error.includes('не встречается')));
});

const NOW = new Date(2026, 9, 30, 12).getTime();
const oxford: Word[] = [
  { id: 'cat', word: 'cat', translation: 'кошка', pos: 'сущ.', level: 'A1' },
  { id: 'dog', word: 'dog', translation: 'собака', pos: 'сущ.', level: 'A1' },
  { id: 'throne', word: 'throne', translation: 'трон', pos: 'сущ.', level: 'B2' },
];
const film = loadFilm({
  id: 'dune', title: 'Дюна', titleEn: 'Dune',
  parts: [{ id: 'part1', title: 'Часть 1', film: 'Dune' }, { id: 'part2', title: 'Часть 2', film: 'Dune 2' }],
  cards: [
    { id: 'dune-spice', word: 'spice', translation: 'пряность', pos: 'сущ.', kind: 'term', note: 'Вещество Арракиса.' },
    { id: 'dune-worm', word: 'worm', translation: 'червь', pos: 'сущ.', kind: 'word' },
  ],
  entries: [
    { id: 'dune-spice', uses: [5, 4], weight: [5, 4] },
    { id: 'throne', uses: [2, 0], weight: [2, 0] },
    { id: 'cat', uses: [0, 1], weight: [0, 1] },
    { id: 'dune-worm', uses: [0, 1], weight: [0, 1] },
  ],
});
const queueIds = (state: AppState, at = NOW) => getStudyQueue(oxford, state, at, [film]).map((word) => word.id);
const answer = (state: AppState, id: string, rating: Rating, at: number) => {
  state.cards[id] = scheduleCard(state.cards[id], rating, at);
  state.reviews.push({ wordId: id, at, rating, isNew: state.reviews.every((review) => review.wordId !== id) });
};

test('An active film mode takes the new-word limit first, ignores levels and then falls back to Oxford', () => {
  const state = defaultState();
  state.settings.levels = ['A1'];
  state.settings.dailyNewLimit = 3;
  assert.deepEqual(queueIds(state), ['cat', 'dog']);
  state.settings.film = 'dune';
  assert.deepEqual(queueIds(state), ['dune-spice', 'throne', 'cat']);
  state.settings.dailyNewLimit = 10;
  assert.deepEqual(getNewWords(oxford, state, [film]).map((word) => word.id), ['dune-spice', 'throne', 'cat', 'dune-worm', 'dog']);
  answer(state, 'dune-spice', 'good', NOW);
  assert.deepEqual(queueIds(state), ['throne', 'cat', 'dune-worm', 'dog']);
});

test('Turning the mode off pauses film cards and keeps their progress', () => {
  const state = defaultState();
  state.settings.film = 'dune';
  answer(state, 'dune-worm', 'again', NOW);
  answer(state, 'throne', 'again', NOW);
  const later = NOW + 120_000;
  assert.ok(queueIds(state, later).includes('dune-worm'));
  state.settings.film = null;
  state.settings.levels = ['A1'];
  assert.ok(!queueIds(state, later).includes('dune-worm'));
  assert.ok(!queueIds(state, later).includes('throne'), 'Oxford cards outside the selected levels follow the usual rules');
  assert.ok(state.cards['dune-worm']);
  state.settings.film = 'dune';
  assert.deepEqual(queueIds(state, later).slice(0, 2), ['dune-worm', 'throne']);
});

test('Film progress counts the latest «Помню»/«Легко» answers by words, speech and part', () => {
  const state = defaultState();
  answer(state, 'dune-spice', 'good', NOW);
  answer(state, 'cat', 'easy', NOW);
  answer(state, 'throne', 'hard', NOW);
  let progress = getFilmProgress(film, state);
  assert.deepEqual(progress.words, { learned: 2, total: 4 });
  assert.deepEqual(progress.speech, { learned: 10, total: 13 });
  assert.deepEqual(progress.parts.map((part) => part.words), [{ learned: 1, total: 2 }, { learned: 2, total: 3 }]);
  assert.equal(progress.newNotStarted, 1);
  assert.equal(percent(progress.speech), 76);
  answer(state, 'dune-spice', 'again', NOW + 1);
  progress = getFilmProgress(film, state);
  assert.deepEqual(progress.words, { learned: 1, total: 4 });
});

test('Backups keep the chosen mode, and older backups start without one', () => {
  const ids = new Set(['cat', 'dune-spice']);
  const state = defaultState();
  state.settings.film = 'dune';
  answer(state, 'dune-spice', 'good', NOW);
  assert.equal(parseBackup(JSON.stringify(state), ids).settings.film, 'dune');
  const old = structuredClone(state) as { settings: Record<string, unknown> };
  delete old.settings.film;
  assert.equal(parseBackup(JSON.stringify(old), ids).settings.film, null);
  assert.throws(() => parseBackup(JSON.stringify({ ...state, settings: { ...state.settings, film: 7 } }), ids), /мод фильма/);
});
