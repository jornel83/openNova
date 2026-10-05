import {
  AbsoluteFill,
  Composition,
  Folder,
  Series,
  staticFile,
} from "remotion";
import { Audio } from "@remotion/media";
import { Opening } from "./Opening";
import { Selection } from "./Selection";
import { Rewrite } from "./Rewrite";
import { Decisions } from "./Decisions";

export const DesktopCollaboration = () => (
  <AbsoluteFill>
    <Series>
      <Series.Sequence name="Opening" durationInFrames={120}>
        <Opening />
      </Series.Sequence>
      <Series.Sequence name="Select a sentence" durationInFrames={150}>
        <Selection />
      </Series.Sequence>
      <Series.Sequence name="Review and apply" durationInFrames={180}>
        <Rewrite />
      </Series.Sequence>
      <Series.Sequence name="Save decisions" durationInFrames={270}>
        <Decisions />
      </Series.Sequence>
    </Series>
    <Audio
      name="User opening"
      from={26}
      src={staticFile("audio/01-user.mp3")}
    />
    <Audio
      name="User edit request"
      from={141}
      src={staticFile("audio/02-user.mp3")}
    />
    <Audio
      name="Assistant edit response"
      from={296}
      src={staticFile("audio/03-nova.mp3")}
    />
    <Audio
      name="User decision"
      from={466}
      src={staticFile("audio/04-user.mp3")}
    />
    <Audio
      name="Assistant saved response"
      from={616}
      src={staticFile("audio/05-nova.mp3")}
    />
  </AbsoluteFill>
);

export const MyComposition = () => (
  <>
    <Composition
      id="DesktopCollaboration"
      component={DesktopCollaboration}
      durationInFrames={720}
      fps={30}
      width={1920}
      height={1080}
    />
    <Folder name="Scenes">
      <Composition
        id="Opening"
        component={Opening}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Selection"
        component={Selection}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Rewrite"
        component={Rewrite}
        durationInFrames={180}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Decisions"
        component={Decisions}
        durationInFrames={270}
        fps={30}
        width={1920}
        height={1080}
      />
    </Folder>
  </>
);
