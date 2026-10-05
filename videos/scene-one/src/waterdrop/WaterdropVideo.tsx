import { Audio } from "@remotion/media";
import { useEffect } from "react";
import {
  AbsoluteFill,
  Composition,
  Folder,
  Interactive,
  Series,
  staticFile,
  prefetch,
  useCurrentFrame,
} from "remotion";
import { BasicCaptions } from "./basic-captions";
import { WaterdropOpening } from "./Opening";
import { WaterdropRewrite } from "./Rewrite";
import { WaterdropDecisions } from "./Decisions";
import { WaterdropVision } from "./Vision";
import { WaterdropClosing } from "./Closing";

export const WaterdropDesktopCollaboration = () => {
  const frame = useCurrentFrame();
  useEffect(() => {
    const images = [
      prefetch(staticFile("waterdrop/workspace.png")),
      prefetch(staticFile("waterdrop/vision.png")),
      prefetch(staticFile("waterdrop/ring-backup-dock.png")),
    ];
    return () => images.forEach((image) => image.free());
  }, []);
  const userSpeaking =
    (frame >= 30 && frame < 89) ||
    (frame >= 258 && frame < 369) ||
    (frame >= 615 && frame < 712) ||
    (frame >= 864 && frame < 957) ||
    (frame >= 1176 && frame < 1237);
  const novaSpeaking =
    (frame >= 135 && frame < 202) ||
    (frame >= 420 && frame < 569) ||
    (frame >= 732 && frame < 829) ||
    (frame >= 1008 && frame < 1140) ||
    (frame >= 1290 && frame < 1384);
  return (
    <AbsoluteFill>
      <Series>
        <Series.Sequence name="直接开口" durationInFrames={240}>
          <WaterdropOpening />
        </Series.Sequence>
        <Series.Sequence name="一起改好文档" durationInFrames={360}>
          <WaterdropRewrite />
        </Series.Sequence>
        <Series.Sequence name="记住共同决定" durationInFrames={240}>
          <WaterdropDecisions />
        </Series.Sequence>
        <Series.Sequence name="查看纸面草图" durationInFrames={420}>
          <WaterdropVision />
        </Series.Sequence>
        <Series.Sequence name="交流自然继续" durationInFrames={180}>
          <WaterdropClosing />
        </Series.Sequence>
      </Series>
      <Audio
        name="用户 继续昨天方案"
        from={30}
        src={staticFile("waterdrop/audio/01-user.mp3")}
      />
      <Audio
        name="助手 接续讨论"
        from={135}
        src={staticFile("waterdrop/audio/02-nova.mp3")}
      />
      <Audio
        name="用户 改具体场景"
        from={258}
        src={staticFile("waterdrop/audio/03-user.mp3")}
      />
      <Audio
        name="助手 修改建议"
        from={420}
        src={staticFile("waterdrop/audio/04-nova.mp3")}
      />
      <Audio
        name="用户 确定主备方案"
        from={615}
        src={staticFile("waterdrop/audio/05-user.mp3")}
      />
      <Audio
        name="助手 记住决定"
        from={732}
        src={staticFile("waterdrop/audio/06-nova.mp3")}
      />
      <Audio
        name="用户 主动开启视觉"
        from={864}
        src={staticFile("waterdrop/audio/07-user.mp3")}
      />
      <Audio
        name="助手 讨论链条走向"
        from={1008}
        src={staticFile("waterdrop/audio/08-nova.mp3")}
      />
      <Audio
        name="用户 关闭视觉"
        from={1176}
        src={staticFile("waterdrop/audio/09-user.mp3")}
      />
      <Audio
        name="助手 语音继续可用"
        from={1290}
        src={staticFile("waterdrop/audio/10-nova.mp3")}
      />
      <Interactive.Div
        name="Caption speaker"
        style={{
          position: "absolute",
          top: 896,
          left: 0,
          width: 1920,
          textAlign: "center",
          fontFamily: '"PingFang SC", sans-serif',
          fontSize: 23,
          color: "#45554e",
          opacity: userSpeaking || novaSpeaking ? 1 : 0,
        }}
      >
        {userSpeaking ? "用户" : "openNova"}
      </Interactive.Div>
      <BasicCaptions
        name="Chinese dialogue captions"
        width={1920}
        combineTokensWithinMilliseconds={0}
        style={{
          position: "absolute",
          top: 936,
          left: 0,
          scale: 0.83,
          transformOrigin: "center top",
          opacity: userSpeaking || novaSpeaking ? 1 : 0,
        }}
        captions={[
          {
            text: "我们继续昨天的方案。",
            startMs: 1000,
            endMs: 2968,
            timestampMs: null,
            confidence: null,
            pageBreakAfter: true,
          },
          {
            text: "好，我们接着看这一段。",
            startMs: 4500,
            endMs: 6708,
            timestampMs: null,
            confidence: null,
            pageBreakAfter: true,
          },
          {
            text: "这段太抽象，改成一个真实的使用场景。",
            startMs: 8600,
            endMs: 12296,
            timestampMs: null,
            confidence: null,
            pageBreakAfter: true,
          },
          {
            text: "可以。把用户何时开口、助手如何接续，写清楚。",
            startMs: 14000,
            endMs: 18944,
            timestampMs: null,
            confidence: null,
            pageBreakAfter: true,
          },
          {
            text: "水滴是主方案，圆环保留为备选。",
            startMs: 20500,
            endMs: 23716,
            timestampMs: null,
            confidence: null,
            pageBreakAfter: true,
          },
          {
            text: "记住了。水滴主方案，圆环作备选。",
            startMs: 24400,
            endMs: 27616,
            timestampMs: null,
            confidence: null,
            pageBreakAfter: true,
          },
          {
            text: "打开视觉，我们看看这个连接位置。",
            startMs: 28800,
            endMs: 31872,
            timestampMs: null,
            confidence: null,
            pageBreakAfter: true,
          },
          {
            text: "我看到这处连接了。先把链条的走向标出来。",
            startMs: 33600,
            endMs: 37968,
            timestampMs: null,
            confidence: null,
            pageBreakAfter: true,
          },
          {
            text: "好，先关掉视觉。",
            startMs: 39200,
            endMs: 41216,
            timestampMs: null,
            confidence: null,
            pageBreakAfter: true,
          },
          {
            text: "已关闭视觉，我们可以继续讨论。",
            startMs: 43000,
            endMs: 46120,
            timestampMs: null,
            confidence: null,
            pageBreakAfter: true,
          },
        ]}
      />
    </AbsoluteFill>
  );
};

export const WaterdropCompositions = () => (
  <>
    <Composition
      id="WaterdropDesktopCollaboration"
      component={WaterdropDesktopCollaboration}
      durationInFrames={1440}
      fps={30}
      width={1920}
      height={1080}
    />
    <Folder name="WaterdropScenes">
      <Composition
        id="WaterdropOpening"
        component={WaterdropOpening}
        durationInFrames={240}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="WaterdropRewrite"
        component={WaterdropRewrite}
        durationInFrames={360}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="WaterdropDecisions"
        component={WaterdropDecisions}
        durationInFrames={240}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="WaterdropVision"
        component={WaterdropVision}
        durationInFrames={420}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="WaterdropClosing"
        component={WaterdropClosing}
        durationInFrames={180}
        fps={30}
        width={1920}
        height={1080}
      />
    </Folder>
  </>
);
