import {
  AbsoluteFill,
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Frame } from "./Frame";

export const WaterdropVision = () => {
  const frame = useCurrentFrame();
  return (
    <Frame>
      <Img
        name="Camera off desk context"
        src={staticFile("waterdrop/workspace.png")}
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          objectFit: "cover",
        }}
      />
      <Img
        name="Explicitly enabled camera aimed at paper"
        src={staticFile("waterdrop/vision.png")}
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          objectFit: "cover",
          opacity: interpolate(frame, [59, 73, 390, 403], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          scale: interpolate(frame, [73, 390], [1, 1.025], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, #f4f2eef2 0%, #f4f2eebf 25%, #f4f2ee00 53%)",
        }}
      />
      <Interactive.Div
        name="Look at the paper together"
        style={{
          position: "absolute",
          left: 105,
          top: 193,
          fontSize: 108,
          fontWeight: 600,
          letterSpacing: -5,
          lineHeight: 1.2,
        }}
      >
        一起看看草图。
      </Interactive.Div>
      <Interactive.Div
        name="Camera off before and after request"
        style={{
          position: "absolute",
          left: 113,
          top: 355,
          padding: "17px 27px",
          borderRadius: 32,
          fontSize: 30,
          backgroundColor: "#ffffffd9",
          color: "#76817c",
          opacity: interpolate(frame, [59, 73, 390, 403], [1, 0, 0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        视觉关闭 · 语音可用
      </Interactive.Div>
      <Interactive.Div
        name="Visual capture is explicitly active"
        style={{
          position: "absolute",
          left: 113,
          top: 355,
          padding: "17px 27px",
          borderRadius: 32,
          fontSize: 30,
          backgroundColor: "#ffffffee",
          color: "#42745c",
          opacity: interpolate(frame, [59, 73, 390, 403], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        <span style={{ color: "#71a083", marginRight: 15 }}>●</span>视觉已开启
      </Interactive.Div>
      <Interactive.Div
        name="Aim the lens deliberately"
        style={{
          position: "absolute",
          left: 115,
          top: 449,
          fontSize: 31,
          color: "#536960",
          lineHeight: 1.7,
          opacity: interpolate(frame, [75, 95, 382, 399], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        拿起水滴，对准纸面。
      </Interactive.Div>
    </Frame>
  );
};
