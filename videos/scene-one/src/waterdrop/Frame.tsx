import type { ReactNode } from "react";
import { AbsoluteFill, Interactive } from "remotion";

export const Frame = ({ children }: { children: ReactNode }) => (
  <AbsoluteFill
    style={{
      backgroundColor: "#f4f2ee",
      color: "#242b2d",
      fontFamily: '"PingFang SC", "Helvetica Neue", sans-serif',
    }}
  >
    {children}
    <Interactive.Div
      name="openNova brand"
      style={{
        position: "absolute",
        left: 108,
        top: 56,
        fontSize: 38,
        fontWeight: 600,
        letterSpacing: -1,
      }}
    >
      openNova
    </Interactive.Div>
    <Interactive.Div
      name="Concept disclosure"
      style={{
        position: "absolute",
        right: 108,
        top: 66,
        fontSize: 24,
        color: "#62696b",
      }}
    >
      概念演示 · 非实机画面
    </Interactive.Div>
  </AbsoluteFill>
);

export const ComputerChrome = ({ children }: { children: ReactNode }) => (
  <Interactive.Div
    name="Shared computer window"
    style={{
      position: "absolute",
      left: 108,
      top: 268,
      width: 1350,
      height: 600,
      borderRadius: 22,
      backgroundColor: "#fff",
      border: "2px solid #e0e1dd",
      boxShadow: "0 22px 65px #3d3c3220",
      overflow: "hidden",
    }}
  >
    <Interactive.Div
      name="Computer window heading"
      style={{
        height: 78,
        paddingLeft: 36,
        paddingRight: 36,
        display: "flex",
        alignItems: "center",
        gap: 26,
        borderBottom: "2px solid #eceeea",
        color: "#707776",
        fontSize: 25,
      }}
    >
      <span style={{ letterSpacing: 8, color: "#c0c5c2", fontSize: 20 }}>
        ● ● ●
      </span>
      <span>电脑 · 已共享文档</span>
      <span style={{ marginLeft: "auto", color: "#2d7366" }}>
        openNova 产品概念
      </span>
    </Interactive.Div>
    {children}
  </Interactive.Div>
);
