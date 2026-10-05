# openNova 产品概念宣传视频

将三个已确认的场景样片依次整合，每段前加入 2.5 秒场景标题页：工作协作、随身交流、日常陪伴。保留原画面比例、播放速度和对白音频。标题页采用深色背景、白色场景名称和小号 openNova 标识。

已导出 [完整产品概念视频](../../docs/product/assets/opennova-product-concept-film-v01.mp4)：1280 × 720、24 fps、1338 帧，画面时长 55.75 秒，MP4 容器时长 55.765 秒，18,550,930 字节。每段原片的音频为 16.064 秒，时间线以 386 帧（16.083 秒）容纳，避免截断片尾音频。

完整解码检查通过，三个片段的音轨均非静音，平均音量与原片一致。已检查标题页、场景画面和片尾衔接抽帧；具体记录见 [verification.json](out/verification.json)。本次保留原片对白，未重新生成语音。

## 片段来源

| 顺序 | 场景 | 已确认样片 |
| --- | --- | --- |
| 1 | 工作协作 | [场景一 v07](../../docs/product/assets/scene-one-waterdrop-demo-v07.mp4) |
| 2 | 随身交流 | [场景二 v01](../../docs/product/assets/scene-two-waterdrop-demo-v01.mp4) |
| 3 | 日常陪伴 | [场景三 v02](../../docs/product/assets/scene-three-waterdrop-demo-v02.mp4) |

三段片源的字节副本位于 `../scene-one/public/concept-film/`。时间线与标题页源码为 [ConceptFilm.tsx](../scene-one/src/concept-film/ConceptFilm.tsx)，复用已有 Remotion 项目，不调用生成模型。

## 时间线

| 时间 | 内容 |
| --- | --- |
| 00:00.000–00:02.500 | 工作协作标题页 |
| 00:02.500–00:18.583 | 工作协作片段 |
| 00:18.583–00:21.083 | 随身交流标题页 |
| 00:21.083–00:37.167 | 随身交流片段 |
| 00:37.167–00:39.667 | 日常陪伴标题页 |
| 00:39.667–00:55.750 | 日常陪伴片段 |

## 渲染

在 `videos/scene-one` 目录运行：

```sh
./node_modules/.bin/remotion render ProductConceptFilm ../product-concept/out/opennova-product-concept-film-v01.mp4 --codec=h264 --crf=17 --audio-codec=aac --audio-bitrate=192k --pixel-format=yuv420p --concurrency=4 --browser-executable='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

预览使用已有 Remotion Studio 中的 `ProductConceptFilm` 时间线。
