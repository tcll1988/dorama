# 打包「放到网站上用」的精简版（手机・平板通过网址访问时用）。
# 只包含页面实际需要的文件：不含 materials、source、tests、tools。
#   py -3 tools/pack-web.py DEST.zip
# 把 ZIP 解压后的 drama-web 文件夹整个上传到网站（大学服务器、GitHub Pages 等）即可。
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE_FILES = [
    "index.html", "app.css", "app.js", "config.js", "course-data.js",
    "reading-alignment.js", "manifest.webmanifest",
]


def page_audio():
    """本文・単語页会播放的音频（与 app.js 的 playablePaths 一致）。"""
    text = (ROOT / "course-data.js").read_text(encoding="utf-8")
    course = json.loads(re.sub(r"^\s*window\.DRAMA_COURSE\s*=\s*", "", text).rstrip().rstrip(";"))
    paths = []
    for lesson in course:
        for view in ("reading", "words"):
            for line in lesson.get(view, []):
                if line.get("audio"):
                    paths.append(line["audio"])
    return sorted(set(paths))


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: py -3 tools/pack-web.py DEST.zip")
    dest = Path(sys.argv[1])
    dest.parent.mkdir(parents=True, exist_ok=True)
    files = PAGE_FILES + sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / "icons").glob("*.png")) + page_audio()
    missing = [f for f in files if not (ROOT / f).is_file()]
    if missing:
        raise SystemExit("missing:\n" + "\n".join(missing))
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in files:
            info = zipfile.ZipInfo("drama-web/" + rel)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.flag_bits |= 0x800
            info.date_time = (2026, 9, 23, 0, 0, 0)
            zf.writestr(info, (ROOT / rel).read_bytes())
    size = dest.stat().st_size / 1024 / 1024
    print(f"wrote {dest} ({len(files)} files, {size:.1f} MB)")


if __name__ == "__main__":
    main()
