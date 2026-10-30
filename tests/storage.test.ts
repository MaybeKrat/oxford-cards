import assert from 'node:assert/strict';
import test from 'node:test';
import { addExtraNewWords, defaultState, getDailyNewLimit, MAX_DAILY_EXTRA, scheduleCard } from '../src/lib/scheduler.ts';
import { parseBackup, readState, STORAGE_KEY, writeState } from '../src/lib/storage.ts';
import type { StorageLike } from '../src/lib/storage.ts';

const NOW = new Date(2026, 9, 25, 12).getTime();
const IDS = new Set(['apple', 'book']);

function fixture() {
  const state = defaultState();
  state.cards.apple = scheduleCard(undefined, 'good', NOW);
  state.reviews = [{ wordId: 'apple', at: NOW, rating: 'good', isNew: true }];
  return state;
}

function memoryStorage(): StorageLike {
  const saved = new Map<string, string>();
  return { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); } };
}

test('Storage round-trip and validated import preserve all progress and settings', () => {
  const storage = memoryStorage();
  assert.deepEqual(readState(storage), defaultState());
  const state = fixture();
  state.settings.direction = 'ru-en';
  writeState(state, storage);
  assert.deepEqual(readState(storage, IDS), state);
  assert.deepEqual(parseBackup(storage.getItem(STORAGE_KEY)!, IDS), state);
});

test('Today-only allowance survives saving, reopening and backup import', () => {
  const storage = memoryStorage();
  const state = addExtraNewWords(fixture(), 10, NOW);
  writeState(state, storage);
  const reopened = readState(storage, IDS);
  assert.deepEqual(reopened, state);
  assert.deepEqual(parseBackup(storage.getItem(STORAGE_KEY)!, IDS), state);
  assert.equal(getDailyNewLimit(reopened, NOW), 30);
  assert.equal(getDailyNewLimit(reopened, new Date(2026, 9, 26, 0, 1).getTime()), 20);
  assert.equal(reopened.settings.dailyNewLimit, 20);
});

test('Legacy settings adopt the system theme while preserving all learning data', () => {
  const original = addExtraNewWords(fixture(), 10, NOW);
  const legacy = JSON.parse(JSON.stringify(original));
  delete legacy.settings.theme;
  const raw = JSON.stringify(legacy);
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, raw);
  assert.deepEqual(readState(storage, IDS), original);
  assert.deepEqual(parseBackup(raw, IDS), original);
  assert.equal(storage.getItem(STORAGE_KEY), raw, 'Reading old data must not rewrite it');
});

test('Theme choices survive backups and invalid themes never overwrite progress', () => {
  const storage = memoryStorage();
  const state = fixture();
  for (const theme of ['system', 'light', 'dark'] as const) {
    state.settings.theme = theme;
    writeState(state, storage);
    assert.deepEqual(readState(storage, IDS), state);
    assert.deepEqual(parseBackup(storage.getItem(STORAGE_KEY)!, IDS), state);
  }
  const saved = storage.getItem(STORAGE_KEY);
  for (const theme of [null, '', 'auto', 'DARK', true, 1, ['dark'], {}]) {
    const broken = { ...state, settings: { ...state.settings, theme } };
    assert.throws(() => parseBackup(JSON.stringify(broken), IDS), /тема оформления/);
    assert.equal(storage.getItem(STORAGE_KEY), saved);
  }
});

test('Version 1 backups without an extra allowance remain unchanged and usable', () => {
  const original = fixture();
  const imported = parseBackup(JSON.stringify(original), IDS);
  assert.deepEqual(imported, original);
  assert.equal(Object.hasOwn(imported, 'dailyExtra'), false);
  assert.equal(getDailyNewLimit(imported, NOW), 20);
});

test('Extra allowance requires an exact calendar day and positive bounded whole count', () => {
  const invalidExtras = [
    null, [], 'today', {}, { count: 10 }, { day: '2026-10-25' },
    ...['2026-2-01', '26-10-25', '2026-10-25T00:00:00Z', '2026-10-25 ',
      '2026-00-25', '2026-13-25', '2026-10-00', '2026-10-32', '2026-02-29', '2024-02-30',
    ].map((day) => ({ day, count: 10 })),
    ...[null, '10', NaN, Infinity, -1, 0, 0.5, MAX_DAILY_EXTRA + 1]
      .map((count) => ({ day: '2026-10-25', count })),
  ];
  const storage = memoryStorage();
  const original = fixture();
  writeState(original, storage);
  for (const dailyExtra of invalidExtras) {
    const raw = JSON.stringify({ ...original, dailyExtra });
    assert.throws(() => parseBackup(raw, IDS), /дополнительный лимит/, raw);
    assert.deepEqual(readState(storage, IDS), original);
  }
  const leapDay = parseBackup(JSON.stringify({ ...original, dailyExtra: { day: '2024-02-29', count: MAX_DAILY_EXTRA } }), IDS);
  assert.deepEqual(leapDay.dailyExtra, { day: '2024-02-29', count: MAX_DAILY_EXTRA });
  const broken = addExtraNewWords(original, 10, NOW);
  broken.dailyExtra!.count = 0;
  assert.throws(() => writeState(broken, storage), /дополнительный лимит/);
  assert.deepEqual(readState(storage, IDS), original);
});

test('Import rejects malformed JSON, wrong versions, unknown words, and unsafe keys', () => {
  assert.throws(() => parseBackup('{', IDS), /JSON/);
  assert.throws(() => parseBackup(JSON.stringify({ ...fixture(), version: 2 }), IDS), /версия/);
  assert.throws(() => parseBackup(JSON.stringify(fixture()), new Set(['book'])), /неизвестная карточка/);
  const state = fixture();
  state.reviews[0]!.wordId = 'unrecognized';
  assert.throws(() => parseBackup(JSON.stringify(state), IDS), /истории/);
  const raw = JSON.stringify(fixture()).replace('"apple":', '"__proto__":');
  assert.throws(() => parseBackup(raw, IDS));
  assert.equal(({} as Record<string, unknown>).due, undefined);
});

test('Import rejects NaN, negative and out-of-range schedule values and inconsistent dates', () => {
  const corruptions: Record<string, unknown>[] = [
    { interval: NaN }, { interval: -1 }, { interval: 36_501 }, { ease: 1.2 }, { ease: 6 },
    { repetitions: -1 }, { lapses: 0.5 }, { due: -1 }, { due: 9e15 }, { due: NOW - 1 },
    { startedAt: NOW + 1 }, { state: ['review'] }, { state: 'unknown' },
  ];
  for (const values of corruptions) {
    const state = fixture();
    Object.assign(state.cards.apple!, values);
    assert.throws(() => parseBackup(JSON.stringify(state), IDS), `Expected rejection for ${JSON.stringify(values)}`);
  }
});

test('Import rejects invalid settings and review logs without partially changing storage', () => {
  for (const settings of [
    { dailyNewLimit: -1 }, { dailyNewLimit: 201 }, { dailyNewLimit: 1.5 },
    { levels: [] }, { levels: ['A1', 'A1'] }, { levels: ['C2'] },
    { direction: ['en-ru'] }, { autoSpeak: 'true' },
  ]) {
    const state = fixture();
    Object.assign(state.settings, settings);
    assert.throws(() => parseBackup(JSON.stringify(state), IDS), /настройки/);
  }
  const storage = memoryStorage();
  const state = fixture();
  writeState(state, storage);
  const broken = fixture();
  broken.reviews[0]!.at = -1;
  assert.throws(() => writeState(broken, storage));
  assert.deepEqual(readState(storage), state);
  const arrayRating = fixture();
  Object.assign(arrayRating.reviews[0]!, { rating: ['good'] });
  assert.throws(() => parseBackup(JSON.stringify(arrayRating), IDS));
});

test('Storage access errors are visible to the UI and corrupted data is not overwritten', () => {
  const blocked: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
  assert.throws(() => readState(blocked), /прочитать/);
  assert.throws(() => writeState(fixture(), blocked), /сохранить/);
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, 'corrupted original');
  assert.throws(() => readState(storage), /JSON/);
  assert.equal(storage.getItem(STORAGE_KEY), 'corrupted original');
});

test('The chosen voice survives backups; older backups get Ryan and unknown voices are rejected', () => {
  const state = fixture();
  state.settings.voice = 'sonia';
  assert.equal(parseBackup(JSON.stringify(state), IDS).settings.voice, 'sonia');
  const legacy = structuredClone(state) as { settings: Record<string, unknown> };
  delete legacy.settings.voice;
  assert.equal(parseBackup(JSON.stringify(legacy), IDS).settings.voice, 'ryan');
  for (const voice of [null, '', 'david', 'Ryan', 1]) {
    assert.throws(() => parseBackup(JSON.stringify({ ...state, settings: { ...state.settings, voice } }), IDS), /голос озвучки/);
  }
});
