import { Interactive, interpolate, useCurrentFrame } from "remotion";
import { AssistantPanel, Dialogue, Frame, Paper } from "./Visuals";
export const Decisions = () => {
  const frame = useCurrentFrame();
  return (
    <Frame>
      <Paper label="产品概念文档 · 决定记录">
        <Interactive.Div
          name="Decisions title"
          style={{
            position: "absolute",
            left: 62,
            top: 128,
            fontSize: 60,
            fontWeight: 600,
          }}
        >
          记住决定，也保留未定
        </Interactive.Div>
        <Interactive.Div
          name="Confirmed decision"
          style={{
            position: "absolute",
            left: 58,
            right: 58,
            top: 256,
            borderRadius: 20,
            background: "#e4edde",
            padding: "24px 32px",
            display: "flex",
            alignItems: "center",
            gap: 44,
            opacity: interpolate(frame, [58, 82], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            translate: interpolate(frame, [58, 82], ["0px 14px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          <span style={{ fontSize: 30, color: "#537859" }}>✓ 已决定</span>
          <span style={{ fontSize: 54, fontWeight: 550 }}>保留桌面方案</span>
        </Interactive.Div>
        <Interactive.Div
          name="Open decision"
          style={{
            position: "absolute",
            left: 58,
            right: 58,
            top: 406,
            borderRadius: 20,
            background: "#f2eadb",
            padding: "24px 32px",
            display: "flex",
            alignItems: "center",
            gap: 44,
            opacity: interpolate(frame, [108, 132], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            translate: interpolate(frame, [108, 132], ["0px 14px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          <span style={{ fontSize: 30, color: "#9c8154" }}>○ 待确定</span>
          <span style={{ fontSize: 54, fontWeight: 550 }}>随身入口</span>
        </Interactive.Div>
        <Interactive.Div
          name="Saved status"
          style={{
            position: "absolute",
            left: 68,
            top: 570,
            fontSize: 28,
            color: "#71816b",
            opacity: interpolate(frame, [158, 173], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          ✓ 文档与决定已保存
        </Interactive.Div>
      </Paper>
      <AssistantPanel
        state={frame > 156 ? "这次协作已记录" : "正在记录决定"}
        detail={frame > 156 ? "下次，从这里继续。" : "确定与待定，分别保存。"}
      />
      {frame < 162 ? (
        <Dialogue speaker="用户">保留桌面方案，随身入口待定。</Dialogue>
      ) : (
        <Dialogue speaker="openNova">已保存，随身入口仍然待定。</Dialogue>
      )}
    </Frame>
  );
};
