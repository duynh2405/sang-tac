import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { analyzePitch, ANALYSIS_SR, midiToHz } from '../src/audio/pitch';
import { framesToRawNotes, quantize } from '../src/audio/segment';
import { newSong, TPB, type Note } from '../src/model';
import { detectKey, chordName } from '../src/music/theory';
import { harmonize } from '../src/music/harmonize';
import { songToMusicXml } from '../src/music/musicxml';
import { songToMidi } from '../src/music/midi';
import { assignLyrics, checkTones, splitSyllables, toneOf } from '../src/lyrics/vietnamese';
import { generateLeftHand } from '../src/music/accompaniment';

/** Tổng hợp "giọng hát" có bồi âm, rung nhẹ, ngắt giữa các nốt. */
function synth(notes: { midi: number; sec: number; gap?: number }[], sr = ANALYSIS_SR, lead = 0.5): Float32Array {
  const total = lead + notes.reduce((s, n) => s + n.sec + (n.gap ?? 0.04), 0) + 0.5;
  const out = new Float32Array(Math.ceil(total * sr));
  let t = lead;
  let phase = 0;
  for (const n of notes) {
    const f0 = midiToHz(n.midi);
    const len = Math.floor(n.sec * sr);
    const start = Math.floor(t * sr);
    for (let i = 0; i < len; i++) {
      const tt = i / sr;
      const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * tt);
      phase += (2 * Math.PI * f0 * vib) / sr;
      const env = Math.min(1, i / (0.02 * sr)) * Math.min(1, (len - i) / (0.03 * sr));
      const s = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase) + 0.12 * Math.sin(4 * phase);
      out[start + i] = 0.25 * env * s;
    }
    t += n.sec + (n.gap ?? 0.04);
  }
  // nhiễu nền nhẹ
  for (let i = 0; i < out.length; i++) out[i] += (Math.random() - 0.5) * 0.002;
  return out;
}

describe('dò cao độ', () => {
  it('nhận đúng nốt A3 (220 Hz)', () => {
    const sig = synth([{ midi: 57, sec: 1 }]);
    const frames = analyzePitch(sig).filter((f) => f.midi !== null);
    const mids = frames.map((f) => f.midi!).sort((a, b) => a - b);
    expect(Math.abs(mids[mids.length >> 1] - 57)).toBeLessThan(0.15);
  });

  it('tách và gắn nhịp một câu giai điệu, kể cả nốt lặp cùng cao độ', () => {
    const tempo = 90;
    const beat = 60 / tempo;
    // Đô Đô Sol Sol La La Sol(2 phách) — giống "Twinkle"
    const seq = [60, 60, 67, 67, 69, 69].map((m) => ({ midi: m, sec: beat - 0.06, gap: 0.06 }));
    seq.push({ midi: 67, sec: 2 * beat - 0.06, gap: 0.06 });
    const lead = 0.5;
    const sig = synth(seq, ANALYSIS_SR, lead);
    const { notes: raw } = framesToRawNotes(analyzePitch(sig));
    const q = quantize(raw, { tempo, beatsPerMeasure: 4, t0: lead, grid: 2, legato: true });
    expect(q.map((n) => n.midi)).toEqual([60, 60, 67, 67, 69, 69, 67]);
    expect(q.map((n) => n.start)).toEqual([0, 4, 8, 12, 16, 20, 24]);
    expect(q[6].dur).toBe(8);
  });

  it('hát lệch tông chung (cao 30 cent) vẫn ra đúng nốt', () => {
    const tempo = 80;
    const beat = 60 / tempo;
    const seq = [64.3, 62.3, 60.3, 62.3].map((m) => ({ midi: m, sec: beat - 0.05, gap: 0.05 }));
    const sig = synth(seq);
    const { notes: raw, tuning } = framesToRawNotes(analyzePitch(sig));
    expect(Math.abs(tuning - 0.3)).toBeLessThan(0.1);
    const q = quantize(raw, { tempo, beatsPerMeasure: 4, t0: 0.5, grid: 2, legato: true });
    expect(q.map((n) => n.midi)).toEqual([64, 62, 60, 62]);
  });
});

const twinkle: Note[] = [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60].map((m, i) => ({
  start: i * TPB + (i >= 7 ? TPB : 0),
  dur: i === 6 || i === 13 ? 2 * TPB : TPB,
  midi: m,
}));

describe('nhạc lý', () => {
  it('nhận giọng Đô trưởng', () => {
    expect(detectKey(twinkle)).toEqual({ tonic: 0, mode: 'major' });
  });

  it('nhận giọng La thứ', () => {
    const am: Note[] = [69, 72, 71, 69, 64, 69, 71, 72, 71, 69].map((m, i) => ({ start: i * 4, dur: 4, midi: m }));
    am[am.length - 1].dur = 8;
    expect(detectKey(am)).toEqual({ tonic: 9, mode: 'minor' });
  });

  it('hòa âm Twinkle hợp lý: bắt đầu và kết bằng C, có F và G', () => {
    const song = newSong({ notes: twinkle, key: { tonic: 0, mode: 'major' }, chordsPerMeasure: 1 });
    expect(harmonize(song).map((c) => chordName(c))).toEqual(['C', 'F', 'G7', 'C']);
    const half = harmonize({ ...song, chordsPerMeasure: 2 }).map((c) => chordName(c));
    expect(half[0]).toBe('C');
    expect(half[half.length - 1]).toBe('C');
    expect(half.some((c) => c === 'G' || c === 'G7')).toBe(true);
  });

  it('tay trái nằm dưới giai điệu', () => {
    const song = newSong({ notes: twinkle, key: { tonic: 0, mode: 'major' } });
    for (const pat of ['block', 'broken', 'ballad', 'waltz'] as const) {
      const lh = generateLeftHand(harmonize(song), pat, 4);
      expect(lh.length).toBeGreaterThan(0);
      expect(Math.max(...lh.map((n) => n.midi))).toBeLessThan(67);
    }
  });
});

describe('xuất file', () => {
  it('MusicXML hợp lệ, mỗi ô nhịp đủ trường độ ở cả hai khuông, có lời tiếng Việt', () => {
    const lyrics = 'Một hai ba bốn năm sáu bảy tám chín mười một hai ba bốn';
    const { notes } = assignLyrics(twinkle, lyrics);
    const song = newSong({ title: 'Thử & nghiệm', notes, key: { tonic: 0, mode: 'major' }, lhPattern: 'ballad' });
    const xml = songToMusicXml(song, harmonize(song));
    const errors: string[] = [];
    const doc = new DOMParser({ onError: (_l: string, m: string) => errors.push(m) } as any).parseFromString(xml, 'text/xml');
    expect(errors).toEqual([]);
    const measures = Array.from(doc.getElementsByTagName('measure'));
    expect(measures.length).toBe(4);
    for (const m of measures) {
      const sums = { 1: 0, 2: 0 } as Record<number, number>;
      for (const n of Array.from(m.getElementsByTagName('note'))) {
        if (n.getElementsByTagName('chord').length) continue;
        const staff = Number(n.getElementsByTagName('staff')[0].textContent);
        sums[staff] += Number(n.getElementsByTagName('duration')[0].textContent);
      }
      expect(sums[1]).toBe(16);
      expect(sums[2]).toBe(16);
    }
    const texts = Array.from(doc.getElementsByTagName('text')).map((t) => t.textContent);
    expect(texts[0]).toBe('Một');
    expect(xml).toContain('Thử &amp; nghiệm');
    expect(doc.getElementsByTagName('harmony').length).toBeGreaterThan(0);
  });

  it('nốt kéo qua vạch nhịp được nối bằng dấu nối', () => {
    const song = newSong({ notes: [{ start: 12, dur: 8, midi: 64, lyric: 'dài' }], key: { tonic: 0, mode: 'major' } });
    const xml = songToMusicXml(song, harmonize(song));
    expect(xml).toContain('<tie type="start"/>');
    expect(xml).toContain('<tie type="stop"/>');
    expect(xml.match(/<text>dài<\/text>/g)?.length).toBe(1);
  });

  it('MIDI có header đúng và 3 track', () => {
    const song = newSong({ notes: twinkle, key: { tonic: 0, mode: 'major' } });
    const mid = songToMidi(song, harmonize(song));
    expect(String.fromCharCode(...mid.slice(0, 4))).toBe('MThd');
    expect(mid[11]).toBe(3);
    const tracks = String.fromCharCode(...mid).split('MTrk').length - 1;
    expect(tracks).toBe(3);
  });
});

describe('lời tiếng Việt', () => {
  it('nhận đúng dấu thanh', () => {
    expect(['ma', 'mà', 'má', 'mả', 'mã', 'mạ', 'người', 'ước', 'Việt'].map(toneOf)).toEqual([
      'ngang', 'huyen', 'sac', 'hoi', 'nga', 'nang', 'huyen', 'sac', 'nang',
    ]);
  });

  it('tách âm tiết, bỏ dấu câu', () => {
    expect(splitSyllables('Em ơi, Hà Nội phố!\nTa còn em')).toEqual(['Em', 'ơi', 'Hà', 'Nội', 'phố', 'Ta', 'còn', 'em']);
  });

  it('cảnh báo khi giai điệu đi ngược hướng dấu', () => {
    const notes: Note[] = [
      { start: 0, dur: 4, midi: 67, lyric: 'người' }, // huyền
      { start: 4, dur: 4, midi: 60, lyric: 'đến' }, // sắc nhưng đi xuống 7 nửa cung
      { start: 8, dur: 4, midi: 64, lyric: 'là' },
      { start: 12, dur: 4, midi: 62, lyric: 'là' },
    ];
    const w = checkTones(notes);
    expect(w.length).toBeGreaterThan(0);
    expect(w[0].noteIndex).toBe(1);
    expect(w[0].severity).toBe('nặng');
  });

  it('không cảnh báo khi giai điệu thuận dấu', () => {
    const notes: Note[] = [
      { start: 0, dur: 4, midi: 60, lyric: 'người' },
      { start: 4, dur: 4, midi: 67, lyric: 'đến' },
      { start: 8, dur: 4, midi: 64, lyric: 'đây' },
    ];
    expect(checkTones(notes)).toEqual([]);
  });
});
