import { TPB, normalizeNotes, type Note } from '../model';
import type { PitchFrame } from './pitch';

export interface RawNote {
  start: number; // giây
  end: number; // giây
  midi: number; // số thực (đã chỉnh lệch tông)
}

export interface SegmentOptions {
  minNoteSec?: number;
  onsetDb?: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Tách khung cao độ thành các nốt (theo giây). */
export function framesToRawNotes(frames: PitchFrame[], opts: SegmentOptions = {}): { notes: RawNote[]; tuning: number } {
  const minNoteSec = opts.minNoteSec ?? 0.07;
  const onsetDb = opts.onsetDb ?? 7;
  if (frames.length === 0) return { notes: [], tuning: 0 };
  const maxDb = Math.max(...frames.map((f) => f.db));
  const gate = Math.max(-55, maxDb - 32);
  const voiced = frames.map((f) => f.midi !== null && f.conf > 0.75 && f.db > gate);

  // sửa lỗi nhảy quãng 8 bằng trung vị lân cận
  const midi = frames.map((f) => f.midi ?? 0);
  const fixed = midi.slice();
  for (let i = 0; i < frames.length; i++) {
    if (!voiced[i]) continue;
    const neigh: number[] = [];
    for (let j = Math.max(0, i - 4); j <= Math.min(frames.length - 1, i + 4); j++) if (voiced[j]) neigh.push(midi[j]);
    const med = median(neigh);
    const diff = midi[i] - med;
    if (Math.abs(diff) > 9) fixed[i] = midi[i] - 12 * Math.round(diff / 12);
  }

  // độ lệch tông chung của người hát (hát hơi cao/thấp so với chuẩn 440 Hz)
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < frames.length; i++) {
    if (!voiced[i]) continue;
    const ang = 2 * Math.PI * (fixed[i] - Math.round(fixed[i]));
    sx += Math.cos(ang);
    sy += Math.sin(ang);
  }
  const tuning = sx || sy ? Math.atan2(sy, sx) / (2 * Math.PI) : 0;
  const tuned = fixed.map((m) => m - tuning);

  // làm mượt năng lượng để dò điểm bắt đầu âm tiết mới (nốt lặp cùng cao độ)
  const db = frames.map((f) => f.db);
  const sm = db.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(db.length - 1, i + 1); j++) {
      s += db[j];
      c++;
    }
    return s / c;
  });

  const out: RawNote[] = [];
  let seg: number[] = [];
  let unvoicedRun = 0;
  let changeRun = 0;
  const hop = frames.length > 1 ? frames[1].time - frames[0].time : 0.01;

  const flush = () => {
    if (seg.length * hop >= minNoteSec) {
      const ps = seg.map((i) => tuned[i]);
      out.push({
        start: frames[seg[0]].time - hop * 2,
        end: frames[seg[seg.length - 1]].time + hop * 2,
        midi: median(ps),
      });
    }
    seg = [];
    changeRun = 0;
  };

  for (let i = 0; i < frames.length; i++) {
    if (!voiced[i]) {
      unvoicedRun++;
      if (unvoicedRun >= 3 && seg.length) flush();
      continue;
    }
    unvoicedRun = 0;
    if (seg.length === 0) {
      seg.push(i);
      continue;
    }
    // đổi cao độ ổn định
    const segMed = median(seg.slice(-12).map((k) => tuned[k]));
    if (Math.abs(tuned[i] - segMed) >= 0.7) {
      changeRun++;
      if (changeRun >= 4) {
        const splitAt = seg.length - (changeRun - 1);
        const tail = seg.splice(splitAt);
        flush();
        seg = [...tail, i];
        continue;
      }
    } else {
      changeRun = 0;
    }
    // âm tiết mới cùng cao độ: năng lượng hụt rồi tăng lại
    if (seg.length > 8) {
      const look = 6;
      let minPrev = Infinity;
      for (let j = Math.max(seg[0], i - look); j < i; j++) minPrev = Math.min(minPrev, sm[j]);
      const recent = seg.slice(-20).map((k) => sm[k]);
      const peak = Math.max(...recent);
      if (sm[i] - minPrev >= onsetDb && peak - minPrev >= onsetDb) {
        // cắt tại khung có năng lượng thấp nhất
        let cut = i;
        for (let j = Math.max(seg[0], i - look); j < i; j++) if (sm[j] === minPrev) cut = j;
        const idx = seg.indexOf(cut);
        if (idx > 3) {
          const tail = seg.splice(idx);
          flush();
          seg = [...tail, i];
          continue;
        }
      }
    }
    seg.push(i);
  }
  if (seg.length) flush();
  return { notes: out, tuning };
}

export interface QuantizeOptions {
  tempo: number;
  beatsPerMeasure: number;
  t0: number; // giây: thời điểm phách 1 của ô nhịp đầu tiên
  grid: number; // tick (1 = móc kép, 2 = móc đơn)
  legato: boolean; // nối liền các khoảng lặng ngắn
}

/** Gắn nốt (giây) vào lưới nhịp. */
export function quantize(raw: RawNote[], o: QuantizeOptions): Note[] {
  const tickSec = 60 / o.tempo / TPB;
  const q = (sec: number) => Math.round((sec - o.t0) / tickSec / o.grid) * o.grid;
  let notes: Note[] = raw.map((r) => {
    const s = q(r.start);
    let e = q(r.end);
    if (e <= s) e = s + o.grid;
    return { start: s, dur: e - s, midi: Math.round(r.midi) };
  });
  // hát lố vào phần đếm nhịp: dời cả bài sang phải theo bội số ô nhịp (thành ô nhịp lấy đà)
  const minStart = Math.min(0, ...notes.map((n) => n.start));
  if (minStart < 0) {
    const mt = o.beatsPerMeasure * TPB;
    const shift = Math.ceil(-minStart / mt) * mt;
    notes = notes.map((n) => ({ ...n, start: n.start + shift }));
  }
  notes = normalizeNotes(notes);
  if (o.legato) {
    for (let i = 0; i < notes.length - 1; i++) {
      const gap = notes[i + 1].start - (notes[i].start + notes[i].dur);
      if (gap > 0 && gap <= Math.max(o.grid, TPB / 2)) notes[i].dur += gap;
    }
  }
  return notes;
}
