import { readFile } from 'node:fs/promises';
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
    console.log('Структура данных проверена. Лингвистическая точность переводов этой проверкой не оценивается.');
  } catch (error) {
    console.error(`Не удалось проверить словарь: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
