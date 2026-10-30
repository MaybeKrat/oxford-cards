"""Records every card word with the Microsoft neural voices into public/voices/<voice>/<key>.mp3.

The recordings are not kept in git: run this script before `npm run build:exe`. Existing files are
skipped, so a rerun only fills the gaps. Needs the `edge-tts` package and internet access.

    python scripts/build-voices.py            # record missing words
    python scripts/build-voices.py --check    # report missing recordings only
"""
import asyncio
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "src" / "data"
OUT = ROOT / "public" / "voices"
# Keep in sync with src/lib/voices.ts.
VOICES = {"ryan": "en-GB-RyanNeural", "sonia": "en-GB-SoniaNeural"}
RATE = "-10%"
CONCURRENCY = 6


def recording_key(text: str) -> str:
    # The app looks recordings up by the spoken text, the same way in src/lib/voices.ts.
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def texts() -> list[str]:
    cards = json.loads((DATA / "oxford3000.json").read_text(encoding="utf-8"))
    for path in sorted((DATA / "films").glob("*.json")):
        cards += json.loads(path.read_text(encoding="utf-8"))["cards"]
    return sorted({card["word"].strip() for card in cards})


def missing() -> list[tuple[str, str, Path]]:
    return [(voice, text, OUT / voice / f"{recording_key(text)}.mp3")
            for voice in VOICES for text in texts()
            if not (OUT / voice / f"{recording_key(text)}.mp3").exists()]


async def record(jobs: list[tuple[str, str, Path]]) -> int:
    import edge_tts
    queue: asyncio.Queue = asyncio.Queue()
    for job in jobs:
        queue.put_nowait(job)
    failed = []
    done = 0

    async def worker():
        nonlocal done
        while not queue.empty():
            voice, text, path = queue.get_nowait()
            path.parent.mkdir(parents=True, exist_ok=True)
            for attempt in range(4):
                try:
                    partial = path.with_suffix(".part")
                    await edge_tts.Communicate(text, VOICES[voice], rate=RATE).save(str(partial))
                    if partial.stat().st_size < 1000:
                        raise RuntimeError("empty recording")
                    partial.replace(path)
                    break
                except Exception:  # noqa: BLE001 - network errors are retried, then reported
                    await asyncio.sleep(2 * (attempt + 1))
            else:
                failed.append((voice, text))
            done += 1
            if done % 200 == 0:
                print(f"{done}/{len(jobs)}", flush=True)

    await asyncio.gather(*(worker() for _ in range(CONCURRENCY)))
    for voice, text in failed:
        print(f"failed: {voice} {text!r}")
    return len(failed)


if __name__ == "__main__":
    gaps = missing()
    total = len(texts()) * len(VOICES)
    if "--check" in sys.argv:
        print(f"voices: {total - len(gaps)}/{total} recordings present")
        sys.exit(1 if gaps else 0)
    print(f"recording {len(gaps)} of {total}", flush=True)
    sys.exit(1 if asyncio.run(record(gaps)) else 0)
