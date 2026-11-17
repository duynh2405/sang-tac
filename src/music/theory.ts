import type { Chord, ChordQuality, Key, Note } from '../model';

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const SOLFEGE = ['Đô', 'Đô#', 'Rê', 'Rê#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

export const mod12 = (x: number) => ((x % 12) + 12) % 12;

/** Số dấu hóa của giọng (dương = thăng, âm = giáng), theo vòng quãng 5. */
export function keyFifths(key: Key): number {
  // giọng thứ: dùng giọng trưởng song song (tương đối) = tonic + 3
  const majorTonic = key.mode === 'major' ? key.tonic : mod12(key.tonic + 3);
  const table: Record<number, number> = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5 };
  return table[majorTonic];
}

export function usesFlats(key: Key): boolean {
  return keyFifths(key) < 0;
}

export function pcName(pc: number, key?: Key): string {
  return (key && usesFlats(key) ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)];
}

export function midiName(midi: number, key?: Key): string {
  return pcName(midi, key) + (Math.floor(midi / 12) - 1);
}

export function keyName(key: Key): string {
  return pcName(key.tonic, key) + (key.mode === 'minor' ? ' thứ' : ' trưởng');
}

export function chordIntervals(q: ChordQuality): number[] {
  switch (q) {
    case 'maj':
      return [0, 4, 7];
    case 'min':
      return [0, 3, 7];
    case 'dim':
      return [0, 3, 6];
    case 'dom7':
      return [0, 4, 7, 10];
  }
}

export function chordPcs(c: Pick<Chord, 'root' | 'quality'>): number[] {
  return chordIntervals(c.quality).map((i) => mod12(c.root + i));
}

export function chordName(c: Pick<Chord, 'root' | 'quality'>, key?: Key): string {
  const r = pcName(c.root, key);
  switch (c.quality) {
    case 'maj':
      return r;
    case 'min':
      return r + 'm';
    case 'dim':
      return r + 'dim';
    case 'dom7':
      return r + '7';
  }
}

export function parseChordName(text: string): Pick<Chord, 'root' | 'quality'> | null {
  const m = /^\s*([A-Ga-g])([#b]?)(m|dim|7)?\s*$/.exec(text);
  if (!m) return null;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let root = base[m[1].toUpperCase()];
  if (m[2] === '#') root += 1;
  if (m[2] === 'b') root -= 1;
  const q: ChordQuality = m[3] === 'm' ? 'min' : m[3] === 'dim' ? 'dim' : m[3] === '7' ? 'dom7' : 'maj';
  return { root: mod12(root), quality: q };
}

// Hồ sơ giọng Krumhansl–Kessler
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Nhận giọng từ giai điệu (trọng số theo trường độ, ưu tiên nốt đầu và nốt cuối). */
export function detectKey(notes: Note[]): Key {
  if (notes.length === 0) return { tonic: 0, mode: 'major' };
  const hist = new Array(12).fill(0);
  notes.forEach((n, i) => {
    let w = n.dur;
    if (i === notes.length - 1) w *= 2; // nốt kết thường là chủ âm
    hist[mod12(n.midi)] += w;
  });
  let best: Key = { tonic: 0, mode: 'major' };
  let bestScore = -Infinity;
  for (let t = 0; t < 12; t++) {
    for (const mode of ['major', 'minor'] as const) {
      const prof = mode === 'major' ? KK_MAJOR : KK_MINOR;
      const rotated = prof.map((_, i) => prof[mod12(i - t)]);
      let s = correlation(hist, rotated);
      // nốt cuối là chủ âm thì cộng điểm nhẹ
      if (mod12(notes[notes.length - 1].midi) === t) s += 0.08;
      if (s > bestScore) {
        bestScore = s;
        best = { tonic: t, mode };
      }
    }
  }
  return best;
}

export interface DiatonicChord {
  degree: string; // I, ii, V7...
  root: number;
  quality: ChordQuality;
}

/** Các hợp âm thông dụng trong giọng (dùng cho gợi ý và hòa âm tự động). */
export function diatonicChords(key: Key): DiatonicChord[] {
  const t = key.tonic;
  if (key.mode === 'major') {
    return [
      { degree: 'I', root: t, quality: 'maj' },
      { degree: 'ii', root: mod12(t + 2), quality: 'min' },
      { degree: 'iii', root: mod12(t + 4), quality: 'min' },
      { degree: 'IV', root: mod12(t + 5), quality: 'maj' },
      { degree: 'V', root: mod12(t + 7), quality: 'maj' },
      { degree: 'V7', root: mod12(t + 7), quality: 'dom7' },
      { degree: 'vi', root: mod12(t + 9), quality: 'min' },
    ];
  }
  return [
    { degree: 'i', root: t, quality: 'min' },
    { degree: 'iv', root: mod12(t + 5), quality: 'min' },
    { degree: 'V', root: mod12(t + 7), quality: 'maj' },
    { degree: 'V7', root: mod12(t + 7), quality: 'dom7' },
    { degree: 'III', root: mod12(t + 3), quality: 'maj' },
    { degree: 'VI', root: mod12(t + 8), quality: 'maj' },
    { degree: 'VII', root: mod12(t + 10), quality: 'maj' },
    { degree: 'v', root: mod12(t + 7), quality: 'min' },
  ];
}
