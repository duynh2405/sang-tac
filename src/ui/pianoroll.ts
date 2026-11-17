import { TPB, measureTicks, songEndTick, type Chord, type Note, type Song } from '../model';
import { chordName, midiName } from '../music/theory';

const KEY_W = 44; // cột tên nốt bên trái
const CHORD_H = 26; // làn hợp âm phía trên
const ROW_H = 16;
const BLACK = new Set([1, 3, 6, 8, 10]);

export interface RollCallbacks {
  onChange: (notes: Note[], commit: boolean) => void;
  onSelect: (index: number | null) => void;
  onChordClick: (chordIndex: number) => void;
  onPreview: (midi: number) => void;
}

type Drag =
  | { mode: 'move'; index: number; x0: number; y0: number; orig: Note; moved: boolean }
  | { mode: 'resize'; index: number; x0: number; orig: Note; moved: boolean };

export class PianoRoll {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private song: Song;
  private chords: Chord[] = [];
  private warnIdx = new Set<number>();
  selected: number | null = null;
  grid = 2;
  pxPerTick = 12;
  private lo = 55;
  private hi = 79;
  private drag: Drag | null = null;
  private playTick = -1;
  private lastTap = 0;

  constructor(private host: HTMLElement, song: Song, private cb: RollCallbacks) {
    this.song = song;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'roll-canvas';
    this.canvas.tabIndex = 0;
    host.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.up(e));
    this.canvas.addEventListener('pointercancel', () => (this.drag = null));
    this.canvas.addEventListener('dblclick', (e) => this.addAt(e));
  }

  setData(song: Song, chords: Chord[], warnIdx: Set<number>) {
    this.song = song;
    this.chords = chords;
    this.warnIdx = warnIdx;
    const mids = song.notes.map((n) => n.midi);
    const min = mids.length ? Math.min(...mids) : 60;
    const max = mids.length ? Math.max(...mids) : 72;
    // giữ dải cao độ đủ rộng (ít nhất ~2 quãng 8) để dễ kéo nốt
    let lo = min - 4;
    let hi = max + 4;
    while (hi - lo < 24) {
      lo--;
      hi++;
    }
    this.lo = Math.max(24, lo);
    this.hi = Math.min(100, hi);
    this.draw();
  }

  setPlayhead(tick: number) {
    this.playTick = tick;
    this.draw();
    if (tick >= 0) {
      const x = KEY_W + tick * this.pxPerTick;
      const h = this.host;
      if (x > h.scrollLeft + h.clientWidth - 40 || x < h.scrollLeft) h.scrollLeft = Math.max(0, x - 80);
    }
  }

  private width(): number {
    return KEY_W + (songEndTick(this.song) + measureTicks(this.song)) * this.pxPerTick;
  }

  private height(): number {
    return CHORD_H + (this.hi - this.lo + 1) * ROW_H;
  }

  private y(midi: number): number {
    return CHORD_H + (this.hi - midi) * ROW_H;
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.width();
    const H = this.height();
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = W + 'px';
      this.canvas.style.height = H + 'px';
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (v: string, d: string) => css.getPropertyValue(v).trim() || d;
    g.fillStyle = col('--roll-bg', '#fff');
    g.fillRect(0, 0, W, H);

    // các hàng cao độ
    for (let m = this.lo; m <= this.hi; m++) {
      const y = this.y(m);
      if (BLACK.has(m % 12)) {
        g.fillStyle = col('--roll-black', '#f1f3f6');
        g.fillRect(KEY_W, y, W - KEY_W, ROW_H);
      }
      g.fillStyle = m % 12 === 0 ? col('--ink', '#222') : col('--muted', '#888');
      g.font = `${m % 12 === 0 ? 'bold ' : ''}10px system-ui, sans-serif`;
      g.fillText(midiName(m, this.song.key), 4, y + ROW_H - 4);
    }

    // vạch nhịp
    const mt = measureTicks(this.song);
    const end = songEndTick(this.song) + mt;
    for (let t = 0; t <= end; t += this.grid) {
      const x = KEY_W + t * this.pxPerTick;
      g.strokeStyle = t % mt === 0 ? col('--roll-bar', '#9aa3ad') : t % TPB === 0 ? col('--roll-beat', '#d5dae0') : col('--roll-sub', '#eef0f3');
      g.lineWidth = t % mt === 0 ? 1.5 : 1;
      g.beginPath();
      g.moveTo(x + 0.5, t % mt === 0 ? 0 : CHORD_H);
      g.lineTo(x + 0.5, H);
      g.stroke();
      if (t % mt === 0 && t < end) {
        g.fillStyle = col('--muted', '#888');
        g.font = '9px system-ui, sans-serif';
        g.fillText(String(t / mt + 1), x + 3, 9);
      }
    }

    // làn hợp âm
    this.chords.forEach((c) => {
      const x = KEY_W + c.start * this.pxPerTick;
      const w = c.dur * this.pxPerTick;
      g.fillStyle = col('--chord-bg', '#eef4ff');
      g.fillRect(x + 1, 11, w - 2, CHORD_H - 13);
      g.fillStyle = col('--accent', '#2457d6');
      g.font = 'bold 12px system-ui, sans-serif';
      g.fillText(chordName(c, this.song.key), x + 5, CHORD_H - 5);
    });

    // nốt
    this.song.notes.forEach((n, i) => {
      if (n.midi < this.lo || n.midi > this.hi) return;
      const x = KEY_W + n.start * this.pxPerTick;
      const y = this.y(n.midi);
      const w = Math.max(4, n.dur * this.pxPerTick - 1);
      const sel = i === this.selected;
      g.fillStyle = sel ? col('--note-sel', '#ff8a00') : this.warnIdx.has(i) ? col('--note-warn', '#e5484d') : col('--note', '#2f6fed');
      roundRect(g, x + 0.5, y + 1, w, ROW_H - 2, 4);
      g.fill();
      if (n.lyric) {
        g.fillStyle = '#fff';
        g.font = '11px system-ui, sans-serif';
        g.save();
        g.beginPath();
        g.rect(x, y, w, ROW_H);
        g.clip();
        g.fillText(n.lyric, x + 4, y + ROW_H - 4);
        g.restore();
      }
    });

    // đầu phát
    if (this.playTick >= 0) {
      const x = KEY_W + this.playTick * this.pxPerTick;
      g.strokeStyle = col('--play', '#16a34a');
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
    }
  }

  private pos(e: PointerEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hit(x: number, y: number): { index: number; edge: boolean } | null {
    for (let i = this.song.notes.length - 1; i >= 0; i--) {
      const n = this.song.notes[i];
      const nx = KEY_W + n.start * this.pxPerTick;
      const ny = this.y(n.midi);
      const w = n.dur * this.pxPerTick;
      if (x >= nx && x <= nx + w && y >= ny && y <= ny + ROW_H) return { index: i, edge: x > nx + w - 8 && w > 14 };
    }
    return null;
  }

  private down(e: PointerEvent) {
    const { x, y } = this.pos(e);
    this.canvas.focus();
    if (y < CHORD_H && x > KEY_W) {
      const tick = (x - KEY_W) / this.pxPerTick;
      const ci = this.chords.findIndex((c) => tick >= c.start && tick < c.start + c.dur);
      if (ci >= 0) this.cb.onChordClick(ci);
      return;
    }
    const h = this.hit(x, y);
    if (!h) {
      // chạm hai lần liên tiếp trên điện thoại = thêm nốt
      const now = Date.now();
      if (e.pointerType !== 'mouse' && now - this.lastTap < 350) this.addAt(e);
      this.lastTap = now;
      this.selected = null;
      this.cb.onSelect(null);
      this.draw();
      return;
    }
    this.selected = h.index;
    this.cb.onSelect(h.index);
    const orig = { ...this.song.notes[h.index] };
    this.drag = h.edge
      ? { mode: 'resize', index: h.index, x0: x, orig, moved: false }
      : { mode: 'move', index: h.index, x0: x, y0: y, orig, moved: false };
    this.canvas.setPointerCapture(e.pointerId);
    this.cb.onPreview(orig.midi);
    this.draw();
  }

  private move(e: PointerEvent) {
    const { x, y } = this.pos(e);
    if (!this.drag) {
      const h = y >= CHORD_H ? this.hit(x, y) : null;
      this.canvas.style.cursor = h?.edge ? 'ew-resize' : h ? 'grab' : y < CHORD_H ? 'pointer' : 'default';
      return;
    }
    const d = this.drag;
    const notes = this.song.notes.map((n) => ({ ...n }));
    const snap = (t: number) => Math.round(t / this.grid) * this.grid;
    if (d.mode === 'move') {
      const dt = snap((x - d.x0) / this.pxPerTick);
      const dm = -Math.round((y - d.y0) / ROW_H);
      const n = notes[d.index];
      const newMidi = Math.max(24, Math.min(100, d.orig.midi + dm));
      if (newMidi !== n.midi) this.cb.onPreview(newMidi);
      n.start = Math.max(0, d.orig.start + dt);
      n.midi = newMidi;
      d.moved = d.moved || dt !== 0 || dm !== 0;
    } else {
      const dt = snap((x - d.x0) / this.pxPerTick);
      notes[d.index].dur = Math.max(1, d.orig.dur + dt);
      d.moved = d.moved || dt !== 0;
    }
    this.cb.onChange(notes, false);
  }

  private up(e: PointerEvent) {
    if (!this.drag) return;
    const moved = this.drag.moved;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* bỏ qua */
    }
    if (moved) this.cb.onChange(this.song.notes, true);
  }

  private addAt(e: PointerEvent | MouseEvent) {
    const { x, y } = this.pos(e);
    if (x < KEY_W || y < CHORD_H) return;
    const midi = this.hi - Math.floor((y - CHORD_H) / ROW_H);
    const start = Math.floor((x - KEY_W) / this.pxPerTick / this.grid) * this.grid;
    const notes = [...this.song.notes, { start, dur: Math.max(this.grid, TPB), midi }];
    notes.sort((a, b) => a.start - b.start);
    this.selected = notes.findIndex((n) => n.start === start && n.midi === midi);
    this.cb.onPreview(midi);
    this.cb.onChange(notes, true);
    this.cb.onSelect(this.selected);
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
