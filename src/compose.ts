// Mô hình "sổ sáng tác": lời bài hát được tách thành từng chữ, mỗi chữ có nốt, độ dài, hợp âm.
import { TPB, measureTicks, newSong, type Chord, type ChordQuality, type Key, type LhPattern, type Note, type Song } from './model';
import { chordPcs, detectKey, mod12 } from './music/theory';
import { harmonize } from './music/harmonize';
import { splitSyllables } from './lyrics/vietnamese';

export interface WordChord {
  root: number;
  quality: ChordQuality;
}

export interface Word {
  text: string;
  midi: number | null; // null = chưa chọn nốt (tính như dấu lặng)
  dur: number; // tick
  rest: number; // tick nghỉ sau chữ này
  chord: WordChord | null; // hợp âm bắt đầu từ chữ này
  br: boolean; // xuống dòng sau chữ này
  done: boolean; // người dùng đã bấm OK
}

export interface ComposeSong {
  id: string;
  title: string;
  tempo: number;
  beatsPerMeasure: number;
  lhPattern: LhPattern;
  keyAuto: boolean;
  key: Key;
  lyricsText: string;
  words: Word[];
  created: number;
  updated: number;
}

export function newCompose(partial: Partial<ComposeSong> = {}): ComposeSong {
  const now = Date.now();
  return {
    id: 'c' + now.toString(36) + Math.random().toString(36).slice(2, 7),
    title: 'Bài hát mới',
    tempo: 80,
    beatsPerMeasure: 4,
    lhPattern: 'broken',
    keyAuto: true,
    key: { tonic: 0, mode: 'major' },
    lyricsText: '',
    words: [],
    created: now,
    updated: now,
    ...partial,
  };
}

/** Tách lời thành chữ, giữ chỗ xuống dòng. */
export function tokenize(text: string): { text: string; br: boolean }[] {
  const out: { text: string; br: boolean }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const syl = splitSyllables(line);
    syl.forEach((s, i) => out.push({ text: s, br: i === syl.length - 1 }));
  }
  if (out.length) out[out.length - 1].br = false;
  return out;
}

const norm = (s: string) => s.normalize('NFC').toLowerCase();

/**
 * Sửa lời sau khi đã viết nốt: giữ lại nốt/hợp âm của những chữ không đổi
 * (so khớp chuỗi con chung dài nhất), chữ mới thêm thì chưa có nốt.
 */
export function relyric(old: Word[], text: string): Word[] {
  const toks = tokenize(text);
  const n = old.length;
  const m = toks.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = norm(old[i].text) === norm(toks[j].text) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const map = new Array<number>(m).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm(old[i].text) === norm(toks[j].text)) {
      map[j] = i;
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return toks.map((t, k) => {
    const o = map[k] >= 0 ? old[map[k]] : null;
    return o
      ? { ...o, text: t.text, br: t.br }
      : { text: t.text, midi: null, dur: TPB, rest: 0, chord: null, br: t.br, done: false };
  });
}

/** Thời điểm bắt đầu của từng chữ (tick). */
export function wordStarts(words: Word[]): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const w of words) {
    starts.push(t);
    t += w.dur + w.rest;
  }
  return starts;
}

export function totalTicks(words: Word[]): number {
  return words.reduce((s, w) => s + w.dur + w.rest, 0);
}

/** Chuyển sang dạng bài hát chuẩn để phát nhạc, vẽ sheet, xuất MIDI. */
export function toSong(cs: ComposeSong): { song: Song; chords: Chord[] } {
  const starts = wordStarts(cs.words);
  const notes: Note[] = [];
  cs.words.forEach((w, i) => {
    if (w.midi !== null) notes.push({ start: starts[i], dur: w.dur, midi: w.midi, lyric: w.text });
  });
  const mt = cs.beatsPerMeasure * TPB;
  const total = totalTicks(cs.words);
  const end = Math.max(mt, Math.ceil(total / mt) * mt);

  const chordIdx = cs.words.map((w, i) => (w.chord ? i : -1)).filter((i) => i >= 0);
  const chords: Chord[] = chordIdx.map((wi, k) => {
    const s = starts[wi];
    const e = k + 1 < chordIdx.length ? starts[chordIdx[k + 1]] : end;
    return { start: s, dur: Math.max(1, e - s), root: cs.words[wi].chord!.root, quality: cs.words[wi].chord!.quality };
  });

  let key = cs.key;
  if (cs.keyAuto) {
    if (notes.length >= 3) {
      // tính cả nốt trong hợp âm để nhận giọng chính xác hơn (đặt trước giai điệu)
      const fromChords: Note[] = chords.flatMap((c) => chordPcs(c).map((pc) => ({ start: 0, dur: c.dur * 0.6, midi: 60 + pc })));
      key = detectKey([...fromChords, ...notes]);
    }
    else if (chords.length) key = { tonic: chords[0].root, mode: chords[0].quality === 'min' ? 'minor' : 'major' };
    else key = { tonic: 0, mode: 'major' };
  }
  // nốt "ma" ở cuối để bài dài đủ tới hết ô nhịp có hợp âm/chữ cuối (không phát, không vẽ)
  const song = newSong({
    id: cs.id,
    title: cs.title,
    tempo: cs.tempo,
    beatsPerMeasure: cs.beatsPerMeasure,
    key,
    keyAuto: false,
    notes,
    chords,
    chordsAuto: false,
    lhPattern: cs.lhPattern,
  });
  return { song, chords };
}

export function measureCount(cs: ComposeSong): number {
  return Math.max(1, Math.ceil(totalTicks(cs.words) / measureTicks(cs)));
}

/** Tự gợi ý hợp âm: hòa âm theo ô nhịp rồi đặt hợp âm lên chữ đang vang ở đầu mỗi ô nhịp. */
export function suggestChords(cs: ComposeSong): Word[] {
  const { song } = toSong(cs);
  if (song.notes.length === 0) return cs.words;
  const chords = harmonize({ ...song, chordsPerMeasure: 1 });
  const starts = wordStarts(cs.words);
  const words = cs.words.map((w) => ({ ...w, chord: null as WordChord | null }));
  let last: WordChord | null = null;
  for (const c of chords) {
    // chữ đang vang tại đầu ô nhịp (hoặc chữ đầu tiên sau đó)
    let wi = starts.findIndex((s, i) => s <= c.start && c.start < s + cs.words[i].dur + cs.words[i].rest);
    if (wi < 0) wi = starts.findIndex((s) => s >= c.start);
    if (wi < 0) continue;
    const ch = { root: c.root, quality: c.quality };
    if (last && last.root === ch.root && last.quality === ch.quality) continue;
    if (!words[wi].chord) {
      words[wi].chord = ch;
      last = ch;
    }
  }
  return words;
}

/** Cao độ mặc định khi mở một chữ chưa có nốt: lấy theo chữ trước đó. */
export function defaultMidi(words: Word[], index: number, key: Key): number {
  for (let i = index - 1; i >= 0; i--) if (words[i].midi !== null) return words[i].midi!;
  for (let i = index + 1; i < words.length; i++) if (words[i].midi !== null) return words[i].midi!;
  // nốt chủ âm quanh Đô4–Si4
  return 60 + mod12(key.tonic);
}

export function defaultDur(words: Word[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (words[i].done) return words[i].dur;
  return TPB;
}

/** Bài ví dụ cho lần đầu mở app. */
export function demoCompose(): ComposeSong {
  const text = 'Em ơi hãy cất tiếng hát\ncho đời thêm vui mãi mãi';
  const mel = [64, 67, 69, 67, 64, 62, 60, 62, 64, 67, 64, 60];
  const dur = [4, 2, 2, 4, 4, 12, 4, 2, 2, 4, 4, 16];
  const words = tokenize(text).map((t, i) => ({
    text: t.text,
    midi: mel[i],
    dur: dur[i],
    rest: i === 5 ? 4 : 0,
    chord: null as WordChord | null,
    br: t.br,
    done: true,
  }));
  const C: WordChord = { root: 0, quality: 'maj' };
  words[0].chord = C;
  words[5].chord = { root: 7, quality: 'maj' };
  words[6].chord = { root: 5, quality: 'maj' };
  words[9].chord = { root: 7, quality: 'maj' };
  words[11].chord = C;
  return newCompose({ title: 'Bài ví dụ', lyricsText: text, words });
}
