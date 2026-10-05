import { Video } from "@remotion/media";
import {
  AbsoluteFill,
  Composition,
  Easing,
  Folder,
  Interactive,
  interpolate,
  Series,
  staticFile,
  useCurrentFrame,
} from "remotion";

type SceneTitleProps = {
  title: string;
  number: string;
};

export const SceneTitle = ({ title, number }: SceneTitleProps) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      name="场景标题页"
      style={{
        backgroundColor: "#06080c",
        backgroundImage:
          "radial-gradient(ellipse at 50% 44%, rgba(46, 56, 73, 0.25) 0%, rgba(6, 8, 12, 0) 66%)",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: '"PingFang SC", "Hiragino Sans GB", sans-serif',
      }}
    >
      <Interactive.Div
        name="标题与品牌"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          opacity: interpolate(frame, [0, 7, 50, 59], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          translate: interpolate(frame, [0, 7], ["0px 10px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <Interactive.Div
          name="openNova 品牌"
          style={{
            color: "#a4adb9",
            fontFamily: '"Helvetica Neue", Arial, sans-serif',
            fontSize: 24,
            fontWeight: 400,
            lineHeight: 1,
            letterSpacing: 3,
            marginBottom: 36,
          }}
        >
          openNova
        </Interactive.Div>
        <Interactive.Div
          name="场景名称"
          style={{
            color: "#f5f6f8",
            fontSize: 100,
            fontWeight: 500,
            lineHeight: 1.2,
            letterSpacing: 8,
            paddingLeft: 8,
            marginBottom: 32,
          }}
        >
          {title}
        </Interactive.Div>
        <Interactive.Div
          name="场景编号"
          style={{
            color: "#75808f",
            fontFamily: '"Helvetica Neue", Arial, sans-serif',
            fontSize: 16,
            fontWeight: 400,
            lineHeight: 1.125,
            letterSpacing: 4,
            paddingLeft: 4,
          }}
        >
          {number}
        </Interactive.Div>
      </Interactive.Div>
    </AbsoluteFill>
  );
};

export const ProductConceptFilm = () => (
  <AbsoluteFill style={{ backgroundColor: "#06080c" }}>
    <Series>
      <Series.Sequence name="01 工作协作 标题页" durationInFrames={60}>
        <SceneTitle title="工作协作" number="01" />
      </Series.Sequence>
      <Series.Sequence name="01 工作协作 演示" durationInFrames={386}>
        <Video
          name="工作协作原片"
          src={staticFile("concept-film/scene-one.mp4")}
          trimBefore={0}
          volume={1}
          objectFit="contain"
          style={{ width: "100%", height: "100%" }}
        />
      </Series.Sequence>
      <Series.Sequence name="02 随身交流 标题页" durationInFrames={60}>
        <SceneTitle title="随身交流" number="02" />
      </Series.Sequence>
      <Series.Sequence name="02 随身交流 演示" durationInFrames={386}>
        <Video
          name="随身交流原片"
          src={staticFile("concept-film/scene-two.mp4")}
          trimBefore={0}
          volume={1}
          objectFit="contain"
          style={{ width: "100%", height: "100%" }}
        />
      </Series.Sequence>
      <Series.Sequence name="03 日常陪伴 标题页" durationInFrames={60}>
        <SceneTitle title="日常陪伴" number="03" />
      </Series.Sequence>
      <Series.Sequence name="03 日常陪伴 演示" durationInFrames={386}>
        <Video
          name="日常陪伴原片"
          src={staticFile("concept-film/scene-three.mp4")}
          trimBefore={0}
          volume={1}
          objectFit="contain"
          style={{ width: "100%", height: "100%" }}
        />
      </Series.Sequence>
    </Series>
  </AbsoluteFill>
);

export const ProductConceptCompositions = () => (
  <Folder name="ProductConcept">
    <Composition
      id="ProductConceptFilm"
      component={ProductConceptFilm}
      durationInFrames={1338}
      fps={24}
      width={1280}
      height={720}
    />
    <Composition
      id="TitleWork"
      component={SceneTitle}
      durationInFrames={60}
      fps={24}
      width={1280}
      height={720}
      defaultProps={{ title: "工作协作", number: "01" }}
    />
    <Composition
      id="TitleEverywhere"
      component={SceneTitle}
      durationInFrames={60}
      fps={24}
      width={1280}
      height={720}
      defaultProps={{ title: "随身交流", number: "02" }}
    />
    <Composition
      id="TitleCompanionship"
      component={SceneTitle}
      durationInFrames={60}
      fps={24}
      width={1280}
      height={720}
      defaultProps={{ title: "日常陪伴", number: "03" }}
    />
  </Folder>
);
