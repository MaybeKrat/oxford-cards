import type { CardProgress } from './types.ts';

export const MAX_TIMESTAMP = 8_640_000_000_000_000;
export const MAX_INTERVAL = 36_500;
export const MAX_COUNTER = 1_000_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function finiteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function timestamp(value: unknown): value is number {
  return finiteRange(value, 0, MAX_TIMESTAMP) && Number.isInteger(value);
}

export function counter(value: unknown): value is number {
  return finiteRange(value, 0, MAX_COUNTER) && Number.isInteger(value);
}

export function validCard(value: unknown): value is CardProgress {
  if (!isRecord(value)) return false;
  return timestamp(value.due)
    && timestamp(value.lastReviewed)
    && timestamp(value.startedAt)
    && value.startedAt <= value.lastReviewed
    && value.lastReviewed <= value.due
    && finiteRange(value.interval, 1 / 1440, MAX_INTERVAL)
    && finiteRange(value.ease, 1.3, 5)
    && counter(value.repetitions)
    && counter(value.lapses)
    && typeof value.state === 'string' && ['learning', 'review', 'relearning'].includes(value.state);
}
