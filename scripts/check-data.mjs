import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS } from '../src/lib/topics.ts';

const expectedLevels = { A1: 900, A2: 800, B1: 700, B2: 600 };
const requiredFields = ['id', 'word', 'translation', 'level', 'pos'];
const allowedFields = new Set([...requiredFields, 'phonetic', 'example', 'exampleTranslation']);
const isText = value => typeof value === 'string' && value.trim().length > 0;

/** Check structure, not translation quality. Repeated spellings may be distinct senses. */
export function validateVocabulary(data) {
  const errors = [];
  const counts = { A1: 0, A2: 0, B1: 0, B2: 0 };
  const ids = new Set();
  const spellings = new Set();
  let examples = 0;
  if (!Array.isArray(data)) return { errors: ['Корень JSON должен быть массивом карточек.'], report: null };
  if (data.length !== 3000) errors.push(`Ожидалось 3000 карточек, получено ${data.length}.`);

  data.forEach((card, index) => {
    const label = `Карточка ${index + 1}`;
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      errors.push(`${label}: ожидается объект.`);
      return;
    }
    for (const field of requiredFields) {
      if (!Object.hasOwn(card, field)) errors.push(`${label}: отсутствует обязательное поле ${field}.`);
    }
    for (const [field, value] of Object.entries(card)) {
      if (!allowedFields.has(field)) errors.push(`${label}: неизвестное поле ${field}.`);
      if (!isText(value)) errors.push(`${label}: ${field} должно быть непустой строкой.`);
    }
    if (isText(card.id)) {
      if (ids.has(card.id)) errors.push(`${label}: повторяющийся id «${card.id}».`);
      ids.add(card.id);
      if (card.id !== card.id.trim()) errors.push(`${label}: id содержит пробелы по краям.`);
      if (['__proto__', 'constructor', 'prototype'].includes(card.id)) errors.push(`${label}: недопустимый id.`);
    }
    if (isText(card.word)) spellings.add(card.word);
    if (isText(card.translation) && !/\p{Script=Cyrillic}/u.test(card.translation)) {
      errors.push(`${label}: перевод не содержит кириллицы.`);
    }
    if (typeof card.level === 'string' && Object.hasOwn(counts, card.level)) counts[card.level]++;
    else errors.push(`${label}: допустимые уровни — A1, A2, B1, B2.`);
    if (isText(card.example)) examples++;
  });

  for (const [level, expected] of Object.entries(expectedLevels)) {
    if (counts[level] !== expected) errors.push(`${level}: ожидалось ${expected} карточек закреплённой редакции, получено ${counts[level]}.`);
  }
  if (ids.size !== 3000) errors.push(`Ожидалось 3000 уникальных id, получено ${ids.size}.`);
  return { errors, report: { cards: data.length, uniqueIds: ids.size, uniqueSpellings: spellings.size, levels: counts, examples } };
}

/** Themes cover exact card ids so different senses can belong to different groups. */
export function validateTopicAssignments(words, assignments) {
  const errors = [];
  const counts = Object.fromEntries(TOPICS.map((topic) => [topic.id, 0]));
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
    return { errors: ['Тематическая разметка должна быть объектом id → тема.'], report: null };
  }
  const ids = new Set(words.map((word) => word.id));
  for (const word of words) {
    if (!Object.hasOwn(assignments, word.id)) errors.push(`Не назначена тема: ${word.word} (${word.id}).`);
  }
  for (const [id, topic] of Object.entries(assignments)) {
    if (!ids.has(id)) errors.push(`Неизвестная карточка в тематической разметке: ${id}.`);
    if (typeof topic !== 'string' || !Object.hasOwn(counts, topic)) {
      errors.push(`Неизвестная тема у карточки ${id}.`);
    } else counts[topic]++;
  }
  return { errors, report: { assigned: Object.keys(assignments).length, topics: counts } };
}

const filmCardFields = new Set(['id', 'word', 'translation', 'pos', 'example', 'note', 'kind']);
const isCount = value => Number.isInteger(value) && value >= 0;

/** A film mode: its new cards plus entries that point to Oxford or film cards with per-part counts. */
/** A new word shared by several films is one card: the same id must carry the same texts everywhere. */
export function validateSharedCards(films) {
  const errors = [];
  const seen = new Map();
  for (const film of films) {
    for (const card of film.cards ?? []) {
      const text = JSON.stringify(card);
      const first = seen.get(card.id);
      if (first && first.text !== text) errors.push(`Карточка ${card.id} различается в фильмах ${first.film} и ${film.id}.`);
      if (!first) seen.set(card.id, { film: film.id, text });
    }
  }
  return errors;
}

export function validateFilm(film, words) {
  const errors = [];
  if (!film || typeof film !== 'object' || Array.isArray(film)) return { errors: ['Набор фильма должен быть объектом.'], report: null };
  const label = `Фильм ${film.id}`;
  if (!isText(film.id) || !isText(film.title) || !isText(film.titleEn)) errors.push(`${label}: нужны id, title и titleEn.`);
  const parts = Array.isArray(film.parts) ? film.parts.length : 0;
  if (!parts || !film.parts.every(part => isText(part?.id) && isText(part?.title))) errors.push(`${label}: части должны иметь id и title.`);
  const oxford = new Set(words.map(word => word.id));
  const cards = new Set();
  const counts = { word: 0, term: 0 };
  for (const card of Array.isArray(film.cards) ? film.cards : []) {
    const name = `${label}, карточка ${card?.word ?? card?.id}`;
    for (const field of ['id', 'word', 'translation', 'pos', 'example', 'kind']) {
      if (!isText(card?.[field])) errors.push(`${name}: поле ${field} должно быть непустой строкой.`);
    }
    for (const field of Object.keys(card ?? {})) if (!filmCardFields.has(field)) errors.push(`${name}: неизвестное поле ${field}.`);
    if (!Object.hasOwn(counts, card?.kind)) errors.push(`${name}: kind — word или term.`);
    else counts[card.kind]++;
    if ((card?.kind === 'term') !== isText(card?.note)) errors.push(`${name}: пояснение есть только у термина и обязательно для него.`);
    if (isText(card?.translation) && !/\p{Script=Cyrillic}/u.test(card.translation)) errors.push(`${name}: перевод не содержит кириллицы.`);
    if (cards.has(card?.id) || oxford.has(card?.id)) errors.push(`${name}: id повторяется или совпадает с карточкой Oxford.`);
    cards.add(card?.id);
  }
  const entries = new Set();
  for (const entry of Array.isArray(film.entries) ? film.entries : []) {
    const name = `${label}, запись ${entry?.id}`;
    if (!oxford.has(entry?.id) && !cards.has(entry?.id)) errors.push(`${name}: неизвестная карточка.`);
    if (entries.has(entry?.id)) errors.push(`${name}: карточка повторяется.`);
    entries.add(entry?.id);
    for (const field of ['uses', 'weight']) {
      const value = entry?.[field];
      if (!Array.isArray(value) || value.length !== parts || !value.every(isCount)) errors.push(`${name}: ${field} — по неотрицательному целому на каждую часть.`);
    }
    if (Array.isArray(entry?.uses) && !entry.uses.some(count => count > 0)) errors.push(`${name}: слово не встречается в фильме.`);
  }
  for (const id of cards) if (!entries.has(id)) errors.push(`${label}: карточка ${id} не входит в записи мода.`);
  return { errors, report: { entries: entries.size, oxford: entries.size - cards.size, ...counts } };
}

async function main() {
  const path = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../src/data/oxford3000.json', import.meta.url));
  try {
    const words = JSON.parse(await readFile(path, 'utf8'));
    const { errors, report } = validateVocabulary(words);
    if (errors.length) {
      console.error(`Проверка словаря не пройдена: ${errors.length} ${errors.length === 1 ? 'ошибка' : 'ошибок'}.`);
      errors.slice(0, 25).forEach(error => console.error(`- ${error}`));
      if (errors.length > 25) console.error(`… ещё ${errors.length - 25} ошибок.`);
      process.exitCode = 1;
      return;
    }
    const assignments = JSON.parse(await readFile(new URL('../src/data/word-topics.json', import.meta.url), 'utf8'));
    const topics = validateTopicAssignments(words, assignments);
    if (topics.errors.length) throw new Error(topics.errors.slice(0, 25).join('\n'));
    console.log(`Словарь проверен: ${report.cards} карточек, ${report.uniqueIds} уникальных id.`);
    console.log(`CEFR: ${Object.entries(report.levels).map(([level, count]) => `${level} — ${count}`).join('; ')}.`);
    console.log(`Различных написаний: ${report.uniqueSpellings}. Повторяющиеся написания допустимы для отдельных значений.`);
    console.log(`Карточек с примерами: ${report.examples}. Все переводы непустые и содержат кириллицу.`);
    console.log(`Темы: ${topics.report.assigned} назначений, ${TOPICS.length} тематических групп.`);
    const filmsDir = new URL('../src/data/films/', import.meta.url);
    const films = [];
    for (const file of (await readdir(filmsDir)).filter(name => name.endsWith('.json')).sort()) {
      const film = JSON.parse(await readFile(new URL(file, filmsDir), 'utf8'));
      films.push(film);
      const checked = validateFilm(film, words);
      if (checked.errors.length) throw new Error(checked.errors.slice(0, 25).join('\n'));
      const { entries, oxford, word, term } = checked.report;
      console.log(`Фильм «${film.title}»: ${entries} карточек в моде — Oxford ${oxford}, новых слов ${word}, терминов ${term}.`);
    }
    const shared = validateSharedCards(films);
    if (shared.length) throw new Error(shared.slice(0, 25).join('\n'));
    console.log('Структура данных проверена. Лингвистическая точность переводов этой проверкой не оценивается.');
  } catch (error) {
    console.error(`Не удалось проверить словарь: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
