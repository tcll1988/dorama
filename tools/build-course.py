# Bundle source/lesson-01.json … lesson-14.json into course-data.js.
# Run from the folder that contains index.html:
#   py -3 tools/build-course.py
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "source"
AUDIO_ATTR = re.compile(r'data-audio="([^"]+)"')


def audio_refs(lesson):
    refs = []

    def walk(value):
        if isinstance(value, dict):
            audio = value.get("audio")
            if isinstance(audio, str) and audio:
                refs.append(audio)
            html = value.get("html")
            if isinstance(html, str):
                refs.extend(AUDIO_ATTR.findall(html))
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(lesson)
    return refs


def main():
    lessons = []
    for path in sorted(SOURCE.glob("lesson-*.json")):
        lessons.append(json.loads(path.read_text(encoding="utf-8")))
    lessons.sort(key=lambda lesson: lesson["id"])
    ids = [lesson["id"] for lesson in lessons]
    if ids != list(range(1, 15)):
        raise SystemExit(f"expected lesson ids 1..14, got {ids}")
    missing = []
    for lesson in lessons:
        for rel in audio_refs(lesson):
            if rel != rel.replace("\\", "/") or rel.startswith(("/", "\\")) or ".." in rel.split("/"):
                missing.append(rel)
                continue
            if not (ROOT / rel).is_file():
                missing.append(rel)
    if missing:
        raise SystemExit("missing audio:\n" + "\n".join(missing[:30]))
    payload = json.dumps(lessons, ensure_ascii=False, indent=2)
    (ROOT / "course-data.js").write_text("window.DRAMA_COURSE = " + payload + ";\n", encoding="utf-8")
    print(f"wrote course-data.js ({len(lessons)} lessons)")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        if exc.code not in (0, None):
            print(exc, file=sys.stderr)
        raise
