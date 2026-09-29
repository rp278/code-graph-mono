import React from 'react';
import { AbsoluteFill, Composition, Sequence, interpolate, useCurrentFrame } from 'remotion';
import { Concept, Intro, Outro } from './Scenes';
import { H, TREE_FRAMES, TreeScene, W } from './TreeScene';
import { OVERVIEW_FRAMES, Overview } from './Overview';

const FPS = 30;
const INTRO = 105;
const CONCEPT = 195;
const OUTRO = 165;
const FADE = 12;

export const TOTAL = INTRO + CONCEPT + TREE_FRAMES + OUTRO;

const Fade: React.FC<{ duration: number; children: React.ReactNode }> = ({ duration, children }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, FADE, duration - FADE, duration], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

const TreeConcept: React.FC = () => (
  <AbsoluteFill style={{ background: '#0a0e14' }}>
    <Sequence from={0} durationInFrames={INTRO}>
      <Fade duration={INTRO}><Intro /></Fade>
    </Sequence>
    <Sequence from={INTRO} durationInFrames={CONCEPT}>
      <Fade duration={CONCEPT}><Concept /></Fade>
    </Sequence>
    <Sequence from={INTRO + CONCEPT} durationInFrames={TREE_FRAMES}>
      <Fade duration={TREE_FRAMES}><TreeScene /></Fade>
    </Sequence>
    <Sequence from={INTRO + CONCEPT + TREE_FRAMES} durationInFrames={OUTRO}>
      <Fade duration={OUTRO}><Outro /></Fade>
    </Sequence>
  </AbsoluteFill>
);

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="CodeGraphOverview" component={Overview} durationInFrames={OVERVIEW_FRAMES} fps={FPS} width={W} height={H} />
    <Composition id="TreeConcept" component={TreeConcept} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />
  </>
);
