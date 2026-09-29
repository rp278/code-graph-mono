// Builds the audio for the video:
//   1. one voice-over clip per beat, using macOS `say` (no API key needed)
//   2. data/vo.json with each clip's length, which drives the video timeline
// (no background music: the video is voice-over only)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { buildTimeline, FPS } from '../src/timelineCore.js';

const root = new URL('../', import.meta.url).pathname;
const script = JSON.parse(readFileSync(root + 'data/script.json', 'utf8'));
mkdirSync(root + 'public/audio/vo', { recursive: true });

const seconds = {};
for (const scene of script.scenes) {
  for (const beat of scene.beats) {
    const aiff = `${root}public/audio/vo/${beat.id}.aiff`;
    const wav = `${root}public/audio/vo/${beat.id}.wav`;
    execFileSync('say', ['-v', script.voice, '-r', String(script.rate), '-o', aiff, beat.say || beat.text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@44100', '-c', '1', aiff, wav]);
    rmSync(aiff);
    const info = execFileSync('afinfo', [wav]).toString();
    seconds[beat.id] = parseFloat(info.match(/estimated duration:\s*([\d.]+)/)[1]);
    console.log(beat.id.padEnd(3), seconds[beat.id].toFixed(2) + 's');
  }
}
writeFileSync(root + 'data/vo.json', JSON.stringify(seconds, null, 2));

const tl = buildTimeline(script, seconds);
console.log(`\ntotal ${(tl.total / FPS).toFixed(1)}s (${tl.total} frames)`);
