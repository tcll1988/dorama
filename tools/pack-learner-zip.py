# Pack this folder into a zip whose entry names set the UTF-8 flag (bit 11).
# Japanese Windows Explorer reads bit 11 as UTF-8 and everything else as CP932.
#   py -3 tools/pack-learner-zip.py DEST.zip
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {"__pycache__", ".git"}


def pack(dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(dest, "w") as zf:
        for path in sorted(ROOT.rglob("*")):
            if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
                continue
            if not path.is_file():
                continue
            rel = path.relative_to(ROOT).as_posix()
            arcname = "drama-chinese-study/" + rel
            info = zipfile.ZipInfo(arcname)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.flag_bits |= 0x800
            info.date_time = (2026, 9, 23, 0, 0, 0)
            zf.writestr(info, path.read_bytes())
            count += 1
    return count


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: py -3 tools/pack-learner-zip.py DEST.zip")
    dest = Path(sys.argv[1])
    count = pack(dest)
    print(f"wrote {dest} ({count} files)")


if __name__ == "__main__":
    main()
