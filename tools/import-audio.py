# 更换「本文」「単語」的录音。
#
#   py -3 tools/import-audio.py 音频文件夹
#
# 两种音频文件夹都可以：
#
# A. 整批音频包：文件夹里有 manifest.json（每条录音的课号、类型、中文、说话人、文件路径），
#    格式与 textbook-audio 音频包相同：
#      {"lesson": 7, "type": "sentence" 或 "word", "zh": "我喜欢爬山。", "speaker": "山本", "path": "lesson07/本文/我喜欢爬山。.mp3"}
#    按「课号 + 中文」对应；同一课里有两句相同的中文时，再按说话人区分。
#
# B. 补录的几个 mp3：没有 manifest.json，文件名就是中文（如「你要几个？.mp3」）。
#    在全部 14 课里按文件名找对应的句子或单词；同样的文字出现在好几处时（如「你好！」），
#    不会拿去单独替换，只用来拼接（见下面 3）。
#
# 这个工具会：
#   1. 对应时，阿拉伯数字 1、25 视同 一、二十五；标点不计。
#   2. 一条录音包含课文里连续的几句时（如「A。B？」而课文分成两句），按录音里的停顿自动切开。
#   3. 课文一句由几条录音组成时（如「你好！」「一百块。」「你要几个？」），按顺序接成一条，中间留停顿。
#   4. 复制到 audio/lessonXX/reading-NN.mp3、word-NN.mp3，并改写 source/lesson-XX.json 里的 audio。
#   5. 重新计算逐字高亮的时间（reading-alignment.js）。
#   6. 运行 build-course.py 生成 course-data.js。
# 没有对上的句子保留现有录音。结果写进 audio/import-report.txt。
#
# 需要：电脑上装有 ffmpeg（用于读取、切分、拼接 MP3）。只用 Python 标准库。
import array
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "source"
ALIGNMENT = ROOT / "reading-alignment.js"
SR = 16000          # 分析用的采样率
WIN = 0.01          # 能量窗口 10ms
MIN_PAUSE = 0.12    # 短于这个长度的静音不算停顿（秒）
PUNCT = "，。！？、,.!?…：:；;“”\"'（）() 　\t\r\n—-~～"


# ---------- 文字比对 ----------

DIGITS = "零一二三四五六七八九"


def number_to_chinese(n):
    """0–9999 的阿拉伯数字 → 中文读法（25 → 二十五，100 → 一百）。"""
    if n < 10:
        return DIGITS[n]
    parts, units = [], [(1000, "千"), (100, "百"), (10, "十")]
    rest, zero = n, False
    for value, unit in units:
        d, rest = divmod(rest, value)
        if d:
            if zero:
                parts.append("零")
                zero = False
            parts.append(("" if (value == 10 and d == 1 and not parts) else DIGITS[d]) + unit)
        elif parts:
            zero = True
    if rest:
        if zero:
            parts.append("零")
        parts.append(DIGITS[rest])
    return "".join(parts)


def norm(text):
    text = re.sub(r"\d+", lambda m: number_to_chinese(int(m.group())), str(text))
    return "".join(c for c in text if c not in PUNCT)


# ---------- 读取音频、找停顿 ----------

def ffmpeg_ok():
    return shutil.which("ffmpeg") is not None


def load_pcm(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "quiet", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
        capture_output=True, check=True).stdout
    samples = array.array("h")
    samples.frombytes(raw[: len(raw) // 2 * 2])
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def speech_regions(samples):
    """返回 [(开始秒, 结束秒), …]：有声音的段落，中间是停顿。"""
    n = int(SR * WIN)
    db = []
    for i in range(0, len(samples) - n + 1, n):
        chunk = samples[i:i + n]
        rms = math.sqrt(sum(s * s for s in chunk) / n) / 32768
        db.append(20 * math.log10(rms + 1e-9))
    if not db:
        return [], 0.0
    threshold = max(max(db) - 35, -50)
    regions, start = [], None
    for i, value in enumerate(db + [-999]):
        if value > threshold and start is None:
            start = i
        elif value <= threshold and start is not None:
            regions.append([start * WIN, i * WIN])
            start = None
    merged = []
    for r in regions:
        if merged and r[0] - merged[-1][1] < MIN_PAUSE:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    merged = [r for r in merged if r[1] - r[0] >= 0.04]
    return merged, len(samples) / SR


def fit_regions(regions, count):
    """把有声段落合并成 count 段（从最短的停顿开始合并）。"""
    regions = [list(r) for r in regions]
    while len(regions) > count:
        gaps = [regions[i + 1][0] - regions[i][1] for i in range(len(regions) - 1)]
        i = gaps.index(min(gaps))
        regions[i:i + 2] = [[regions[i][0], regions[i + 1][1]]]
    return regions


# ---------- 切分合在一起的录音 ----------

def split_clip(src, count, outputs):
    samples = load_pcm(src)
    regions, duration = speech_regions(samples)
    if len(regions) < count:
        return False
    regions = fit_regions(regions, count)
    cuts = [0.0] + [(regions[i][1] + regions[i + 1][0]) / 2 for i in range(count - 1)] + [duration]
    for i, out in enumerate(outputs):
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-v", "quiet", "-y", "-i", str(src), "-ss", f"{cuts[i]:.3f}", "-to", f"{cuts[i + 1]:.3f}",
             "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "48k", str(out)],
            check=True)
    return True


# ---------- 把几条录音接成一条 ----------

JOIN_LEAD, JOIN_PAUSE, JOIN_TAIL = 0.25, 0.8, 0.35   # 开头 / 句间 / 结尾的静音（秒）
OUT_SR = 24000


def join_clips(srcs, out):
    pieces = []
    for src in srcs:
        regions, _ = speech_regions(load_pcm(src))
        if not regions:
            return False
        start, end = max(regions[0][0] - 0.05, 0), regions[-1][1] + 0.05
        raw = subprocess.run(
            ["ffmpeg", "-v", "quiet", "-i", str(src), "-ac", "1", "-ar", str(OUT_SR), "-f", "s16le", "-"],
            capture_output=True, check=True).stdout
        pieces.append(raw[int(start * OUT_SR) * 2: int(end * OUT_SR) * 2])
    silence = lambda sec: bytes(int(sec * OUT_SR) * 2)
    pcm = silence(JOIN_LEAD) + silence(JOIN_PAUSE).join(pieces) + silence(JOIN_TAIL)
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-v", "quiet", "-y", "-f", "s16le", "-ar", str(OUT_SR), "-ac", "1", "-i", "-",
         "-c:a", "libmp3lame", "-b:a", "48k", str(out)], input=pcm, check=True)
    return True


def find_parts(target, clips, used):
    """找几条录音，按顺序拼起来正好等于 target（至少 2 条）。"""
    def search(rest, chosen):
        if not rest:
            return chosen if len(chosen) >= 2 else None
        for m in clips:
            key = norm(m["zh"])
            if key and id(m) not in used and m not in chosen and rest.startswith(key):
                found = search(rest[len(key):], chosen + [m])
                if found:
                    return found
        return None
    return search(target, [])


# ---------- 逐字高亮时间 ----------

def realign(entry, audio_path):
    """按停顿把标点之间的每一段对到有声段落，段内按音节数平均分配时间。"""
    samples = load_pcm(audio_path)
    regions, duration = speech_regions(samples)
    words = entry["words"]
    groups, current = [], []
    for w in words:
        if w.get("punctuation"):
            if current:
                groups.append(current)
                current = []
        else:
            current.append(w)
    if current:
        groups.append(current)
    if not regions or not groups:
        return None
    if len(regions) >= len(groups):
        spans = fit_regions(regions, len(groups))
    else:
        spans = [[regions[0][0], regions[-1][1]]]
        groups = [[w for g in groups for w in g]]
    for group, (start, end) in zip(groups, spans):
        total = sum(len(w["chars"]) for w in group) or 1
        t = start
        for w in group:
            step = (end - start) * len(w["chars"]) / total
            w["start"], w["end"] = round(t, 3), round(t + step, 3)
            w.pop("first", None)
            w.pop("last", None)
            w["confidence"] = 1.0 if len(regions) >= len(groups) else 0.5
            t += step
    entry["duration"] = round(duration, 3)
    return entry


# ---------- 主程序 ----------

def read_json(path):
    text = path.read_text(encoding="utf-8")
    return json.loads(text), ("\r\n" if "\r\n" in text else "\n")


def write_json(path, data, newline):
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    path.write_bytes(text.replace("\n", newline).encode("utf-8"))


def load_clips(pack, lessons):
    """读 manifest.json；没有的话按文件名（= 中文）建立清单。"""
    manifest_file = pack / "manifest.json"
    if manifest_file.is_file():
        return json.loads(manifest_file.read_text(encoding="utf-8")), True
    clips = []
    for f in sorted(pack.rglob("*.mp3")):
        text = f.stem.split("-")[-1]            # 「王明-你好！」→「你好！」
        places = [(l["id"], kind) for l in lessons for kind in ("reading", "words")
                  for item in l.get(kind, []) if norm(item["ch"]) == norm(text)]
        lesson_ids = {p[0] for p in places}
        clips.append({
            "zh": text, "speaker": None, "path": f.relative_to(pack).as_posix(),
            "lesson": places[0][0] if len(places) == 1 else None,          # 只在一处出现时才单独替换
            "type": ("sentence" if places[0][1] == "reading" else "word") if len(places) == 1 else "part",
            "lessons": lesson_ids,
        })
    return clips, False


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: py -3 tools/import-audio.py 音频文件夹")
    if not ffmpeg_ok():
        raise SystemExit("找不到 ffmpeg。请先安装 ffmpeg 并加入 PATH。")
    pack = Path(sys.argv[1]).resolve()
    paths = sorted(SOURCE.glob("lesson-*.json"))
    lessons = [read_json(p) for p in paths]
    manifest, full_pack = load_clips(pack, [l for l, _ in lessons])

    align_text = ALIGNMENT.read_text(encoding="utf-8")
    align_newline = "\r\n" if "\r\n" in align_text else "\n"
    alignment = json.loads(re.sub(r"^\s*window\.DRAMA_ALIGNMENT\s*=\s*", "", align_text).rstrip().rstrip(";"))

    report, changed, used = [], 0, set()
    for path, (lesson, newline) in zip(paths, lessons):
        n = lesson["id"]
        folder = ROOT / "audio" / f"lesson{n:02d}"
        clips = {"sentence": [m for m in manifest if m["lesson"] == n and m["type"] == "sentence"],
                 "word": [m for m in manifest if m["lesson"] == n and m["type"] == "word"]}
        # 可用来拼接的录音：整批包 = 本课的本文录音；补录 = 所有文件
        parts = clips["sentence"] if full_pack else manifest

        def place(item, rel_out):
            item["audio"] = rel_out
            entry = alignment.get(item["id"])
            if entry:
                realign(entry, ROOT / rel_out)

        # 单词
        for i, word in enumerate(lesson.get("words", []), 1):
            hits = [m for m in clips["word"] if norm(m["zh"]) == norm(word["ch"])]
            if not hits:
                if full_pack:
                    report.append(f"第{n}课 単語 {i:02d}「{word['ch']}」：没有对应录音，保留现有录音")
                continue
            out = folder / f"word-{i:02d}.mp3"
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(pack / hits[0]["path"], out)
            used.add(id(hits[0]))
            place(word, out.relative_to(ROOT).as_posix())
            changed += 1
            if not full_pack:
                report.append(f"第{n}课 単語 {i:02d}「{word['ch']}」：换成 {hits[0]['path']}")

        # 本文
        lines = lesson.get("reading", [])
        i = 0
        while i < len(lines):
            line = lines[i]
            out = folder / f"reading-{i + 1:02d}.mp3"
            hits = [m for m in clips["sentence"] if norm(m["zh"]) == norm(line["ch"]) and id(m) not in used]
            if len(hits) > 1:
                same = [m for m in hits if m.get("speaker") == line.get("speaker")]
                hits = same or hits
            if hits:                                             # 一条录音 = 一句
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(pack / hits[0]["path"], out)
                used.add(id(hits[0]))
                place(line, out.relative_to(ROOT).as_posix())
                changed += 1
                if not full_pack:
                    report.append(f"第{n}课 本文 {i + 1:02d}「{line['ch']}」：换成 {hits[0]['path']}")
                i += 1
                continue
            done = False
            for m in clips["sentence"]:                          # 一条录音 = 连续几句
                if id(m) in used:
                    continue
                joined, j = "", i
                while j < len(lines) and len(joined) < len(norm(m["zh"])):
                    joined += norm(lines[j]["ch"])
                    j += 1
                if joined == norm(m["zh"]) and j - i > 1:
                    outs = [folder / f"reading-{k + 1:02d}.mp3" for k in range(i, j)]
                    if split_clip(pack / m["path"], j - i, outs):
                        for k, o in zip(range(i, j), outs):
                            place(lines[k], o.relative_to(ROOT).as_posix())
                            changed += 1
                        used.add(id(m))
                        report.append(f"第{n}课 本文 {i + 1:02d}–{j:02d}：一条录音「{m['zh']}」按停顿切成 {j - i} 句")
                        i, done = j, True
                        break
            if done:
                continue
            chosen = find_parts(norm(line["ch"]), parts, used)   # 几条录音 = 一句
            if chosen and join_clips([pack / m["path"] for m in chosen], out):
                for m in chosen:
                    used.add(id(m))
                place(line, out.relative_to(ROOT).as_posix())
                changed += 1
                report.append(f"第{n}课 本文 {i + 1:02d}「{line['ch']}」：由 {len(chosen)} 条录音接成（"
                              + " + ".join(m["zh"] for m in chosen) + "）")
            elif full_pack:
                report.append(f"第{n}课 本文 {i + 1:02d}「{line['ch']}」：没有对应录音，保留现有录音")
            i += 1

        write_json(path, lesson, newline)

    for m in manifest:
        if id(m) not in used:
            where = f"第{m['lesson']}课 " if m.get("lesson") else ""
            report.append(f"{where}未使用的录音：{m['zh']}（{m['path']}）")

    payload = json.dumps(alignment, ensure_ascii=False, separators=(", ", ": "))
    ALIGNMENT.write_bytes(("window.DRAMA_ALIGNMENT = " + payload + ";" + align_newline).encode("utf-8"))
    subprocess.run([sys.executable, str(ROOT / "tools" / "build-course.py")], check=True, cwd=ROOT)

    text = f"来源：{pack.name}\n更换录音：{changed} 条\n" + "\n".join(report) + "\n"
    (ROOT / "audio" / "import-report.txt").write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
