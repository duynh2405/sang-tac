import { TPB, type Chord, type LhPattern } from '../model';
import { chordIntervals, mod12 } from './theory';

export interface LhNote {
  start: number;
  dur: number;
  midi: number;
}

/** Nốt bass: gốc hợp âm trong khoảng G2–F#3. */
function bassOf(root: number): number {
  let m = 43 + mod12(root - 7); // 43 = G2
  if (m > 54) m -= 12;
  return m;
}

/** Hợp âm tay trái (không có gốc ở bè dưới), xếp gọn trong khoảng G3–F#4. */
function upperVoicing(chord: Chord): number[] {
  const pcs = chordIntervals(chord.quality).map((i) => mod12(chord.root + i));
  return pcs.map((pc) => 55 + mod12(pc - 7)).sort((a, b) => a - b); // 55 = G3
}

export function generateLeftHand(chords: Chord[], pattern: LhPattern, beatsPerMeasure: number): LhNote[] {
  const out: LhNote[] = [];
  const beat = TPB;
  for (const c of chords) {
    const bass = bassOf(c.root);
    const upper = upperVoicing(c);
    const end = c.start + c.dur;
    if (pattern === 'block') {
      out.push({ start: c.start, dur: c.dur, midi: bass });
      upper.forEach((m) => out.push({ start: c.start, dur: c.dur, midi: m }));
      continue;
    }
    if (pattern === 'broken' || pattern === 'waltz') {
      for (let t = c.start; t < end; t += beat) {
        const d = Math.min(beat, end - t);
        const onStrong = (t - c.start) % (beatsPerMeasure * beat) === 0 || t === c.start;
        if (onStrong) out.push({ start: t, dur: d, midi: bass });
        else upper.forEach((m) => out.push({ start: t, dur: d, midi: m }));
      }
      continue;
    }
    // ballad: rải móc đơn: bass – quãng 5 – quãng 8 – quãng 3 (quãng 10)
    const third = c.quality === 'min' || c.quality === 'dim' ? 3 : 4;
    const fifth = c.quality === 'dim' ? 6 : 7;
    const low = bass > 48 ? bass - 12 : bass; // hạ quãng 8 để tiếng rải không đè lên giai điệu
    const seq = [low, low + fifth, low + 12, low + 12 + third];
    const step = TPB / 2;
    let i = 0;
    for (let t = c.start; t < end; t += step) {
      out.push({ start: t, dur: Math.min(step, end - t), midi: seq[i % seq.length] });
      i++;
    }
  }
  return out;
}

/**
 * Tay trái không được đánh trùng đúng cao độ nốt giai điệu đang vang
 * (trên cùng một cây đàn sẽ nghe như chữ bị hát lại 2 lần).
 * Nốt trùng được hạ một quãng tám, nếu vẫn trùng thì bỏ.
 */
export function avoidMelodyClash<T extends LhNote>(lh: T[], melody: { start: number; dur: number; midi: number }[]): T[] {
  const clash = (midi: number, s: number, e: number) =>
    melody.some((m) => m.midi === midi && m.start < e && s < m.start + m.dur);
  const out: T[] = [];
  for (const n of lh) {
    const e = n.start + n.dur;
    if (!clash(n.midi, n.start, e)) out.push(n);
    else if (n.midi - 12 >= 36 && !clash(n.midi - 12, n.start, e) && !out.some((o) => o.start === n.start && o.midi === n.midi - 12))
      out.push({ ...n, midi: n.midi - 12 });
  }
  return out;
}
