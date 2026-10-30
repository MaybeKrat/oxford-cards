"""Build the bundled film modes from their committed sources without network access.

python scripts/build-films.py
python scripts/build-films.py --check

Sources per film in src/data/sources/films/:
- <film>-selection.json — Oxford cards and new words of the film with counts per part
  (generated from the transcripts outside the repository, see DATA-SOURCES.md);
- <film>-cards.json — translations, examples and term notes for the new words (edited by hand).
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "src" / "data"
SOURCES = DATA / "sources" / "films"
FILMS = {
    "dune": {
        "title": "Дюна",
        "parts": [
            {"id": "part1", "title": "Часть 1", "film": "Dune (2021)"},
            {"id": "part2", "title": "Часть 2", "film": "Dune: Part Two (2024)"},
        ],
    },
}
CARD_FIELDS = ("word", "pos", "translation", "example", "note")


def json_text(film: dict) -> str:
    # Cards are written out for review; mode entries take one line each.
    head = {k: v for k, v in film.items() if k != "entries"}
    text = json.dumps(head, ensure_ascii=False, indent=2)[:-2]
    rows = ",\n".join("    " + json.dumps(entry, ensure_ascii=False) for entry in film["entries"])
    return text + ',\n  "entries": [\n' + rows + "\n  ]\n}\n"


def card_id(film: str, key: str) -> str:
    # Stable across edits of translations and counts: depends on the film and the source key only.
    return f"{film}-" + hashlib.sha256(f"{film}\0{key}".encode("utf-8")).hexdigest()[:16]


def build(film: str) -> dict:
    selection = json.loads((SOURCES / f"{film}-selection.json").read_text(encoding="utf-8"))
    texts = json.loads((SOURCES / f"{film}-cards.json").read_text(encoding="utf-8"))
    oxford = {card["id"] for card in json.loads((DATA / "oxford3000.json").read_text(encoding="utf-8"))}
    parts = len(FILMS[film]["parts"])

    keys = [entry["key"] for entry in selection["new"]]
    assert len(set(keys)) == len(keys), "Duplicate new word in selection"
    assert set(keys) == set(texts), f"Selection and cards differ: {sorted(set(keys) ^ set(texts))}"
    entries = []
    for entry in selection["oxford"]:
        assert entry["id"] in oxford, f"Unknown Oxford card {entry['id']}"
        entries.append({"id": entry["id"], "uses": entry["uses"], "weight": entry["uses"]})
    cards = []
    for entry in selection["new"]:
        text = texts[entry["key"]]
        assert entry["kind"] in ("word", "term"), entry
        assert ("note" in text) == (entry["kind"] == "term"), f"Term note mismatch: {entry['key']}"
        card = {"id": card_id(film, entry["key"]), **{k: text[k] for k in CARD_FIELDS if k in text}, "kind": entry["kind"]}
        cards.append(card)
        entries.append({"id": card["id"], "uses": entry["uses"], "weight": entry["weight"]})
    for entry in entries:
        assert len(entry["uses"]) == parts and len(entry["weight"]) == parts, entry
    assert len({entry["id"] for entry in entries}) == len(entries), "Duplicate card in film"
    # Queue order of the mode: most used in both parts first, stable by id.
    entries.sort(key=lambda entry: (-sum(entry["uses"]), entry["id"]))
    return {"id": film, **FILMS[film], "cards": cards, "entries": entries}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify that committed outputs match the sources")
    args = parser.parse_args()
    for film in FILMS:
        result = build(film)
        path = DATA / "films" / f"{film}.json"
        expected = json_text(result)
        if args.check:
            assert path.read_text(encoding="utf-8") == expected, f"Outdated generated file: {path}"
        else:
            path.parent.mkdir(exist_ok=True)
            path.write_text(expected, encoding="utf-8")
        terms = sum(card["kind"] == "term" for card in result["cards"])
        print(f"{film}: {'verified' if args.check else 'generated'}, {len(result['entries'])} cards in mode, "
              f"{len(result['cards']) - terms} new words, {terms} terms")


if __name__ == "__main__":
    main()
