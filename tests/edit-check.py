# Change one lesson gloss, rebuild with the documented command, then restore.
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ['py', '-3', 'tools/build-course.py']
PROBE = r'''
const fs = require('fs');
const {loadPage} = require(process.env.STUDY_CHECK);
const {sandbox} = loadPage(process.env.STUDY_ROOT);
const course = sandbox.DRAMA_COURSE;
const payload = {
  ch: course[0].reading[0].ch,
  jp: course[0].reading[0].jp,
  audio: course[0].reading[0].audio,
  lesson1: course[0].reading.map(line => line.jp),
  other: course.filter(lesson => lesson.id !== 1).map(lesson => ({id: lesson.id, jp: lesson.reading.map(line => line.jp)}))
};
fs.writeFileSync(process.argv[2], JSON.stringify(payload));
'''


def course_hash():
    return hashlib.sha256((ROOT / 'course-data.js').read_bytes()).hexdigest()


def build():
    subprocess.check_call(BUILD, cwd=ROOT)


def loaded(dest):
    script = dest.with_suffix('.js')
    script.write_text(PROBE, encoding='utf-8')
    env = os.environ.copy()
    env['STUDY_CHECK'] = str(ROOT / 'tests' / 'study-check.js')
    env['STUDY_ROOT'] = str(ROOT)
    subprocess.check_call(['node', str(script), str(dest)], cwd=ROOT, env=env)
    return json.loads(dest.read_text(encoding='utf-8'))


def main():
    scratch = Path(sys.argv[1])
    scratch.mkdir(parents=True, exist_ok=True)
    before_hash = course_hash()
    before = loaded(scratch / 'before.json')
    lesson1 = ROOT / 'source' / 'lesson-01.json'
    original1 = lesson1.read_bytes()
    try:
        data = json.loads(original1)
        data['reading'][0]['jp'] = data['reading'][0]['jp'] + '（改稿）'
        lesson1.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        build()
        edited = loaded(scratch / 'edited.json')
        if edited['jp'] != before['jp'] + '（改稿）':
            raise SystemExit('gloss did not reach the loaded course')
        if edited['ch'] != '你好！':
            raise SystemExit('dialogue line changed')
        if edited['lesson1'][1:] != before['lesson1'][1:]:
            raise SystemExit('other lines in lesson 1 changed')
        if edited['other'] != before['other']:
            raise SystemExit('another lesson gloss changed')
        audio = ROOT / edited['audio']
        if not edited['audio'] or edited['audio'] != before['audio'] or not audio.is_file() or audio.stat().st_size == 0:
            raise SystemExit('line audio missing after gloss edit: ' + edited['audio'])
        print('gloss edit loaded; other lessons unchanged; audio', edited['audio'], audio.stat().st_size)
    finally:
        lesson1.write_bytes(original1)
        build()

    after = course_hash()
    if after != before_hash:
        raise SystemExit('course-data.js was not restored')
    print('restored course-data.js')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as exc:
        raise SystemExit('command failed: ' + ' '.join(exc.cmd))
