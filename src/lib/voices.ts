import type { Voice } from './types.ts';

/** Recorded voices bundled with the app; keep in sync with scripts/build-voices.py. */
export const voices: readonly { id: Voice; name: string; note: string }[] = [
  { id: 'ryan', name: 'Ryan', note: 'британский, мужской' },
  { id: 'sonia', name: 'Sonia', note: 'британский, женский' },
];

export function isVoice(value: unknown): value is Voice {
  return voices.some((voice) => voice.id === value);
}

/** File name of a recording: the first 16 hex digits of SHA-256 of the spoken text. */
export async function recordingKey(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A bundled recording, or null when the word has none and the system voice should speak. */
export async function loadRecording(voice: Voice, text: string, fetcher: typeof fetch = fetch): Promise<ArrayBuffer | null> {
  try {
    const response = await fetcher(`voices/${voice}/${await recordingKey(text.trim())}.mp3`);
    return response.ok ? await response.arrayBuffer() : null;
  } catch {
    return null;
  }
}
