import {
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Frame } from "./Frame";

export const WaterdropDecisions = () => {
  const frame = useCurrentFrame();
  return (
    <Frame>
      <Interactive.Div
        name="Remember the shared decision"
        style={{
          position: "absolute",
          left: 106,
          top: 146,
          fontSize: 76,
          fontWeight: 600,
          letterSpacing: -2,
        }}
      >
        记住我们定下的方向。
      </Interactive.Div>
      <Interactive.Div
        name="Computer decision record label"
        style={{
          position: "absolute",
          left: 114,
          top: 262,
          fontSize: 27,
          color: "#75817a",
        }}
      >
        电脑 · 本次讨论的外观方案
      </Interactive.Div>
      <Interactive.Div
        name="Primary Waterdrop card"
        style={{
          position: "absolute",
          left: 108,
          top: 324,
          width: 1004,
          height: 504,
          borderRadius: 24,
          backgroundColor: "#fff",
          overflow: "hidden",
          boxShadow: "0 16px 44px #3d3c3214",
        }}
      >
        <Img
          name="Primary Waterdrop design"
          src={staticFile("waterdrop/workspace.png")}
          style={{
            position: "absolute",
            width: 1060,
            height: 606,
            objectFit: "cover",
            left: 10,
            top: -52,
          }}
        />
        <Interactive.Div
          name="Primary design caption"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 560,
            background:
              "linear-gradient(90deg, #ffffff 0%, #ffffffeb 57%, #ffffff00 100%)",
            padding: "53px 46px",
          }}
        >
          <div style={{ color: "#5e816f", fontSize: 27, marginBottom: 26 }}>
            主方案
          </div>
          <div style={{ fontSize: 62, fontWeight: 600 }}>D 水滴</div>
          <div
            style={{
              fontSize: 27,
              color: "#839088",
              marginTop: 25,
              lineHeight: 1.8,
            }}
          >
            随身佩戴
            <br />
            回家归座
          </div>
        </Interactive.Div>
      </Interactive.Div>
      <Interactive.Div
        name="Backup micro ring card"
        style={{
          position: "absolute",
          left: 1154,
          top: 324,
          width: 658,
          height: 504,
          borderRadius: 24,
          backgroundColor: "#e8e7e2",
          overflow: "hidden",
        }}
      >
        <Img
          name="Backup micro ring design"
          src={staticFile("waterdrop/ring-backup-dock.png")}
          style={{
            position: "absolute",
            width: 756,
            height: 504,
            left: -45,
            top: 0,
            objectFit: "cover",
          }}
        />
        <Interactive.Div
          name="Backup design caption"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            padding: "28px 34px",
            backgroundColor: "#ffffffee",
          }}
        >
          <div style={{ fontSize: 24, color: "#828983", marginBottom: 9 }}>
            保留备选
          </div>
          <div style={{ fontSize: 38, fontWeight: 500 }}>A 微型圆环</div>
        </Interactive.Div>
      </Interactive.Div>
      <Interactive.Div
        name="Decision recorded after user speaks"
        style={{
          position: "absolute",
          right: 112,
          top: 265,
          fontSize: 27,
          color: "#427359",
          opacity: interpolate(frame, [128, 147], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        ✓ 已记入项目，可随时更正
      </Interactive.Div>
    </Frame>
  );
};
