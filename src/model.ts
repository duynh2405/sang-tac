// Mô hình dữ liệu bài hát.
// Thời gian tính bằng "tick": 1 phách (nốt đen) = TPB tick, tức 1 tick = nốt móc kép (1/16).

export const TPB = 4;

export type Mode = 'major' | 'minor';
export type ChordQuality = 'maj' | 'min' | 'dim' | 'dom7';
export type LhPattern = 'block' | 'broken' | 'ballad' | 'waltz';

export interface Note {
  start: number; // tick
  dur: number; // tick (>= 1)
  midi: number; // cao độ MIDI (60 = C4)
  lyric?: string; // một âm tiết tiếng Việt
}

export interface Chord {
  start: number; // tick
  dur: number; // tick
  root: number; // pitch class 0-11
  quality: ChordQuality;
}

export interface Key {
  tonic: number; // pitch class 0-11
  mode: Mode;
}

export interface Song {
  id: string;
  title: string;
  tempo: number; // BPM
  beatsPerMeasure: number; // 2, 3, 4
  key: Key;
  keyAuto: boolean; // tự nhận giọng
  notes: Note[];
  chords: Chord[];
  chordsAuto: boolean; // tự gán hợp âm khi sửa nốt
  chordsPerMeasure: 1 | 2;
  lhPattern: LhPattern;
  lyricsText: string; // lời người dùng gõ/nhận được (để gán lại)
  created: number;
  updated: number;
}

export function measureTicks(song: Pick<Song, 'beatsPerMeasure'>): number {
  return song.beatsPerMeasure * TPB;
}

export function songEndTick(song: Song): number {
  let end = 0;
  for (const n of song.notes) end = Math.max(end, n.start + n.dur);
  const mt = measureTicks(song);
  return Math.max(mt, Math.ceil(end / mt) * mt);
}

export function newSong(partial: Partial<Song> = {}): Song {
  const now = Date.now();
  return {
    id: 's' + now.toString(36) + Math.random().toString(36).slice(2, 7),
    title: 'Bài hát mới',
    tempo: 80,
    beatsPerMeasure: 4,
    key: { tonic: 0, mode: 'major' },
    keyAuto: true,
    notes: [],
    chords: [],
    chordsAuto: true,
    chordsPerMeasure: 1,
    lhPattern: 'broken',
    lyricsText: '',
    created: now,
    updated: now,
    ...partial,
  };
}

/** Sắp xếp và loại bỏ chồng lấn: mỗi thời điểm chỉ một nốt giai điệu. */
export function normalizeNotes(notes: Note[]): Note[] {
  const sorted = notes
    .filter((n) => n.dur > 0)
    .map((n) => ({ ...n, start: Math.max(0, Math.round(n.start)), dur: Math.max(1, Math.round(n.dur)) }))
    .sort((a, b) => a.start - b.start || b.dur - a.dur);
  const out: Note[] = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.start === n.start) continue; // trùng điểm bắt đầu: giữ nốt đầu
    if (prev && prev.start + prev.dur > n.start) prev.dur = n.start - prev.start;
    out.push(n);
  }
  return out.filter((n) => n.dur > 0);
}
