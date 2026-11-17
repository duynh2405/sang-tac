import { TPB, type Chord, type Song } from '../model';
import { generateLeftHand } from './accompaniment';

const PPQ = 480;
const TICK = PPQ / TPB; // tick của app -> tick MIDI

function vlq(n: number): number[] {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

function str(s: string): number[] {
  return [...new TextEncoder().encode(s)];
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

interface MidiEvent {
  t: number; // tick MIDI tuyệt đối
  order: number; // note-off trước note-on khi trùng thời điểm
  data: number[];
}

function track(events: MidiEvent[]): number[] {
  events.sort((a, b) => a.t - b.t || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of events) {
    body.push(...vlq(e.t - last), ...e.data);
    last = e.t;
  }
  body.push(0, 0xff, 0x2f, 0); // end of track
  return [...str('MTrk'), ...u32(body.length), ...body];
}

function metaText(type: number, text: string): number[] {
  const b = str(text);
  return [0xff, type, ...vlq(b.length), ...b];
}

/** Xuất file MIDI chuẩn (type 1): track giai điệu (tay phải) + track đệm (tay trái), đều là piano. */
export function songToMidi(song: Song, chords: Chord[]): Uint8Array {
  const usPerQuarter = Math.round(60_000_000 / song.tempo);
  const conductor: MidiEvent[] = [
    { t: 0, order: 0, data: metaText(0x03, song.title) },
    { t: 0, order: 0, data: [0xff, 0x51, 3, (usPerQuarter >> 16) & 255, (usPerQuarter >> 8) & 255, usPerQuarter & 255] },
    { t: 0, order: 0, data: [0xff, 0x58, 4, song.beatsPerMeasure, 2, 24, 8] },
  ];

  const right: MidiEvent[] = [
    { t: 0, order: 0, data: metaText(0x03, 'Tay phải (giai điệu)') },
    { t: 0, order: 0, data: [0xc0, 0] },
  ];
  for (const n of song.notes) {
    right.push({ t: n.start * TICK, order: 2, data: [0x90, n.midi, 92] });
    right.push({ t: (n.start + n.dur) * TICK - 1, order: 1, data: [0x80, n.midi, 0] });
    if (n.lyric) right.push({ t: n.start * TICK, order: 1, data: metaText(0x05, n.lyric) });
  }

  const left: MidiEvent[] = [
    { t: 0, order: 0, data: metaText(0x03, 'Tay trái (hợp âm)') },
    { t: 0, order: 0, data: [0xc1, 0] },
  ];
  for (const n of generateLeftHand(chords, song.lhPattern, song.beatsPerMeasure)) {
    left.push({ t: n.start * TICK, order: 2, data: [0x91, n.midi, 70] });
    left.push({ t: (n.start + n.dur) * TICK - 1, order: 1, data: [0x81, n.midi, 0] });
  }

  const header = [...str('MThd'), ...u32(6), 0, 1, 0, 3, (PPQ >> 8) & 255, PPQ & 255];
  return new Uint8Array([...header, ...track(conductor), ...track(right), ...track(left)]);
}
