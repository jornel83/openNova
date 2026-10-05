# openNova 桌面协作概念短片

当前水滴主方案：[48 秒场景一演示](WATERDROP.md)，主时间线为 `WaterdropDesktopCollaboration`。下文保留早期桌面终端版本的记录。

24 秒，1920 × 1080，30 fps，带中文合成对话与字幕。画面与交互均为概念演示，不表示产品功能已经实现。

本短片保留早期桌面终端造型与情节。当前主方案已调整为水滴助手，最新描述见[产品概念文档的核心场景](../../docs/product/opennova-product-concept.md#产品核心场景)。

主时间线：`DesktopCollaboration`。四段分别为桌面开场、选中文字、检查并应用修改、区分已决定与待确定事项。用户点击“应用修改”后才保存改写。

## 预览

```sh
npm install
npm run dev -- --no-open
```

在 Studio 选择 DesktopCollaboration 并播放，可修改图层文字、时间与样式。

本次预览地址：[播放桌面协作短片](http://localhost:3000/DesktopCollaboration)。需要保持本地预览服务运行；重启后以终端输出的地址为准。

## 素材

- 产品图来自本仓库 docs/product/assets/opennova-desktop-concept-v01.png，为此前生成的 ImageGen 概念图。
- 中文对话使用 macOS 内置 Reed 与 Tingting 合成语音，台词与真实音频时长见 public/audio/voiceover.json。
- 字幕与界面为可编辑图层。主时间线含对话音轨，各分镜单独预览仅展示画面。

运行 python3 scripts/make-voiceover.py 可在具备上述语音、FFmpeg 的 macOS 环境重新生成音轨。

## 分镜

| 时间 | 画面 | 对话 |
| --- | --- | --- |
| 0–4 秒 | 桌面终端与场景标题 | 这份资料，我们一起改。 |
| 4–9 秒 | 文档原句被选中 | 这句太抽象，换成一个真实场景。 |
| 9–15 秒 | 原句与具体场景对照，用户应用修改 | 已改写，请看这一处变化。 |
| 15–24 秒 | 分别记录桌面方案与待定的随身入口 | 保留桌面方案，随身入口待定。／已保存，随身入口仍然待定。 |

片中桌面方案是演示任务内的决定，不是对 openNova 最终硬件形态的确认。
