import type { Word } from './types.ts';

/** Our learning sequence, independent of the official Oxford CEFR list. */
export const TOPICS = [
  { id: 'people', name: 'Люди и семья' },
  { id: 'home', name: 'Дом и быт' },
  { id: 'food', name: 'Еда и напитки' },
  { id: 'clothes', name: 'Одежда и внешность' },
  { id: 'health', name: 'Тело и здоровье' },
  { id: 'daily', name: 'Повседневные дела' },
  { id: 'time', name: 'Числа и время' },
  { id: 'city', name: 'Город и места' },
  { id: 'travel', name: 'Путешествия и транспорт' },
  { id: 'shopping', name: 'Покупки и деньги' },
  { id: 'work', name: 'Работа и бизнес' },
  { id: 'study', name: 'Учёба и языки' },
  { id: 'communication', name: 'Общение и информация' },
  { id: 'technology', name: 'Технологии и наука' },
  { id: 'nature', name: 'Природа и погода' },
  { id: 'animals', name: 'Животные и растения' },
  { id: 'sport', name: 'Спорт и отдых' },
  { id: 'culture', name: 'Искусство и культура' },
  { id: 'feelings', name: 'Чувства и характер' },
  { id: 'society', name: 'Общество и власть' },
  { id: 'law', name: 'Закон и безопасность' },
  { id: 'ideas', name: 'Мысли и решения' },
  { id: 'qualities', name: 'Свойства и материалы' },
  { id: 'space', name: 'Пространство и движение' },
  { id: 'events', name: 'События и перемены' },
  { id: 'language', name: 'Слова для связи' },
] as const;

const topicOrder = new Map<string, number>(TOPICS.map((topic, index) => [topic.id, index]));
const topicNames = new Map<string, string>(TOPICS.map((topic) => [topic.id, topic.name]));
const levelOrder = ['A1', 'A2', 'B1', 'B2'];

export function getTopicName(topic: string | undefined): string {
  return topicNames.get(topic ?? '') ?? 'Oxford 3000';
}

/** Sort the catalog once; the scheduler still prioritizes due reviews and skips known cards. */
export function orderWordsForStudy(words: readonly Word[]): Word[] {
  return [...words].sort((a, b) =>
    levelOrder.indexOf(a.level) - levelOrder.indexOf(b.level)
    || (topicOrder.get(a.topic ?? '') ?? TOPICS.length) - (topicOrder.get(b.topic ?? '') ?? TOPICS.length)
    || a.word.localeCompare(b.word, 'en')
    || a.id.localeCompare(b.id, 'en'),
  );
}
