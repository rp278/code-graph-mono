// Shared by the audio script (node) and the video (Remotion): turns the
// measured voice-over lengths into frame positions for every scene and beat.
export const FPS = 30;
export const LEAD = 24; // frames of picture before the first line of a scene
export const GAP = 14; // frames of silence between lines
export const TAIL = 20; // frames after the last line of a scene

/**
 * @param {{scenes: {id: string, extra?: number, beats: {id: string}[]}[]}} script
 * @param {Record<string, number>} seconds  voice-over length per beat id
 */
export function buildTimeline(script, seconds) {
  const scenes = {};
  const beats = {};
  let cursor = 0;
  for (const scene of script.scenes) {
    const from = cursor;
    let t = LEAD;
    for (const beat of scene.beats) {
      const dur = Math.ceil((seconds[beat.id] ?? 3) * FPS);
      beats[beat.id] = { from: from + t, rel: t, dur, scene: scene.id };
      t += dur + GAP;
    }
    const len = t - GAP + TAIL + (scene.extra || 0);
    scenes[scene.id] = { from, len };
    cursor += len;
  }
  return { scenes, beats, total: cursor };
}
