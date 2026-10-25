"""Rebuild the bundled Oxford 3000 cards without network access.

python scripts/import-vocabulary.py
python scripts/import-vocabulary.py --check
python scripts/import-vocabulary.py --extract-source  # requires pypdf

The source PDF and CSV are pinned and bundled. No third-party package is needed
for normal imports/checks. Extracting the canonical headwords from the PDF is an
optional audit step. See DATA-SOURCES.md for provenance and rights information.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "src" / "data"
SOURCES = DATA / "sources"
LEVELS = ("A1", "A2", "B1", "B2")


def json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def extract_source() -> None:
    from pypdf import PdfReader

    source = PdfReader(SOURCES / "oxford3000-by-cefr.pdf")
    rows: list[dict] = []
    level = None
    pattern = re.compile(
        r"^(.*?)\s+((?:indefinite article|definite article|modal v\.|number|n\.|"
        r"adj\.|adv\.|prep\.|pron\.|v\.|det\.|conj\.|exclam\.|auxiliary).*)$"
    )
    for page in source.pages:
        for raw_line in page.extract_text().splitlines():
            line = " ".join(raw_line.split())
            if line in LEVELS:
                level = line
                continue
            if not line or line.startswith(("©", "The Oxford")):
                continue
            match = pattern.match(line)
            if match:
                key, pos = match.groups()
                assert level in LEVELS, f"Missing level for {line}"
                rows.append({"key": key, "level": level, "pos": pos})
            elif line in ("adj.", "number"):
                # Exactly two wrapped part-of-speech lines in this edition.
                assert rows, "Unexpected continuation"
                rows[-1]["pos"] += " " + line
            else:
                raise ValueError(f"Unrecognized source line: {line!r}")

    grouped: dict[str, dict] = {}
    for row in rows:
        key = row["key"]
        if key not in grouped:
            sense_match = re.search(r" \((.+)\)$", key)
            grouped[key] = {
                "key": key,
                "word": re.sub(r"\d+", "", re.sub(r" \(.+\)$", "", key)),
                "sense": sense_match[1] if sense_match else "",
                "levels": [],
            }
        grouped[key]["levels"].append({"level": row["level"], "pos": row["pos"]})
    result = sorted(grouped.values(), key=lambda row: (row["word"].casefold(), row["key"]))
    assert len(result) == 3000, f"Expected 3000 official entries, got {len(result)}"
    (SOURCES / "oxford-headwords.json").write_text(json_text(result), encoding="utf-8")


POS_LABELS = {
    "indefinite article": "неопр. артикль",
    "definite article": "опр. артикль",
    "auxiliary v.": "вспом. гл.",
    "modal v.": "модальный гл.",
    "n.": "сущ.",
    "v.": "гл.",
    "adj.": "прил.",
    "adv.": "нареч.",
    "prep.": "предлог",
    "pron.": "мест.",
    "det.": "определитель",
    "conj.": "союз",
    "exclam.": "междометие",
    "number": "числ.",
}
SENSE_LABELS = {
    "money": "деньги", "river": "река", "animal": "животное", "deal with": "выносить",
    "type": "тип", "caring": "добрый", "final": "последний", "taking time": "длиться",
    "tell a lie": "лгать", "from the sun/a lamp": "свет", "not heavy": "вес",
    "similar": "сходство", "find sb/sth pleasant": "нравиться", "contest/correspond": "матч / соответствие",
    "belongs to me": "принадлежность", "hole in the ground": "шахта", "competition": "соревнование",
    "people": "раса", "remaining part": "остаток", "sleep/relax": "отдых", "stone": "камень",
    "music": "музыка", "next after the first": "порядок", "unit of time": "время",
    "put": "устанавливать", "group": "набор", "push into/attach": "прикреплять", "piece of wood": "дерево",
}


def describe_pos(entry: dict) -> str:
    labels = []
    for item in entry["levels"]:
        pos = item["pos"].replace("v. ,", "v.,")
        for chunk in re.split(r"\s*[,/]\s*", pos):
            label = POS_LABELS.get(chunk.strip(), chunk.strip())
            if label and label not in labels:
                labels.append(label)
    result = ", ".join(labels)
    if entry["sense"]:
        result += " · " + SENSE_LABELS.get(entry["sense"], entry["sense"])
    return result


def build() -> tuple[list[dict], dict]:
    headwords = json.loads((SOURCES / "oxford-headwords.json").read_text(encoding="utf-8"))
    overrides = json.loads((SOURCES / "translation-overrides.json").read_text(encoding="utf-8"))
    with (SOURCES / "oxford3000-en-ru.csv").open(encoding="utf-8-sig", newline="") as file:
        translations = {row["Word"]: row for row in csv.DictReader(file)}
    cards = []
    override_count = 0
    for entry in headwords:
        word, key = entry["word"], entry["key"]
        row = translations.get(word) or translations.get(word.lower())
        override = overrides.get(key)
        translation = override or (row or {}).get("Russian Translation", "")
        if not translation or not re.search(r"[А-Яа-яЁё]", translation):
            raise ValueError(f"Missing Russian translation: {key}")
        card = {
            "id": "oxford-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16],
            "word": word,
            "translation": translation,
            "level": min((item["level"] for item in entry["levels"]), key=LEVELS.index),
            "pos": describe_pos(entry),
        }
        if override:
            override_count += 1
        elif row and row.get("Example Sentence"):
            card["example"] = row["Example Sentence"].strip()
        cards.append(card)

    assert len(cards) == 3000, f"Expected 3000 cards, got {len(cards)}"
    assert len({card["id"] for card in cards}) == 3000, "Duplicate card IDs"
    assert all(card["level"] in LEVELS and card["pos"] for card in cards)
    assert all(not re.search(r"\d", card["word"]) for card in cards), "Unremoved homograph markers"
    assert {card["word"] for card in cards} == {entry["word"] for entry in headwords}
    metadata = {
        "title": "Oxford 3000 · English–Russian",
        "edition": "Oxford 3000 — закреплённая редакция британского списка по CEFR",
        "cardCount": len(cards),
        "uniqueSpellings": len({card["word"] for card in cards}),
        "levels": dict(sorted(Counter(card["level"] for card in cards).items())),
        "translationOverrides": override_count,
        "examples": sum("example" in card for card in cards),
        "translationNotice": "Переводы и примеры — независимые материалы с использованием ИИ; это не официальный перевод Oxford. Полная редакторская проверка не проводилась.",
        "officialListUrl": "https://www.oxfordlearnersdictionaries.com/about/wordlists/oxford3000-5000",
        "sourcePdfUrl": "https://www.oxfordlearnersdictionaries.com/external/pdf/wordlists/oxford-3000-5000/The_Oxford_3000_by_CEFR_level.pdf",
        "pinnedPdfUrl": "https://raw.githubusercontent.com/ittuann/The-Oxford-5000-Word-Lists/7dc22b8ff8e5cb3410e962b0511d22cdf74b120c/The_Oxford_3000_by_CEFR_level.pdf",
        "pdfSha256": "b81e3f65c976fc93eb342ba34c40f0ff8c3a59646312d09ac50f9c648e461cd3",
        "editionNotice": "Закреплённая опубликованная редакция Oxford; текущий список на сайте Oxford содержит небольшие изменения.",
        "translationSourceUrl": "https://github.com/ascat41/Oxford3000_en-ru",
        "sourceDate": "2026-10-25",
    }
    return cards, metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extract-source", action="store_true")
    parser.add_argument("--check", action="store_true", help="Verify that committed outputs match all sources")
    args = parser.parse_args()
    if args.extract_source:
        extract_source()
    cards, metadata = build()
    outputs = {DATA / "oxford3000.json": cards, DATA / "metadata.json": metadata}
    for path, value in outputs.items():
        expected = json_text(value)
        if args.check:
            assert path.read_text(encoding="utf-8") == expected, f"Outdated generated file: {path}"
        else:
            path.write_text(expected, encoding="utf-8")
    print(json.dumps({"status": "verified" if args.check else "generated", **metadata}, ensure_ascii=True))


if __name__ == "__main__":
    main()
