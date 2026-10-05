import { Interactive, interpolate, useCurrentFrame } from "remotion";
import { AssistantPanel, Dialogue, Frame, Paper, Pointer } from "./Visuals";
export const Selection = () => {
  const frame = useCurrentFrame();
  return (
    <Frame>
      <Paper>
        <Interactive.Div
          name="Document heading"
          style={{
            position: "absolute",
            left: 62,
            top: 128,
            fontSize: 60,
            fontWeight: 600,
          }}
        >
          共同完成一件事
        </Interactive.Div>
        <div
          style={{
            position: "absolute",
            left: 64,
            top: 230,
            fontSize: 28,
            color: "#8c978b",
          }}
        >
          当前段落 · 产品体验
        </div>
        <Interactive.Div
          name="Selected sentence"
          style={{
            position: "absolute",
            left: 55,
            top: 298,
            padding: "14px 10px",
            fontSize: 52,
            lineHeight: 1.6,
            whiteSpace: "nowrap",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: "#d9eadb",
              width: interpolate(frame, [20, 58], [0, 1038], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              borderRadius: 8,
            }}
          />
          <span style={{ position: "relative" }}>
            助手理解用户意图，支持高效协作。
          </span>
        </Interactive.Div>
        <div
          style={{
            position: "absolute",
            left: 66,
            top: 460,
            height: 10,
            width: 850,
            borderRadius: 8,
            background: "#edece4",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 66,
            top: 496,
            height: 10,
            width: 625,
            borderRadius: 8,
            background: "#edece4",
          }}
        />
        <Interactive.Div
          name="Selection hint"
          style={{
            position: "absolute",
            left: 66,
            top: 556,
            fontSize: 30,
            color: "#61836c",
            opacity: interpolate(frame, [58, 72], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          已选中这句话
        </Interactive.Div>
        <Pointer
          left={interpolate(frame, [12, 20, 58], [700, 70, 1090], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
          top={interpolate(frame, [12, 20, 58], [510, 366, 366], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
        />
      </Paper>
      <AssistantPanel state="正在倾听" detail="同一份文档，同一个对象。" />
      <Dialogue speaker="用户">这句太抽象，换成一个真实场景。</Dialogue>
    </Frame>
  );
};
