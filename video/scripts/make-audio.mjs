// Builds the audio for the video:
//   1. one voice-over clip per beat, using macOS `say` (no API key needed)
//   2. data/vo.json with each clip's length, which drives the video timeline
//   3. public/audio/music.wav, a soft ambient pad sized to the whole video
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
const totalSec = tl.total / FPS + 1;
console.log(`\ntotal ${totalSec.toFixed(1)}s (${tl.total} frames)`);

// ---- ambient pad: slow Am - F - C - G, soft sines with gentle movement -----
const SR = 44100;
const n = Math.floor(totalSec * SR);
const out = new Int16Array(n * 2);
const chords = [
  [220.0, 261.63, 329.63], // Am
  [174.61, 220.0, 261.63], // F
  [261.63, 329.63, 392.0], // C
  [196.0, 246.94, 293.66], // G
];
const bar = 8; // seconds per chord
const fade = (t) => Math.min(1, t / 3, (totalSec - t) / 4);
for (let i = 0; i < n; i++) {
  const t = i / SR;
  const idx = Math.floor(t / bar);
  const local = t - idx * bar;
  const env = Math.min(1, local / 2.5, (bar - local) / 2.5 + 0.35); // overlap-ish swell
  let l = 0;
  let r = 0;
  const chord = chords[idx % chords.length];
  chord.forEach((f, k) => {
    const wobble = 1 + 0.0025 * Math.sin(2 * Math.PI * (0.11 + k * 0.03) * t);
    l += Math.sin(2 * Math.PI * f * 0.998 * wobble * t) * 0.9;
    r += Math.sin(2 * Math.PI * f * 1.002 * wobble * t) * 0.9;
    l += Math.sin(2 * Math.PI * f * 2 * t) * 0.18;
    r += Math.sin(2 * Math.PI * f * 2 * 1.001 * t) * 0.18;
  });
  const sub = Math.sin(2 * Math.PI * (chord[0] / 2) * t) * 0.5;
  const g = 0.11 * env * fade(t);
  out[i * 2] = Math.max(-1, Math.min(1, (l + sub) * g)) * 32767;
  out[i * 2 + 1] = Math.max(-1, Math.min(1, (r + sub) * g)) * 32767;
}
const dataBytes = out.length * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write('WAVEfmt ', 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(dataBytes, 40);
Buffer.from(out.buffer).copy(buf, 44);
writeFileSync(root + 'public/audio/music.wav', buf);
console.log('wrote public/audio/music.wav');
