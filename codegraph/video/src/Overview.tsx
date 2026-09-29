import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import script from '../data/script.json';
import vo from '../data/vo.json';
import { GAP, TAIL, buildTimeline } from './timelineCore.js';
import { IntroScene, OutroScene } from './OverviewScenes';
import { GraphScreen } from './GraphScreen';
import { AskScreen } from './AskScreen';
import { FixScreen } from './FixScreen';
import { Subtitle, fade } from './AppUi';
import { TREE_CLICKS } from './TreeCanvas';
import { useCurrentFrame } from 'remotion';

type Timeline = {
  scenes: Record<string, { from: number; len: number }>;
  beats: Record<string, { from: number; rel: number; dur: number; scene: string }>;
  total: number;
};
export const TL = buildTimeline(script as never, vo as Record<string, number>) as Timeline;
export const OVERVIEW_FRAMES = TL.total;

const beatsOf = (sceneId: string) => {
  const s = (script.scenes as { id: string; beats: { id: string }[] }[]).find((x) => x.id === sceneId)!;
  return Object.fromEntries(s.beats.map((b) => [b.id, { rel: TL.beats[b.id].rel, dur: TL.beats[b.id].dur }]));
};

const SceneFade: React.FC<{ len: number; children: React.ReactNode }> = ({ len, children }) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: fade(f, len, 10, 10) }}>{children}</AbsoluteFill>;
};

export const Overview: React.FC = () => {
  const graphBeats = beatsOf('graph');
  // fit the whole tree walkthrough into the last line of the graph scene
  const g4 = graphBeats.g4;
  const graphLen = TL.scenes.graph.len;
  const treeStep = Math.max(20, Math.floor((graphLen - g4.rel - 12 - 16 - TAIL) / TREE_CLICKS));
  const scenes: Record<string, React.ReactNode> = {
    intro: <IntroScene beats={beatsOf('intro')} />,
    graph: <GraphScreen beats={graphBeats} treeStepFrames={treeStep} />,
    ask: <AskScreen beats={beatsOf('ask')} />,
    fix: <FixScreen beats={beatsOf('fix')} />,
    outro: <OutroScene beats={beatsOf('outro')} />,
  };
  const texts = Object.fromEntries((script.scenes as any[]).flatMap((s) => s.beats.map((b: any) => [b.id, b.text])));
  return (
    <AbsoluteFill style={{ background: '#05080c' }}>
      {Object.entries(TL.scenes).map(([id, s]) => (
        <Sequence key={id} from={s.from} durationInFrames={s.len}>
          <SceneFade len={s.len}>{scenes[id]}</SceneFade>
        </Sequence>
      ))}
      {Object.entries(TL.beats).map(([id, b]) => (
        <React.Fragment key={id}>
          <Sequence from={b.from} durationInFrames={b.dur + GAP}>
            <Audio src={staticFile(`audio/vo/${id}.wav`)} volume={1} />
          </Sequence>
          <Sequence from={b.from} durationInFrames={b.dur + 4}>
            <Subtitle text={texts[id]} from={0} dur={b.dur} />
          </Sequence>
        </React.Fragment>
      ))}
    </AbsoluteFill>
  );
};
