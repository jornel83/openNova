import { Interactive, interpolate, useCurrentFrame } from "remotion";
import { AssistantPanel, Dialogue, Frame, Paper, Pointer } from "./Visuals";
export const Rewrite = () => {
  const frame = useCurrentFrame();
  return (
    <Frame>
      <Paper>
        <div
          style={{
            position: "absolute",
            left: 62,
            top: 126,
            fontSize: 27,
            color: "#859182",
          }}
        >
          修改建议
        </div>
        <Interactive.Div
          name="Original sentence"
          style={{
            position: "absolute",
            left: 62,
            top: 182,
            fontSize: 41,
            lineHeight: 1.5,
            color: "#9ba396",
            textDecoration: "line-through",
            textDecorationColor: "#bbc1b3",
          }}
        >
          助手理解用户意图，支持高效协作。
        </Interactive.Div>
        <Interactive.Div
          name="Concrete scenario"
          style={{
            position: "absolute",
            left: 48,
            right: 48,
            top: 274,
            padding: "20px 20px",
            borderRadius: 18,
            background: "#e5efdf",
            fontSize: 60,
            lineHeight: 1.5,
            fontWeight: 550,
            opacity: interpolate(frame, [5, 25], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            translate: interpolate(frame, [5, 25], ["0px 15px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          开会前，把三份资料
          <br />
          整理成一页提纲。
        </Interactive.Div>
        <Interactive.Div
          name="Apply edit"
          style={{
            position: "absolute",
            right: 54,
            bottom: 38,
            padding: "16px 30px",
            color: "#fff",
            background: frame > 146 ? "#618468" : "#1d4136",
            fontSize: 30,
            borderRadius: 14,
            opacity: interpolate(frame, [70, 90], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            scale: interpolate(frame, [144, 147, 152], [1, 0.96, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          {frame > 146 ? "✓ 已应用修改" : "应用修改"}
        </Interactive.Div>
        <div
          style={{
            position: "absolute",
            left: 68,
            bottom: 55,
            fontSize: 27,
            color: "#8a9485",
          }}
        >
          把抽象描述变成具体行动
        </div>
        <Pointer
          left={interpolate(frame, [110, 140], [710, 1080], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
          top={interpolate(frame, [110, 140], [550, 608], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
          opacity={interpolate(frame, [108, 116], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
        />
      </Paper>
      <AssistantPanel
        state={frame > 146 ? "修改已保存" : "等待你确认"}
        detail={frame > 146 ? "结果已写入当前文档。" : "改了哪里，一眼可见。"}
      />
      <Dialogue speaker="openNova">已改写，请看这一处变化。</Dialogue>
    </Frame>
  );
};
