export type Level = 'A1' | 'A2' | 'B1' | 'B2';
export type Rating = 'again' | 'hard' | 'good' | 'easy';

export interface Word {
  id: string;
  word: string;
  translation: string;
  level: Level;
  pos: string;
  phonetic?: string;
  example?: string;
  exampleTranslation?: string;
}

export interface CardProgress {
  /** UTC timestamp in milliseconds. */
  due: number;
  /** Interval in days; one minute is 1 / 1440. */
  interval: number;
  ease: number;
  repetitions: number;
  lapses: number;
  lastReviewed: number;
  startedAt: number;
  state: 'learning' | 'review' | 'relearning';
}

export interface Settings {
  dailyNewLimit: number;
  levels: Level[];
  direction: 'en-ru' | 'ru-en';
  autoSpeak: boolean;
}

export interface ReviewLog {
  wordId: string;
  at: number;
  rating: Rating;
  isNew: boolean;
}

export interface AppState {
  version: 1;
  cards: Record<string, CardProgress>;
  reviews: ReviewLog[];
  settings: Settings;
  /** Additional new words allowed on this local calendar date only. */
  dailyExtra?: { day: string; count: number };
}

export interface StudyStats {
  due: number;
  newAvailable: number;
  learning: number;
  learned: number;
  reviewedToday: number;
  streak: number;
  started: number;
  total: number;
}
