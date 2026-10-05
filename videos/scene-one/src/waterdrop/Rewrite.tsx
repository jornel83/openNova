import {
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Pointer } from "../Visuals";
import { ComputerChrome, Frame } from "./Frame";

export const WaterdropRewrite = () => {
  const frame = useCurrentFrame();
  return (
    <Frame>
      <Interactive.Div
        name="Revision headline"
        style={{
          position: "absolute",
          left: 106,
          top: 146,
          fontSize: 76,
          fontWeight: 600,
          letterSpacing: -2,
        }}
      >
        把想法，说具体。
      </Interactive.Div>
      <Interactive.Div
        name="Desk context crop"
        style={{
          position: "absolute",
          left: 1502,
          top: 268,
          width: 310,
          height: 600,
          borderRadius: 24,
          overflow: "hidden",
          backgroundColor: "#e8e4dc",
        }}
      >
        <Img
          name="Waterdrop listening by the computer"
          src={staticFile("waterdrop/workspace.png")}
          style={{
            position: "absolute",
            width: 1180,
            height: 675,
            objectFit: "cover",
            left: -700,
            top: -75,
          }}
        />
        <Interactive.Div
          name="Voice remains ready"
          style={{
            position: "absolute",
            left: 20,
            right: 20,
            bottom: 34,
            padding: "22px 0",
            textAlign: "center",
            borderRadius: 18,
            backgroundColor: "#f7f7f0eb",
            fontSize: 27,
            color: "#3e5e56",
            lineHeight: 1.6,
          }}
        >
          自然交流
          <br />
          <span style={{ fontSize: 23, color: "#858a84" }}>Always On</span>
        </Interactive.Div>
      </Interactive.Div>
      <ComputerChrome>
        <Interactive.Div
          name="Selected paragraph label"
          style={{
            position: "absolute",
            left: 42,
            top: 106,
            fontSize: 24,
            color: "#8b8c84",
          }}
        >
          原文 · 当前选中段落
        </Interactive.Div>
        <Interactive.Div
          name="Selected abstract copy"
          style={{
            position: "absolute",
            left: 42,
            top: 151,
            width: 1260,
            boxSizing: "border-box",
            fontSize: 36,
            lineHeight: 1.5,
            color: "#6d7774",
            backgroundColor: "#eaf1ef",
            padding: "16px 22px",
            borderRadius: 10,
            opacity: interpolate(frame, [0, 20], [0.5, 1], {
              extrapolateRight: "clamp",
            }),
          }}
        >
          通过多模态智能理解，提高个人工作与生活效率。
        </Interactive.Div>
        <Interactive.Div
          name="Concrete rewrite proposal"
          style={{
            position: "absolute",
            left: 42,
            top: 272,
            width: 1260,
            height: 204,
            boxSizing: "border-box",
            borderRadius: 14,
            backgroundColor: "#edf5ef",
            borderLeft: "6px solid #6b9480",
            padding: "22px 28px",
            opacity: interpolate(frame, [154, 179], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            translate: interpolate(frame, [154, 179], ["0px 12px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          <div style={{ fontSize: 24, color: "#608570", marginBottom: 12 }}>
            建议修改
          </div>
          <div style={{ fontSize: 37, lineHeight: 1.55 }}>
            用户在路上想到新点子，直接开口；助手接续上午的讨论，
            <br />
            把想法留作待确认的记录。
          </div>
        </Interactive.Div>
        <Interactive.Div
          name="Apply revision control"
          style={{
            position: "absolute",
            right: 46,
            bottom: 31,
            borderRadius: 12,
            padding: "17px 32px",
            fontSize: 29,
            backgroundColor: "#355e53",
            color: "#fff",
            opacity: interpolate(frame, [210, 224, 335, 338], [0, 1, 1, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          确认采用
        </Interactive.Div>
        <Interactive.Div
          name="Revision saved after confirmation"
          style={{
            position: "absolute",
            right: 46,
            bottom: 40,
            fontSize: 29,
            color: "#426d59",
            opacity: interpolate(frame, [338, 348], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          ✓ 已更新文档
        </Interactive.Div>
        <Interactive.Div
          name="Revision review note"
          style={{
            position: "absolute",
            left: 48,
            bottom: 43,
            fontSize: 26,
            color: "#8a918a",
            opacity: interpolate(frame, [200, 220], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          对照阅读后，由用户确认修改
        </Interactive.Div>
        <Interactive.Div
          name="User confirms on computer"
          style={{
            position: "absolute",
            left: interpolate(frame, [312, 329], [790, 1144], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            top: interpolate(frame, [312, 329], [380, 542], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            scale: interpolate(frame, [329, 334, 338], [1, 0.88, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            opacity: interpolate(frame, [310, 316, 342, 350], [0, 1, 1, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          <Pointer left={0} top={0} />
        </Interactive.Div>
      </ComputerChrome>
    </Frame>
  );
};
