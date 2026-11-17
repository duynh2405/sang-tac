import { TPB, measureTicks, songEndTick, type Chord, type Key, type Song } from '../model';
import { generateLeftHand } from './accompaniment';
import { keyFifths, mod12, usesFlats } from './theory';

interface Ev {
  start: number;
  dur: number;
  midis: number[]; // rỗng = dấu lặng
  lyric?: string;
  slur?: 'start' | 'continue' | 'stop';
}

const DUR_TYPES: [number, string, boolean][] = [
  [16, 'whole', false],
  [12, 'half', true],
  [8, 'half', false],
  [6, 'quarter', true],
  [4, 'quarter', false],
  [3, 'eighth', true],
  [2, 'eighth', false],
  [1, '16th', false],
];

function splitDuration(d: number): number[] {
  const parts: number[] = [];
  let rest = d;
  while (rest > 0) {
    const p = DUR_TYPES.find(([len]) => len <= rest)![0];
    parts.push(p);
    rest -= p;
  }
  return parts;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SHARP_STEPS: [string, number][] = [
  ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
];
const FLAT_STEPS: [string, number][] = [
  ['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0],
];

function pitchXml(midi: number, key: Key): string {
  const [step, alter] = (usesFlats(key) ? FLAT_STEPS : SHARP_STEPS)[mod12(midi)];
  const octave = Math.floor(midi / 12) - 1;
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>`;
}

function rootXml(pc: number, key: Key): string {
  const [step, alter] = (usesFlats(key) ? FLAT_STEPS : SHARP_STEPS)[mod12(pc)];
  return `<root><root-step>${step}</root-step>${alter ? `<root-alter>${alter}</root-alter>` : ''}</root>`;
}

const KIND: Record<Chord['quality'], string> = {
  maj: 'major',
  min: 'minor',
  dim: 'diminished',
  dom7: 'dominant',
};

function harmonyXml(c: Chord, key: Key, offset: number): string {
  return `<harmony print-frame="no">${rootXml(c.root, key)}<kind>${KIND[c.quality]}</kind>${
    offset ? `<offset>${offset}</offset>` : ''
  }<staff>1</staff></harmony>`;
}

/** Điền dấu lặng vào khoảng trống, trả về các sự kiện liên tục trong [0, end). */
function fillRests(evs: Ev[], end: number): Ev[] {
  const out: Ev[] = [];
  let t = 0;
  for (const e of [...evs].sort((a, b) => a.start - b.start)) {
    if (e.start > t) out.push({ start: t, dur: e.start - t, midis: [] });
    const s = Math.max(e.start, t);
    const d = e.start + e.dur - s;
    if (d > 0) out.push({ ...e, start: s, dur: d });
    t = Math.max(t, e.start + e.dur);
  }
  if (t < end) out.push({ start: t, dur: end - t, midis: [] });
  return out;
}

function noteElements(
  ev: Ev,
  pieceStart: number,
  pieceDur: number,
  key: Key,
  voice: number,
  staff: number,
  harmonies: string,
): string {
  const parts = splitDuration(pieceDur);
  let xml = harmonies;
  let cursor = pieceStart;
  parts.forEach((len, pi) => {
    const [, type, dotted] = DUR_TYPES.find(([l]) => l === len)!;
    const isFirstOfEvent = cursor === ev.start;
    const isLastOfEvent = cursor + len === ev.start + ev.dur;
    if (ev.midis.length === 0) {
      xml += `<note><rest/><duration>${len}</duration><voice>${voice}</voice><type>${type}</type>${
        dotted ? '<dot/>' : ''
      }<staff>${staff}</staff></note>`;
    } else {
      ev.midis.forEach((m, mi) => {
        const tieStart = !isLastOfEvent;
        const tieStop = !isFirstOfEvent;
        const ties = `${tieStop ? '<tie type="stop"/>' : ''}${tieStart ? '<tie type="start"/>' : ''}`;
        const tied = `${tieStop ? '<tied type="stop"/>' : ''}${tieStart ? '<tied type="start"/>' : ''}`;
        const slurXml =
          mi === 0 && isFirstOfEvent && ev.slur === 'start'
            ? '<slur type="start" number="1"/>'
            : mi === 0 && isLastOfEvent && ev.slur === 'stop'
              ? '<slur type="stop" number="1"/>'
              : '';
        const notations = tied + slurXml;
        const lyric =
          mi === 0 && isFirstOfEvent && ev.lyric
            ? `<lyric number="1"><syllabic>single</syllabic><text>${esc(ev.lyric)}</text></lyric>`
            : '';
        xml += `<note>${mi > 0 ? '<chord/>' : ''}${pitchXml(m, key)}<duration>${len}</duration>${ties}<voice>${voice}</voice><type>${type}</type>${
          dotted ? '<dot/>' : ''
        }<staff>${staff}</staff>${notations ? `<notations>${notations}</notations>` : ''}${lyric}</note>`;
      });
    }
    cursor += len;
    void pi;
  });
  return xml;
}

export function songToMusicXml(song: Song, chords: Chord[]): string {
  const key = song.key;
  const mTicks = measureTicks(song);
  const end = songEndTick(song);
  const nMeasures = end / mTicks;

  const melody = fillRests(
    song.notes.map((n) => ({ start: n.start, dur: n.dur, midis: [n.midi], lyric: n.lyric, slur: n.slur })),
    end,
  );
  // tay trái: gom nốt cùng thời điểm & trường độ thành hợp âm
  const lhRaw = generateLeftHand(chords, song.lhPattern, song.beatsPerMeasure);
  const lhMap = new Map<string, Ev>();
  for (const n of lhRaw) {
    const k = `${n.start}:${n.dur}`;
    const ev = lhMap.get(k) ?? { start: n.start, dur: n.dur, midis: [] };
    ev.midis.push(n.midi);
    lhMap.set(k, ev);
  }
  const lh = fillRests(
    [...lhMap.values()].map((e) => ({ ...e, midis: e.midis.sort((a, b) => a - b) })),
    end,
  );

  let measures = '';
  for (let mi = 0; mi < nMeasures; mi++) {
    const ms = mi * mTicks;
    const me = ms + mTicks;
    let x = `<measure number="${mi + 1}">`;
    if (mi === 0) {
      x += `<attributes><divisions>${TPB}</divisions><key><fifths>${keyFifths(key)}</fifths><mode>${key.mode}</mode></key><time><beats>${song.beatsPerMeasure}</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`;
      x += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${song.tempo}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${song.tempo}"/></direction>`;
    }
    // bè giai điệu (staff 1)
    const chordStarts = chords.filter((c) => c.start >= ms && c.start < me);
    const usedChord = new Set<Chord>();
    for (const ev of melody) {
      const a = Math.max(ev.start, ms);
      const b = Math.min(ev.start + ev.dur, me);
      if (b <= a) continue;
      let harm = '';
      for (const c of chordStarts) {
        if (!usedChord.has(c) && c.start >= a && c.start < b) {
          harm += harmonyXml(c, key, c.start - a);
          usedChord.add(c);
        }
      }
      x += noteElements(ev, a, b - a, key, 1, 1, harm);
    }
    // bè tay trái (staff 2)
    x += `<backup><duration>${mTicks}</duration></backup>`;
    for (const ev of lh) {
      const a = Math.max(ev.start, ms);
      const b = Math.min(ev.start + ev.dur, me);
      if (b <= a) continue;
      x += noteElements(ev, a, b - a, key, 5, 2, '');
    }
    if (mi === nMeasures - 1) x += `<barline location="right"><bar-style>light-heavy</bar-style></barline>`;
    x += '</measure>';
    measures += x;
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><work><work-title>${esc(song.title)}</work-title></work><identification><encoding><software>Hát ra nhạc</software></encoding></identification><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
}
