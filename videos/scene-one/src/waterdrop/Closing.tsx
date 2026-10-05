import {
  AbsoluteFill,
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Frame } from "./Frame";

export const WaterdropClosing = () => {
  const frame = useCurrentFrame();
  return (
    <Frame>
      <Img
        name="Waterdrop returned to charge"
        src={staticFile("waterdrop/workspace.png")}
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          objectFit: "cover",
          scale: interpolate(frame, [0, 180], [1.025, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(90deg, #f5f2edfa 0%, #f5f2edea 31%, #f5f2ed70 51%, #f5f2ed00 70%), linear-gradient(180deg, #f4f2eecc 0%, #f4f2ee00 22%)",
        }}
      />
      <Interactive.Div
        name="Close vision keep conversation"
        style={{
          position: "absolute",
          left: 113,
          top: 229,
          color: "#728278",
          fontSize: 31,
          letterSpacing: 3,
        }}
      >
        视觉已关闭 · 语音持续可用
      </Interactive.Div>
      <Interactive.Div
        name="Conversation continues"
        style={{
          position: "absolute",
          left: 103,
          top: 325,
          fontSize: 130,
          fontWeight: 600,
          lineHeight: 1.2,
          letterSpacing: -5,
          opacity: interpolate(frame, [0, 22], [0, 1], {
            extrapolateRight: "clamp",
          }),
          translate: interpolate(frame, [0, 22], ["0px 16px", "0px 0px"], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        交流，
        <br />
        自然继续。
      </Interactive.Div>
      <Interactive.Div
        name="Always On closing"
        style={{
          position: "absolute",
          left: 115,
          top: 694,
          fontSize: 37,
          color: "#4d6a5e",
        }}
      >
        Always On · 随时开口，一起推进
      </Interactive.Div>
    </Frame>
  );
};
