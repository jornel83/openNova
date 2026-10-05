import {
  AbsoluteFill,
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Frame } from "./Frame";

export const WaterdropOpening = () => {
  const frame = useCurrentFrame();
  return (
    <Frame>
      <Img
        name="Waterdrop on charging tray"
        src={staticFile("waterdrop/workspace.png")}
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          objectFit: "cover",
          scale: interpolate(frame, [0, 240], [1, 1.025], {
            extrapolateRight: "clamp",
          }),
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(90deg, #f6f3edeF 0%, #f6f3ede6 32%, #f6f3ed70 51%, #f6f3ed00 69%), linear-gradient(180deg, #f4f2eecc 0%, #f4f2ee00 22%)",
        }}
      />
      <Interactive.Div
        name="Scene label"
        style={{
          position: "absolute",
          left: 112,
          top: 222,
          fontSize: 30,
          letterSpacing: 4,
          color: "#697774",
          opacity: interpolate(frame, [0, 18], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        场景 01 / 桌面协作
      </Interactive.Div>
      <Interactive.Div
        name="Always On opening title"
        style={{
          position: "absolute",
          left: 103,
          top: 296,
          fontSize: 138,
          lineHeight: 1.12,
          letterSpacing: -6,
          fontWeight: 600,
          opacity: interpolate(frame, [6, 28], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          translate: interpolate(frame, [6, 28], ["0px 20px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        直接开口。
        <br />
        接着一起想。
      </Interactive.Div>
      <Interactive.Div
        name="Always On principle"
        style={{
          position: "absolute",
          left: 114,
          top: 660,
          fontSize: 34,
          color: "#455d58",
          opacity: interpolate(frame, [22, 45], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        Always On · 无需点按或唤醒词
      </Interactive.Div>
      <Interactive.Div
        name="Document is shared"
        style={{
          position: "absolute",
          left: 114,
          top: 744,
          borderRadius: 30,
          background: "#ffffffe0",
          padding: "14px 24px",
          fontSize: 27,
          color: "#68726d",
          opacity: interpolate(frame, [32, 50], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        电脑文档已共享 · 视觉关闭
      </Interactive.Div>
    </Frame>
  );
};
