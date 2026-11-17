import * as Tone from 'tone';
import { TPB, type Chord, type Song } from '../model';
import { generateLeftHand } from '../music/accompaniment';
import { midiToHz } from '../audio/pitch';

let sampler: Tone.Sampler | null = null;
let fallback: Tone.PolySynth | null = null;
let loading: Promise<void> | null = null;

/** Tải tiếng piano thật (Salamander). Nếu không tải được thì dùng tiếng tổng hợp. */
function loadPiano(): Promise<void> {
  if (!loading) {
    loading = new Promise<void>((resolve) => {
      const done = () => resolve();
      try {
        sampler = new Tone.Sampler({
          urls: {
            A0: 'A0.mp3', C1: 'C1.mp3', 'D#1': 'Ds1.mp3', 'F#1': 'Fs1.mp3', A1: 'A1.mp3', C2: 'C2.mp3', 'D#2': 'Ds2.mp3',
            'F#2': 'Fs2.mp3', A2: 'A2.mp3', C3: 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3', A3: 'A3.mp3', C4: 'C4.mp3',
            'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3', A4: 'A4.mp3', C5: 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3', A5: 'A5.mp3',
            C6: 'C6.mp3', 'D#6': 'Ds6.mp3', 'F#6': 'Fs6.mp3', A6: 'A6.mp3', C7: 'C7.mp3',
          },
          release: 1,
          baseUrl: 'https://tonejs.github.io/audio/salamander/',
          onload: done,
          onerror: () => {
            sampler = null;
            done();
          },
        }).toDestination();
      } catch {
        sampler = null;
        done();
      }
      // quá 8 giây chưa tải xong thì dùng tạm tiếng tổng hợp
      setTimeout(done, 8000);
    });
  }
  return loading;
}

function instrument(): { play: (midi: number, dur: number, time: number, vel: number) => void } {
  if (sampler && sampler.loaded) {
    const s = sampler;
    return { play: (m, d, t, v) => s.triggerAttackRelease(midiToHz(m), d, t, v) };
  }
  if (!fallback) {
    fallback = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.005, decay: 0.3, sustain: 0.25, release: 0.8 },
    }).toDestination();
    fallback.volume.value = -10;
  }
  const f = fallback;
  return { play: (m, d, t, v) => f.triggerAttackRelease(midiToHz(m), d, t, v) };
}

export interface PlayOptions {
  melody: boolean;
  accompaniment: boolean;
  fromTick?: number;
  onEnd?: () => void;
}

let endTimer: number | null = null;

export async function play(song: Song, chords: Chord[], o: PlayOptions): Promise<void> {
  await Tone.start();
  await loadPiano();
  stop();
  const tr = Tone.getTransport();
  const tickSec = 60 / song.tempo / TPB;
  const from = o.fromTick ?? 0;
  const inst = instrument();
  let endTick = from;
  if (o.melody) {
    for (const n of song.notes) {
      if (n.start < from) continue;
      tr.schedule((time) => inst.play(n.midi, n.dur * tickSec * 0.95, time, 0.85), (n.start - from) * tickSec);
      endTick = Math.max(endTick, n.start + n.dur);
    }
  }
  if (o.accompaniment) {
    for (const n of generateLeftHand(chords, song.lhPattern, song.beatsPerMeasure)) {
      if (n.start < from) continue;
      tr.schedule((time) => inst.play(n.midi, n.dur * tickSec * 0.95, time, 0.5), (n.start - from) * tickSec);
      endTick = Math.max(endTick, n.start + n.dur);
    }
  }
  tr.start('+0.05');
  const totalMs = (endTick - from) * tickSec * 1000 + 600;
  endTimer = window.setTimeout(() => {
    stop();
    o.onEnd?.();
  }, totalMs);
}

export function stop(): void {
  if (endTimer !== null) {
    clearTimeout(endTimer);
    endTimer = null;
  }
  const tr = Tone.getTransport();
  tr.stop();
  tr.cancel(0);
  sampler?.releaseAll();
  fallback?.releaseAll();
}

/** Vị trí đang phát (giây kể từ lúc bấm phát), hoặc -1 nếu đang dừng. */
export function position(): number {
  const tr = Tone.getTransport();
  return tr.state === 'started' ? tr.seconds : -1;
}

/** Nghe trước một nốt khi sửa. */
export async function previewNote(midi: number): Promise<void> {
  await Tone.start();
  void loadPiano();
  instrument().play(midi, 0.35, Tone.now(), 0.7);
}

/** Phát lại bản thu giọng gốc. */
let voiceSrc: AudioBufferSourceNode | null = null;
export async function playVoice(audio16k: Float32Array, onEnd?: () => void): Promise<void> {
  await Tone.start();
  stopVoice();
  const ctx = Tone.getContext().rawContext as AudioContext;
  const buf = ctx.createBuffer(1, audio16k.length, 16000);
  buf.copyToChannel(audio16k as Float32Array<ArrayBuffer>, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.onended = () => {
    if (voiceSrc === src) voiceSrc = null;
    onEnd?.();
  };
  src.start();
  voiceSrc = src;
}

export function stopVoice(): void {
  try {
    voiceSrc?.stop();
  } catch {
    /* đã dừng */
  }
  voiceSrc = null;
}
