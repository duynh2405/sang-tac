import * as Tone from 'tone';
import { TPB, type Chord, type Song } from '../model';
import { avoidMelodyClash, generateLeftHand } from '../music/accompaniment';
import { midiToHz } from '../music/theory';

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
  toTick?: number; // dừng tại đây (để phát từng câu)
  onEnd?: () => void;
}

let endTimer: number | null = null;
let endEventId: number | null = null;

export async function play(song: Song, chords: Chord[], o: PlayOptions): Promise<void> {
  await Tone.start();
  await loadPiano();
  stop();
  const tr = Tone.getTransport();
  const tickSec = 60 / song.tempo / TPB;
  const from = o.fromTick ?? 0;
  const to = o.toTick ?? Infinity;
  const inst = instrument();
  let endTick = from;
  if (o.melody) {
    for (const n of song.notes) {
      if (n.start < from || n.start >= to) continue;
      const d = Math.min(n.dur, to - n.start);
      tr.schedule((time) => inst.play(n.midi, d * tickSec * 0.95, time, 0.85), (n.start - from) * tickSec);
      endTick = Math.max(endTick, n.start + d);
    }
  }
  if (o.accompaniment) {
    const lh = generateLeftHand(chords, song.lhPattern, song.beatsPerMeasure);
    for (const n of o.melody ? avoidMelodyClash(lh, song.notes) : lh) {
      if (n.start < from || n.start >= to) continue;
      const d = Math.min(n.dur, to - n.start);
      tr.schedule((time) => inst.play(n.midi, d * tickSec * 0.95, time, 0.5), (n.start - from) * tickSec);
      endTick = Math.max(endTick, n.start + d);
    }
  }
  // kết thúc theo đồng hồ của transport, nên tạm dừng/tiếp tục vẫn đúng giờ
  endEventId = tr.scheduleOnce((time) => {
    Tone.getDraw().schedule(() => {
      stop();
      o.onEnd?.();
    }, time);
  }, (endTick - from) * tickSec + 0.6);
  tr.start('+0.05');
}

/** Tạm dừng: giữ nguyên vị trí, ngắt các nốt đang vang. */
export function pause(): void {
  const tr = Tone.getTransport();
  if (tr.state !== 'started') return;
  tr.pause();
  sampler?.releaseAll();
  fallback?.releaseAll();
}

/** Phát tiếp từ chỗ đã tạm dừng. */
export function resume(): void {
  const tr = Tone.getTransport();
  if (tr.state === 'paused') tr.start('+0.03');
}

export function stop(): void {
  if (endTimer !== null) {
    clearTimeout(endTimer);
    endTimer = null;
  }
  const tr = Tone.getTransport();
  if (endEventId !== null) {
    tr.clear(endEventId);
    endEventId = null;
  }
  tr.stop();
  tr.cancel(0);
  sampler?.releaseAll();
  fallback?.releaseAll();
}

/** Vị trí đang phát (giây kể từ lúc bấm phát), hoặc -1 nếu đang dừng. */
export function position(): number {
  const tr = Tone.getTransport();
  return tr.state === 'stopped' ? -1 : tr.seconds;
}

/** Nghe trước một nốt khi sửa. */
export async function previewNote(midi: number): Promise<void> {
  await Tone.start();
  void loadPiano();
  instrument().play(midi, 0.35, Tone.now(), 0.7);
}


/** Nghe thử một chữ: nốt giai điệu + hợp âm tay trái (nếu có). */
/** Nghe thử một chữ có luyến: các nốt hát nối tiếp nhau trên nền hợp âm. */
export async function previewSeq(seq: { midi: number; secs: number }[], chordMidis: number[]): Promise<void> {
  await Tone.start();
  void loadPiano();
  const inst = instrument();
  const t0 = Tone.now();
  const total = seq.reduce((s, x) => s + x.secs, 0);
  chordMidis.forEach((m) => inst.play(m, total, t0, 0.45));
  let t = t0;
  for (const x of seq) {
    inst.play(x.midi, x.secs, t, 0.85);
    t += x.secs;
  }
}

export async function previewWord(midi: number | null, chordMidis: number[], seconds: number): Promise<void> {
  await Tone.start();
  void loadPiano();
  const inst = instrument();
  const t = Tone.now();
  chordMidis.forEach((m) => inst.play(m, seconds, t, 0.45));
  if (midi !== null) inst.play(midi, seconds, t, 0.85);
}
