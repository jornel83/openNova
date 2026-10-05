import {
  AbsoluteFill,
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
export const Opening = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#172725",
        fontFamily: '"PingFang SC", sans-serif',
        color: "#fff",
      }}
    >
      <Img
        name="Desk scene"
        src={staticFile("desktop-concept.png")}
        style={{
          width: 1920,
          height: 1280,
          position: "absolute",
          top: -90,
          objectFit: "cover",
          scale: interpolate(frame, [0, 120], [1.02, 1.07], {
            extrapolateRight: "clamp",
          }),
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(90deg, rgba(12,30,28,0.96) 0%, rgba(12,30,28,0.83) 30%, rgba(12,30,28,0.12) 65%, transparent 100%)",
        }}
      />
      <Interactive.Div
        name="Brand"
        style={{
          position: "absolute",
          left: 120,
          top: 68,
          fontSize: 40,
          fontWeight: 600,
        }}
      >
        openNova
      </Interactive.Div>
      <Interactive.Div
        name="Concept label"
        style={{
          position: "absolute",
          right: 120,
          top: 75,
          color: "#fff",
          fontSize: 26,
          textShadow: "0 1px 10px #0008",
        }}
      >
        概念演示 · 形态示意
      </Interactive.Div>
      <Interactive.Div
        name="Scene number"
        style={{
          position: "absolute",
          left: 124,
          top: 302,
          color: "#b9d4c7",
          fontSize: 32,
          letterSpacing: 6,
          opacity: interpolate(frame, [0, 18], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        场景 01
      </Interactive.Div>
      <Interactive.Div
        name="Main title"
        style={{
          position: "absolute",
          left: 110,
          top: 366,
          fontSize: 150,
          fontWeight: 550,
          letterSpacing: -5,
          opacity: interpolate(frame, [5, 24], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          translate: interpolate(frame, [5, 24], ["0px 25px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        桌面协作
      </Interactive.Div>
      <Interactive.Div
        name="Opening line"
        style={{
          position: "absolute",
          left: 126,
          top: 564,
          fontSize: 49,
          color: "#e2eae2",
          opacity: interpolate(frame, [20, 36], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        一起讨论，直接推进。
      </Interactive.Div>
      <Interactive.Div
        name="Opening dialogue"
        style={{
          position: "absolute",
          left: 126,
          bottom: 110,
          fontSize: 40,
          color: "#eff4ed",
          opacity: interpolate(frame, [25, 38], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        <span style={{ color: "#a6c3b5", marginRight: 24, fontSize: 27 }}>
          用户
        </span>
        这份资料，我们一起改。
      </Interactive.Div>
    </AbsoluteFill>
  );
};
