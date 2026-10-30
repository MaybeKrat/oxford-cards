export type Level = 'A1' | 'A2' | 'B1' | 'B2';
export type Rating = 'again' | 'hard' | 'good' | 'easy';
export type ThemePreference = 'system' | 'light' | 'dark';

export interface Word {
  id: string;
  word: string;
  translation: string;
  /** Oxford CEFR level; film cards outside Oxford 3000 have none. */
  level?: Level;
  pos: string;
  phonetic?: string;
  example?: string;
  exampleTranslation?: string;
  /** Independent thematic grouping; does not change the Oxford card id or level. */
  topic?: string;
  /** Film mode that owns a card outside Oxford 3000. */
  film?: string;
  kind?: 'word' | 'term';
  /** Explanation of a film term. */
  note?: string;
}

export interface FilmEntry {
  /** Oxford card or film card id. */
  id: string;
  /** Uses in each part of the film. */
  uses: number[];
  /** Words of speech in each part; larger than uses for multi-word terms. */
  weight: number[];
}

export interface Film {
  id: string;
  title: string;
  /** Original English title. */
  titleEn: string;
  parts: { id: string; title: string; film: string }[];
  /** Cards outside Oxford 3000. */
  cards: Word[];
  /** All cards of the mode, most used first. */
  entries: FilmEntry[];
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

/** Recorded voice of the desktop app; see src/lib/voices.ts. */
export type Voice = 'ryan' | 'sonia';

export interface Settings {
  dailyNewLimit: number;
  levels: Level[];
  direction: 'en-ru' | 'ru-en';
  autoSpeak: boolean;
  theme: ThemePreference;
  /** Active film mode id, or null without a mode. */
  film: string | null;
  voice: Voice;
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
