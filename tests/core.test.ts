import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { newSong, TPB, type Note } from '../src/model';
import { detectKey, chordName } from '../src/music/theory';
import { harmonize } from '../src/music/harmonize';
import { songToMusicXml } from '../src/music/musicxml';
import { songToMidi } from '../src/music/midi';
import { assignLyrics, checkTones, splitSyllables, toneOf } from '../src/lyrics/vietnamese';
import { generateLeftHand } from '../src/music/accompaniment';

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

import { relyric, suggestChords, toSong, tokenize, newCompose, demoCompose, wordStarts } from '../src/compose';

describe('sổ sáng tác', () => {
  it('tách lời thành chữ, giữ xuống dòng', () => {
    const t = tokenize('Em ơi\nHà Nội phố');
    expect(t.map((x) => x.text)).toEqual(['Em', 'ơi', 'Hà', 'Nội', 'phố']);
    expect(t.map((x) => x.br)).toEqual([false, true, false, false, false]);
  });

  it('sửa lời vẫn giữ nốt của chữ không đổi', () => {
    const cs = demoCompose();
    const words = relyric(cs.words, 'Em ơi hãy hát\ncho đời thêm vui mãi mãi');
    expect(words[0].midi).toBe(cs.words[0].midi);
    expect(words[3].text).toBe('hát');
    expect(words[3].midi).toBe(cs.words[5].midi); // "hát" cũ
    expect(words.length).toBe(10);
  });

  it('chữ mới thêm vào chưa có nốt', () => {
    const cs = demoCompose();
    const words = relyric(cs.words, 'Em ơi ơi hãy cất tiếng hát cho đời thêm vui mãi mãi');
    expect(words.filter((w) => !w.done).length).toBe(1);
  });

  it('chuyển sang bài hát: thời điểm, hợp âm, giọng', () => {
    const cs = demoCompose();
    const { song, chords } = toSong(cs);
    expect(song.notes.length).toBe(12);
    expect(wordStarts(cs.words).slice(0, 4)).toEqual([0, 4, 6, 8]);
    expect(song.notes[6].start).toBe(32); // sau "hát" 12 + nghỉ 4
    expect(chords.map((c) => c.start)).toEqual([0, 16, 32, 40, 48]);
    expect(song.key).toEqual({ tonic: 0, mode: 'major' });
    const xml = songToMusicXml(song, chords);
    const errors: string[] = [];
    new DOMParser({ onError: (_l: string, m: string) => errors.push(m) } as any).parseFromString(xml, 'text/xml');
    expect(errors).toEqual([]);
    expect(xml).toContain('<text>cất</text>');
  });

  it('gợi ý hợp âm đặt hợp âm lên chữ', () => {
    const cs = demoCompose();
    cs.words.forEach((w) => (w.chord = null));
    const words = suggestChords(cs);
    expect(words[0].chord).toEqual({ root: 0, quality: 'maj' });
    expect(words.filter((w) => w.chord).length).toBeGreaterThanOrEqual(2);
  });

  it('bài trống vẫn chuyển được', () => {
    const { song, chords } = toSong(newCompose());
    expect(song.notes).toEqual([]);
    expect(chords).toEqual([]);
  });
});

import { toSong as toSong2, newCompose as nc2, wordStarts as ws2 } from '../src/compose';
import { songToMusicXml as xml2 } from '../src/music/musicxml';
import { checkTones as ct2 } from '../src/lyrics/vietnamese';
import { encodeSong, decodeSong } from '../src/share';
describe('luyến (nhiều nốt một chữ)', () => {
  const cs = nc2({ beatsPerMeasure: 4, keyAuto: false });
  cs.words = [
    { text: 'em', midi: 64, dur: 2, rest: 0, chord: null, br: false, done: true, slur: [{ midi: 67, dur: 2 }, { midi: 65, dur: 4 }] },
    { text: 'ơi', midi: 62, dur: 4, rest: 0, chord: null, br: false, done: true },
  ];
  it('tính thời gian và tạo nốt luyến', () => {
    expect(ws2(cs.words)).toEqual([0, 8]);
    const { song } = toSong2(cs);
    const real = song.notes.filter((n) => n.word !== undefined);
    expect(real.map((n) => [n.start, n.midi, n.lyric ?? '', n.slur ?? ''])).toEqual([
      [0, 64, 'em', 'start'],
      [2, 67, '', 'continue'],
      [4, 65, '', 'stop'],
      [8, 62, 'ơi', ''],
    ]);
    const x = xml2(song, []);
    expect(x).toContain('<slur type="start" number="1"/>');
    expect(x).toContain('<slur type="stop" number="1"/>');
    expect((x.match(/<lyric /g) ?? []).length).toBe(2);
    // dấu thanh so với nốt luyến cuối (Fa4 -> Rê4)
    expect(Array.isArray(ct2(song.notes))).toBe(true);
  });
  it('giữ luyến khi gửi link', async () => {
    const b = await decodeSong(await encodeSong(cs));
    expect(b.words[0].slur).toEqual(cs.words[0].slur);
    expect(b.words[1].slur).toBeUndefined();
  });
});
