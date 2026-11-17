import { TPB, measureTicks, songEndTick, type Chord, type Key, type Note, type Song } from '../model';
import { chordPcs, diatonicChords, mod12, type DiatonicChord } from './theory';

/** Độ mạnh của vị trí phách (phách đầu ô nhịp mạnh nhất). */
function beatStrength(tick: number, mTicks: number): number {
  const pos = tick % mTicks;
  if (pos === 0) return 1.6;
  if (pos % TPB === 0) return 1.2;
  if (pos % (TPB / 2) === 0) return 0.85;
  return 0.6;
}

function transitionBonus(prev: DiatonicChord, cur: DiatonicChord, mode: Key['mode']): number {
  const p = prev.degree;
  const c = cur.degree;
  if (p === c) return -0.12;
  const rules: Record<string, Record<string, number>> =
    mode === 'major'
      ? {
          I: { IV: 0.25, V: 0.2, vi: 0.2, ii: 0.1 },
          ii: { V: 0.45, V7: 0.5, IV: 0.1 },
          iii: { vi: 0.25, IV: 0.2 },
          IV: { V: 0.35, V7: 0.4, I: 0.3, ii: 0.1 },
          V: { I: 0.6, vi: 0.2, IV: -0.05 },
          V7: { I: 0.7, vi: 0.2, IV: -0.3 },
          vi: { IV: 0.3, ii: 0.3, V: 0.1, iii: 0.1 },
        }
      : {
          i: { iv: 0.25, VI: 0.25, V: 0.2, VII: 0.15, III: 0.1 },
          iv: { V: 0.4, V7: 0.45, i: 0.25, VII: 0.15 },
          V: { i: 0.6, VI: 0.2 },
          V7: { i: 0.7, VI: 0.2 },
          III: { VI: 0.25, iv: 0.2, VII: 0.1 },
          VI: { VII: 0.3, iv: 0.3, III: 0.15, V: 0.15 },
          VII: { III: 0.35, i: 0.3 },
          v: { VI: 0.2, i: 0.15 },
        };
  return rules[p]?.[c] ?? 0;
}

interface Span {
  start: number;
  dur: number;
  notes: { pc: number; w: number }[];
}

function buildSpans(notes: Note[], spanTicks: number, endTick: number, mTicks: number): Span[] {
  const spans: Span[] = [];
  for (let s = 0; s < endTick; s += spanTicks) {
    const e = s + spanTicks;
    const sn: Span['notes'] = [];
    for (const n of notes) {
      const a = Math.max(s, n.start);
      const b = Math.min(e, n.start + n.dur);
      if (b <= a) continue;
      // nốt bắt đầu trong span thì lấy độ mạnh vị trí của nó; nốt ngân từ trước thì yếu hơn
      const strength = n.start >= s ? beatStrength(n.start, mTicks) : 0.7;
      sn.push({ pc: mod12(n.midi), w: (b - a) * strength });
    }
    spans.push({ start: s, dur: spanTicks, notes: sn });
  }
  return spans;
}

function emission(span: Span, ch: DiatonicChord, key: Key): number {
  if (span.notes.length === 0) return 0;
  const pcs = chordPcs(ch);
  let inW = 0;
  let outW = 0;
  for (const { pc, w } of span.notes) {
    if (pcs.includes(pc)) inW += w;
    else outW += w;
  }
  const total = inW + outW;
  let score = (inW - 0.65 * outW) / total;
  // V7 chỉ đáng dùng khi giai điệu có bậc 7 của hợp âm (bậc 4 của giọng)
  if (ch.quality === 'dom7') {
    const seventh = mod12(ch.root + 10);
    const has7 = span.notes.some((n) => n.pc === seventh);
    score += has7 ? 0.02 : -0.12;
  }
  // bài hát đơn giản thường dùng các hợp âm chính I – IV – V
  if (['I', 'IV', 'V', 'i', 'iv'].includes(ch.degree)) score += 0.08;
  // nốt gốc hợp âm có trong giai điệu thì cộng nhẹ
  if (span.notes.some((n) => n.pc === ch.root)) score += 0.05;
  void key;
  return score;
}

/** Hòa âm tự động bằng luật nhạc lý + Viterbi trên các đoạn (1 hoặc 2 hợp âm mỗi ô nhịp). */
export function harmonize(song: Song): Chord[] {
  const notes = song.notes;
  if (notes.length === 0) return [];
  const mTicks = measureTicks(song);
  const spanTicks = song.chordsPerMeasure === 2 && song.beatsPerMeasure % 2 === 0 ? mTicks / 2 : mTicks;
  const endTick = songEndTick(song);
  const spans = buildSpans(notes, spanTicks, endTick, mTicks);
  const cands = diatonicChords(song.key);
  const tonicDeg = song.key.mode === 'major' ? 'I' : 'i';

  const n = spans.length;
  const score: number[][] = [];
  const back: number[][] = [];
  for (let i = 0; i < n; i++) {
    score.push(new Array(cands.length).fill(-Infinity));
    back.push(new Array(cands.length).fill(-1));
    for (let j = 0; j < cands.length; j++) {
      let em = emission(spans[i], cands[j], song.key);
      if (i === 0 && cands[j].degree === tonicDeg) em += 0.35;
      if (i === n - 1 && cands[j].degree === tonicDeg) em += 0.5;
      if (i === 0) {
        score[i][j] = em;
        continue;
      }
      for (let k = 0; k < cands.length; k++) {
        let t = transitionBonus(cands[k], cands[j], song.key.mode);
        // đoạn trống (không có nốt): ưu tiên giữ hợp âm trước
        if (spans[i].notes.length === 0) t = k === j ? 0.4 : -0.2;
        const v = score[i - 1][k] + t + em;
        if (v > score[i][j]) {
          score[i][j] = v;
          back[i][j] = k;
        }
      }
    }
  }
  let bestJ = 0;
  for (let j = 1; j < cands.length; j++) if (score[n - 1][j] > score[n - 1][bestJ]) bestJ = j;
  const path = new Array<number>(n);
  path[n - 1] = bestJ;
  for (let i = n - 1; i > 0; i--) path[i - 1] = back[i][path[i]];

  // gộp các đoạn liền nhau có cùng hợp âm
  const out: Chord[] = [];
  for (let i = 0; i < n; i++) {
    const c = cands[path[i]];
    const prev = out[out.length - 1];
    // không gộp qua vạch nhịp để mỗi ô nhịp hiển thị rõ hợp âm của nó
    const atBar = spans[i].start % mTicks === 0;
    if (prev && !atBar && prev.root === c.root && prev.quality === c.quality) {
      prev.dur += spans[i].dur;
    } else {
      out.push({ start: spans[i].start, dur: spans[i].dur, root: c.root, quality: c.quality });
    }
  }
  return out;
}

/** Hợp âm đang vang tại một tick. */
export function chordAt(chords: Chord[], tick: number): Chord | undefined {
  return chords.find((c) => tick >= c.start && tick < c.start + c.dur);
}

/** Đảm bảo hợp âm phủ hết chiều dài bài (khi người dùng thêm nốt ở cuối). */
export function fitChordsToSong(song: Song): Chord[] {
  const end = songEndTick(song);
  const mTicks = measureTicks(song);
  const chords = song.chords.filter((c) => c.start < end).map((c) => ({ ...c }));
  let last = chords[chords.length - 1];
  if (last && last.start + last.dur > end) last.dur = end - last.start;
  let cursor = last ? last.start + last.dur : 0;
  while (cursor < end) {
    const base = last ?? { root: song.key.tonic, quality: song.key.mode === 'major' ? 'maj' : 'min' };
    const c: Chord = { start: cursor, dur: mTicks - (cursor % mTicks), root: base.root, quality: base.quality as Chord['quality'] };
    chords.push(c);
    last = c;
    cursor += c.dur;
  }
  return chords;
}
