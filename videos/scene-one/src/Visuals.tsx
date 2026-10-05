import React from "react";
import {
  AbsoluteFill,
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

export const Frame: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <AbsoluteFill
    style={{
      backgroundColor: "#eeede8",
      color: "#182d2b",
      fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
    }}
  >
    <Interactive.Div
      name="Brand"
      style={{
        position: "absolute",
        left: 120,
        top: 56,
        fontSize: 38,
        fontWeight: 650,
        letterSpacing: -1,
      }}
    >
      openNova
      <span
        style={{
          fontWeight: 400,
          color: "#84908b",
          marginLeft: 30,
          fontSize: 28,
        }}
      >
        桌面协作
      </span>
    </Interactive.Div>
    <Interactive.Div
      name="Concept label"
      style={{
        position: "absolute",
        right: 120,
        top: 62,
        fontSize: 26,
        color: "#75817b",
      }}
    >
      概念演示 · 非实机画面
    </Interactive.Div>
    {children}
  </AbsoluteFill>
);
export const Dialogue: React.FC<{
  speaker: string;
  children: React.ReactNode;
}> = ({ speaker, children }) => (
  <Interactive.Div
    name="Dialogue"
    style={{
      position: "absolute",
      left: 120,
      right: 120,
      bottom: 66,
      height: 128,
      borderRadius: 22,
      background: "#182d2b",
      color: "#fff",
      display: "flex",
      alignItems: "center",
      padding: "0 46px",
      gap: 32,
    }}
  >
    <span style={{ fontSize: 28, color: "#9cc5b3", whiteSpace: "nowrap" }}>
      {speaker}
    </span>
    <span style={{ fontSize: 48, fontWeight: 500, letterSpacing: 0.5 }}>
      {children}
    </span>
  </Interactive.Div>
);
export const AssistantPanel: React.FC<{ state: string; detail: string }> = ({
  state,
  detail,
}) => {
  const frame = useCurrentFrame();
  return (
    <Interactive.Div
      name="Assistant terminal"
      style={{
        position: "absolute",
        right: 120,
        top: 176,
        width: 440,
        height: 674,
        borderRadius: 30,
        background: "#dcded5",
        overflow: "hidden",
      }}
    >
      <Img
        src={staticFile("desktop-concept.png")}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 440,
          height: 430,
          objectFit: "cover",
          objectPosition: "69% center",
        }}
      />
      <div style={{ position: "absolute", top: 450, left: 34, right: 28 }}>
        <div style={{ fontSize: 24, color: "#61786c", marginBottom: 14 }}>
          openNova
        </div>
        <div
          style={{
            fontSize: 36,
            fontWeight: 550,
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 13,
              height: 13,
              borderRadius: 20,
              background: "#5b977b",
              opacity: interpolate(
                frame,
                [0, 20, 40, 60, 80],
                [0.4, 1, 0.5, 1, 0.6],
                { extrapolateRight: "clamp" },
              ),
            }}
          />
          {state}
        </div>
        <div
          style={{
            fontSize: 27,
            lineHeight: 1.5,
            color: "#5e7066",
            marginTop: 18,
          }}
        >
          {detail}
        </div>
      </div>
    </Interactive.Div>
  );
};
export const Paper: React.FC<{ children: React.ReactNode; label?: string }> = ({
  children,
  label = "产品概念文档",
}) => (
  <Interactive.Div
    name="Shared document"
    style={{
      position: "absolute",
      left: 120,
      top: 176,
      width: 1196,
      height: 674,
      background: "#fffefa",
      borderRadius: 30,
      boxShadow: "0 20px 50px #1b39280a",
      border: "1px solid #dfdfd4",
      overflow: "hidden",
    }}
  >
    <div
      style={{
        height: 80,
        borderBottom: "1px solid #e8e8df",
        display: "flex",
        alignItems: "center",
        padding: "0 40px",
        gap: 10,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          background: "#adc1b2",
          borderRadius: 10,
        }}
      />
      <span
        style={{
          width: 10,
          height: 10,
          background: "#d9ddcd",
          borderRadius: 10,
        }}
      />
      <span
        style={{
          width: 10,
          height: 10,
          background: "#e7e9e0",
          borderRadius: 10,
        }}
      />
      <span style={{ fontSize: 26, color: "#78867a", marginLeft: 22 }}>
        {label}
      </span>
      <span style={{ marginLeft: "auto", fontSize: 24, color: "#9aab9d" }}>
        共同编辑
      </span>
    </div>
    {children}
  </Interactive.Div>
);
export const Pointer: React.FC<{
  left: number;
  top: number;
  opacity?: number;
}> = ({ left, top, opacity = 1 }) => (
  <div
    style={{
      position: "absolute",
      left,
      top,
      opacity,
      filter: "drop-shadow(0px 3px 3px #0003)",
    }}
  >
    <svg width="44" height="52" viewBox="0 0 44 52">
      <path
        d="M4 3 L35 29 L21 31 L15 46 Z"
        fill="#18362c"
        stroke="#fff"
        strokeWidth="3"
      />
    </svg>
  </div>
);
