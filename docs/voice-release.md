# 会话录音更新

14 课共 64 句会话已更新：山本优子（山本）的 32 句使用提供的 Iris
自然女声；王明（王）、店员、司机的 32 句使用用户本人提供的样音，
经授权通过与 HSK 项目相同的 ZipVoice 引擎生成。114 个单词录音保持原样。

男声在本地 CPU 上使用 sherpa-onnx 1.13.8、ZipVoice distill int8、
Vocos 24 kHz 生成。参考录音与模型保存在仓库外，不随网站发布。
32 句男声均通过全文自动转写比对和 MP3 完整解码。自动转写不代表人工听辨
或对音色相似度的独立评定。

所有会话高亮均按新录音重新匹配，保留原有词组、拼音和译文。
男声采用 SenseVoice CTC 时间戳的相邻中点作为词边界；
女声采用提供的逐字时间。每个会话音频 URL 带有内容指纹，避免缓存旧声音。

## 验证

```sh
node tests/study-check.js
CHROMIUM_PATH=/usr/bin/chromium node tests/browser-check.cjs http://127.0.0.1:8000/ /tmp/dorama-browser.json
python3 tools/verify-site.py http://127.0.0.1:8000/ --output /tmp/dorama-site.json
```

浏览器检查覆盖 28 个本文/单词页面与 6 种窗口大小、全部 178 个录音的实际播放、
64 个更新音频的 SHA-256、所有更新词组的跳转高亮、5 档速度、
暂停/继续/重播/下一句/连续播放、偏好保存、存储不可用、旧链接跳转、
帮助框、键盘操作与手机菜单。

`.github/workflows/verify-pages.yml` 在 main 更新后等待 GitHub Pages 发布，
核对 188 个实际发布文件的指纹，完整解码 178 个音频，再在正式网站运行同一浏览器检查。

仓库既有的源资料重建流程仍缺少 161 个旧文法/练习音频；
本次直接更新现有会话录音与对齐数据，不重新生成 course-data.js。
该限制不影响当前网站提供的本文与单词学习功能。
