import type { AppState, Film, Rating, Word } from './types.ts';

/** Bundled film data (src/data/films/*.json) with each card marked by its film. */
export function loadFilm(raw: Omit<Film, 'cards'> & { cards: Omit<Word, 'film'>[] }): Film {
  return { ...raw, cards: raw.cards.map((card) => ({ ...card, film: raw.id })) };
}

export function getActiveFilm(films: readonly Film[], state: AppState): Film | undefined {
  return films.find((film) => film.id === state.settings.film);
}

/** Film cards stay in progress while their mode is off, but are hidden from the queue and the dictionary. */
export function getVisibleFilmCards(films: readonly Film[], state: AppState): Word[] {
  return getActiveFilm(films, state)?.cards ?? [];
}

export interface Share {
  learned: number;
  total: number;
}

export interface FilmProgress {
  /** Distinct cards of the mode; every card counts once. */
  words: Share;
  /** Words of speech; frequent cards weigh more. */
  speech: Share;
  /** The same shares for each part; a card used in both parts counts in both. */
  parts: { title: string; words: Share; speech: Share }[];
  /** Film cards outside Oxford 3000 that were never answered. */
  newNotStarted: number;
}

function lastRatings(state: AppState): Map<string, Rating> {
  const last = new Map<string, { at: number; rating: Rating }>();
  for (const review of state.reviews) {
    const previous = last.get(review.wordId);
    if (!previous || review.at >= previous.at) last.set(review.wordId, { at: review.at, rating: review.rating });
  }
  return new Map([...last].map(([id, { rating }]) => [id, rating]));
}

/** A card counts as learned while its latest answer is «Помню» or «Легко». */
export function learnedCheck(state: AppState): (id: string) => boolean {
  const ratings = lastRatings(state);
  return (id) => {
    const rating = ratings.get(id);
    // Progress without history (an old manual backup) falls back to the scheduled state.
    if (!rating) return state.cards[id]?.state === 'review';
    return rating === 'good' || rating === 'easy';
  };
}

export function getFilmProgress(film: Film, state: AppState): FilmProgress {
  const learned = learnedCheck(state);
  const share = (part?: number) => {
    const words = { learned: 0, total: 0 };
    const speech = { learned: 0, total: 0 };
    for (const entry of film.entries) {
      const uses = part === undefined ? entry.uses.reduce((a, b) => a + b, 0) : entry.uses[part];
      const weight = part === undefined ? entry.weight.reduce((a, b) => a + b, 0) : entry.weight[part];
      if (!uses) continue;
      const known = learned(entry.id);
      words.total++;
      speech.total += weight;
      if (known) {
        words.learned++;
        speech.learned += weight;
      }
    }
    return { words, speech };
  };
  return {
    ...share(),
    parts: film.parts.map((part, index) => ({ title: part.title, ...share(index) })),
    newNotStarted: film.cards.filter((card) => !state.cards[card.id]).length,
  };
}

export function percent({ learned, total }: Share): number {
  return total ? Math.floor((learned / total) * 100) : 0;
}
