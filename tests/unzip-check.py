# Build the learner zip and extract it the way Japanese Windows Explorer does,
# then again by ignoring the UTF-8 flag and using CP932.
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def raw_name(info):
    if info.flag_bits & 0x800:
        return info.filename.encode('utf-8')
    return info.filename.encode('cp437')


def decoded_name(info, mode):
    raw = raw_name(info)
    if mode == 'explorer' and info.flag_bits & 0x800:
        return raw.decode('utf-8')
    return raw.decode('cp932', errors='replace')


def extract(zf, dest, mode):
    if dest.exists():
        import shutil
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = decoded_name(info, mode).replace('\\', '/')
        if name.endswith('/') or '..' in name.split('/'):
            continue
        target = dest.joinpath(*name.split('/'))
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(info))
        except OSError as exc:
            print('skip', mode, name, exc)


def main():
    scratch = Path(sys.argv[1])
    scratch.mkdir(parents=True, exist_ok=True)
    archive = scratch / 'learner.zip'
    subprocess.check_call(['py', '-3', 'tools/pack-learner-zip.py', str(archive)], cwd=ROOT)
    with zipfile.ZipFile(archive) as zf:
        flagged = [info for info in zf.infolist() if info.flag_bits & 0x800]
        plain = [info for info in zf.infolist() if not info.flag_bits & 0x800]
        print(f'zip entries {len(zf.infolist())} with bit 11: {len(flagged)} ascii-only: {len(plain)}')
        for info in plain:
            if not info.filename.isascii():
                raise SystemExit('non-ascii name missing bit 11: ' + info.filename)
        if not flagged:
            raise SystemExit('zip has no UTF-8 names to prove bit 11')
        for mode in ('explorer', 'cp932'):
            folder = scratch / mode
            extract(zf, folder, mode)
            page = folder / 'drama-chinese-study'
            if not (page / 'index.html').is_file():
                raise SystemExit(mode + ' extract has no index.html')
            print('check', mode)
            subprocess.check_call(['node', str(ROOT / 'tests' / 'study-check.js'), str(page)])
            print('PASS', mode)


if __name__ == '__main__':
    main()
