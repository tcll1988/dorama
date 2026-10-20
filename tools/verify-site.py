"""Compare every published page asset with this checkout and decode all MP3s."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def download(base, relative):
    request = Request(base + relative + "?verify=" + sha((ROOT / relative).read_bytes())[:16],
                      headers={"Cache-Control": "no-cache", "User-Agent": "dorama-release-check"})
    with urlopen(request, timeout=45) as response:
        assert response.status == 200
        return response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url")
    parser.add_argument("--wait", type=int, default=0, help="Seconds to wait for the new Pages release")
    parser.add_argument("--output", default="site-results.json")
    args = parser.parse_args()
    base = args.base_url.rstrip("/") + "/"
    deadline = time.monotonic() + args.wait
    while True:
        try:
            for name in ("index.html", "app.js", "reading-alignment.js"):
                assert sha(download(base, name)) == sha((ROOT / name).read_bytes()), "Old release: " + name
            break
        except Exception as exc:
            if time.monotonic() >= deadline:
                raise
            print("Waiting for Pages release:", str(exc), flush=True)
            time.sleep(20)
    course = json.loads(re.sub(r"^\s*window\.DRAMA_COURSE\s*=\s*", "",
                              (ROOT / "course-data.js").read_text()).rstrip().rstrip(";"))
    audio = sorted({item["audio"] for lesson in course for kind in ("reading", "words")
                    for item in lesson[kind]})
    assert len(audio) == 178
    files = ["index.html", "app.js", "app.css", "config.js", "course-data.js",
             "reading-alignment.js", "manifest.webmanifest"]
    files += sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / "icons").glob("*.png"))
    files += audio

    def check(relative):
        payload = download(base, relative)
        digest = sha(payload)
        assert digest == sha((ROOT / relative).read_bytes()), "Published bytes differ: " + relative
        if relative.endswith(".mp3"):
            with tempfile.NamedTemporaryFile(suffix=".mp3") as tmp:
                tmp.write(payload)
                tmp.flush()
                subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", tmp.name, "-f", "null", "-"],
                               check=True, capture_output=True)
        return {"path": relative, "sha256": digest, "bytes": len(payload)}

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(check, files))
    report = {"status": "PASS", "base": base, "files": len(results),
              "audio_downloaded_and_decoded": len(audio), "assets": results}
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"PASS: {len(results)} exact published files; all {len(audio)} MP3s decoded.")


if __name__ == "__main__":
    main()
