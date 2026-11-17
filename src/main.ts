import './styles.css';
import { TPB } from './model';
import { chordName, chordPcs, diatonicChords, keyName, midiName, parseChordName, solfegeName, mod12 } from './music/theory';
import { songToMusicXml } from './music/musicxml';
import { songToMidi } from './music/midi';
import { checkTones } from './lyrics/vietnamese';
import {
  defaultDur,
  defaultMidi,
  demoCompose,
  measureCount,
  newCompose,
  relyric,
  suggestChords,
  toSong,
  totalTicks,
  wordStarts,
  type ComposeSong,
  type WordChord,
} from './compose';
import { listSongs, saveSong, deleteSong } from './storage';
import { APP_VERSION, setupInstall, setupUpdates } from './pwa';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Phần nặng (tiếng piano, vẽ sheet) chỉ tải khi cần
type PlayerMod = typeof import('./ui/player');
let playerMod: PlayerMod | null = null;
const getPlayer = async () => (playerMod ??= await import('./ui/player'));

// ---------- trạng thái ----------
let cs: ComposeSong = listSongs()[0] ?? demoCompose();
let cur: number | null = null; // chữ đang chọn
let draft: { midi: number | null; dur: number; rest: number; chord: WordChord | null } | null = null;
let dirty = false;
let playing = false;
let playingLine: number | null = null; // câu đang phát (null = cả bài)
const undoStack: string[] = [];

const DURS: [number, string, string][] = [
  [1, 'Móc kép', '¼'],
  [2, 'Móc đơn', '½'],
  [3, 'Móc đơn chấm', '¾'],
  [4, 'Đen', '1 phách'],
  [6, 'Đen chấm', '1½'],
  [8, 'Trắng', '2 phách'],
  [12, 'Trắng chấm', '3 phách'],
  [16, 'Tròn', '4 phách'],
];
const RESTS: [number, string][] = [
  [0, 'Không'],
  [2, '½ phách'],
  [4, '1 phách'],
  [8, '2 phách'],
  [16, '4 phách'],
];
const KB_LO = 48; // C3
const KB_HI = 83; // B5

const beatsLabel = (t: number) => {
  const b = t / TPB;
  return b === 0.25 ? '¼' : b === 0.5 ? '½' : b === 0.75 ? '¾' : b === 1.5 ? '1½' : String(b);
};

// ---------- lưu ----------
let saveTimer: number | null = null;
function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    cs.updated = Date.now();
    if (!saveSong(cs)) toast('Không lưu được trên trình duyệt này.');
  }, 300);
}

function snapshot() {
  undoStack.push(JSON.stringify(cs));
  if (undoStack.length > 80) undoStack.shift();
  ($('btnUndo') as HTMLButtonElement).disabled = false;
}

function undo() {
  const s = undoStack.pop();
  if (!s) return;
  cs = JSON.parse(s);
  closeEditor(false);
  renderAll();
  persist();
  ($('btnUndo') as HTMLButtonElement).disabled = undoStack.length === 0;
}

// ---------- hiển thị ----------
function currentKey() {
  return toSong(cs).song.key;
}

function renderSettings() {
  ($('title') as HTMLInputElement).value = cs.title;
  ($('tempo') as HTMLInputElement).value = String(cs.tempo);
  ($('lh') as HTMLSelectElement).value = cs.lhPattern;
  document.querySelectorAll<HTMLButtonElement>('#meterSeg button').forEach((b) =>
    b.classList.toggle('on', Number(b.dataset.v) === cs.beatsPerMeasure),
  );
  const sel = $('key') as HTMLSelectElement;
  if (!sel.options.length) {
    sel.add(new Option('Tự nhận', 'auto'));
    for (const mode of ['major', 'minor'] as const)
      for (let t = 0; t < 12; t++) sel.add(new Option(keyName({ tonic: t, mode }), `${t}:${mode}`));
  }
  const k = currentKey();
  sel.options[0].text = `Tự nhận (${keyName(k)})`;
  sel.value = cs.keyAuto ? 'auto' : `${cs.key.tonic}:${cs.key.mode}`;
}

function renderLines() {
  const box = $('lines');
  box.innerHTML = '';
  const { song } = toSong(cs);
  const key = song.key;
  // cảnh báo dấu thanh (theo chỉ số nốt) -> chỉ số chữ
  const noteWord: number[] = [];
  cs.words.forEach((w, i) => w.midi !== null && noteWord.push(i));
  const warnWords = new Set(checkTones(song.notes).map((w) => noteWord[w.noteIndex]));

  let lineNo = 0;
  const newLine = () => {
    const l = document.createElement('div');
    l.className = 'line' + (lineNo === playingLine ? ' playing-line' : '');
    l.dataset.line = String(lineNo);
    const pb = document.createElement('button');
    pb.className = 'lp';
    const n = lineNo;
    pb.title = `Nghe câu ${n + 1}`;
    pb.setAttribute('aria-label', `Nghe câu ${n + 1}`);
    pb.textContent = n === playingLine ? '■' : '▶';
    pb.onclick = () => (playingLine === n ? stopPlay() : void playLine(n));
    const mb = document.createElement('button');
    mb.className = 'lm';
    mb.textContent = '⋯';
    mb.title = `Tùy chọn câu ${n + 1}: chép nốt, xóa hợp âm`;
    mb.setAttribute('aria-label', mb.title);
    mb.onclick = () => openLineMenu(n);
    const ctl = document.createElement('div');
    ctl.className = 'lctl';
    ctl.append(pb, mb);
    l.append(ctl);
    return l;
  };
  let line = newLine();
  cs.words.forEach((w, i) => {
    const b = document.createElement('button');
    b.className = 'w' + (w.done ? ' done' : '') + (i === cur ? ' cur' : '') + (warnWords.has(i) ? ' warn' : '');
    b.dataset.i = String(i);
    const shown = i === cur && draft ? { ...w, ...draft } : w;
    const ch = document.createElement('span');
    ch.className = 'ch';
    ch.textContent = shown.chord ? chordName(shown.chord, key) : '';
    if (shown.chord && i !== cur) {
      ch.classList.add('has');
      ch.title = 'Bấm để đổi hoặc xóa hợp âm';
      ch.onclick = (e) => {
        e.stopPropagation();
        openChordQuick(i);
      };
    }
    const tx = document.createElement('span');
    tx.className = 'tx';
    tx.textContent = w.text;
    const nt = document.createElement('span');
    nt.className = 'nt';
    nt.textContent =
      shown.midi !== null && (w.done || i === cur)
        ? `${solfegeName(shown.midi)} · ${beatsLabel(shown.dur)}${shown.rest ? ` +${beatsLabel(shown.rest)}` : ''}`
        : w.done
          ? `lặng · ${beatsLabel(shown.dur)}`
          : '';
    b.append(ch, tx, nt);
    b.onclick = () => openEditor(i);
    line.append(b);
    if (w.br) {
      box.append(line);
      lineNo++;
      line = newLine();
    }
  });
  if (line.childElementCount > 1) box.append(line);

  const done = cs.words.filter((w) => w.done).length;
  $('status').innerHTML = `Đã viết <b>${done}</b>/${cs.words.length} chữ · ${measureCount(cs)} ô nhịp · ${keyName(key)}`;
}

function renderAll() {
  renderSettings();
  const hasWords = cs.words.length > 0;
  $('lyricsEdit').hidden = hasWords;
  $('songView').hidden = !hasWords;
  $('lyricsCancel').hidden = true;
  if (!hasWords) ($('lyrics') as HTMLTextAreaElement).value = cs.lyricsText;
  renderLines();
  ($('btnUndo') as HTMLButtonElement).disabled = undoStack.length === 0;
}

function toast(msg: string, ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((toast as any)._t);
  (toast as any)._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- bàn phím piano ----------
const BLACK = new Set([1, 3, 6, 8, 10]);
function buildKeyboard() {
  const kb = $('keyboard');
  kb.innerHTML = '';
  let whiteIndex = 0;
  for (let m = KB_LO; m <= KB_HI; m++) {
    const k = document.createElement('button');
    k.className = 'key ' + (BLACK.has(m % 12) ? 'black' : 'white') + (m % 12 === 0 ? ' c' : '');
    k.dataset.m = String(m);
    k.setAttribute('aria-label', solfegeName(m));
    if (BLACK.has(m % 12)) {
      k.style.left = `${whiteIndex * 40}px`;
    } else {
      k.textContent = m % 12 === 0 ? `Đô${Math.floor(m / 12) - 1}` : '';
      whiteIndex++;
    }
    k.onclick = () => setDraftMidi(m);
    kb.append(k);
  }
  kb.style.width = `${whiteIndex * 40}px`;
}

function highlightKey(scroll: boolean) {
  const m = draft?.midi ?? null;
  document.querySelectorAll<HTMLElement>('#keyboard .key').forEach((k) => k.classList.toggle('on', Number(k.dataset.m) === m));
  if (scroll && m !== null) {
    const el = document.querySelector<HTMLElement>(`#keyboard .key[data-m="${m}"]`);
    const wrap = $('kbWrap');
    if (el) wrap.scrollLeft = Math.max(0, el.offsetLeft - wrap.clientWidth / 2 + 20);
  }
}

// ---------- bảng chọn nốt ----------
function effectiveChord(index: number): WordChord | null {
  for (let i = index; i >= 0; i--) {
    const c = i === cur && draft ? draft.chord : cs.words[i].chord;
    if (c) return c;
  }
  return null;
}

function openEditor(i: number) {
  if (cur !== null && dirty) commitDraft(false);
  stopPlay();
  cur = i;
  const w = cs.words[i];
  const key = currentKey();
  draft = {
    midi: w.done ? w.midi : defaultMidi(cs.words, i, key),
    dur: w.done ? w.dur : defaultDur(cs.words, i),
    rest: w.rest,
    chord: w.chord,
  };
  dirty = false; // chỉ lưu khi người dùng chỉnh hoặc bấm OK
  $('editor').hidden = false;
  renderEditor(true);
  renderLines();
  document.body.classList.add('editing');
  // cuộn để chữ đang chọn nằm phía trên bảng chọn nốt
  const el = document.querySelector<HTMLElement>(`.w[data-i="${i}"]`);
  const board = document.querySelector<HTMLElement>('.board')!;
  if (el) {
    const free = board.clientHeight - $('editor').offsetHeight + (board.getBoundingClientRect().top - 0);
    const top = el.getBoundingClientRect().top - board.getBoundingClientRect().top;
    const want = Math.max(8, Math.min(free - 120, board.clientHeight * 0.18));
    board.scrollTo({ top: board.scrollTop + top - want, behavior: 'smooth' });
  }
}

function renderEditor(scrollKeys = false) {
  if (cur === null || !draft) return;
  const w = cs.words[cur];
  const key = currentKey();
  $('edIndex').textContent = `Chữ ${cur + 1}/${cs.words.length}`;
  $('edWord').textContent = w.text;
  ($('edPrev') as HTMLButtonElement).disabled = cur === 0;
  ($('edNext') as HTMLButtonElement).disabled = cur === cs.words.length - 1;
  $('edNote').innerHTML =
    draft.midi === null ? 'Lặng <small>(không hát)</small>' : `${solfegeName(draft.midi)} <small>${midiName(draft.midi, key)}</small>`;
  highlightKey(scrollKeys);

  const dur = $('durChips');
  dur.innerHTML = '';
  for (const [t, name, sub] of DURS) {
    const b = document.createElement('button');
    b.className = t === draft.dur ? 'on' : '';
    b.innerHTML = `${name}<small>${sub}</small>`;
    b.onclick = () => {
      draft!.dur = t;
      dirty = true;
      renderEditor();
      renderLines();
    };
    dur.append(b);
  }

  const rest = $('restChips');
  rest.innerHTML = '';
  for (const [t, name] of RESTS) {
    const b = document.createElement('button');
    b.className = t === draft.rest ? 'on' : '';
    b.textContent = name;
    b.onclick = () => {
      draft!.rest = t;
      dirty = true;
      renderEditor();
      renderLines();
    };
    rest.append(b);
  }

  const chips = $('chordChips');
  chips.innerHTML = '';
  const none = document.createElement('button');
  none.className = draft.chord ? '' : 'on';
  none.innerHTML = '—<small>giữ hợp âm cũ</small>';
  none.onclick = () => setDraftChord(null);
  chips.append(none);
  const seen = new Set<string>();
  const options = diatonicChords(key).map((c) => ({ root: c.root, quality: c.quality, sub: c.degree }));
  if (draft.chord) options.unshift({ ...draft.chord, sub: '' });
  for (const c of options) {
    const name = chordName(c, key);
    if (seen.has(name)) continue;
    seen.add(name);
    const b = document.createElement('button');
    const on = !!draft.chord && draft.chord.root === c.root && draft.chord.quality === c.quality;
    b.className = on ? 'on' : '';
    b.innerHTML = `${name}<small>${c.sub || 'đang chọn'}</small>`;
    b.onclick = () => setDraftChord({ root: c.root, quality: c.quality });
    chips.append(b);
  }
  const other = document.createElement('button');
  other.innerHTML = 'Khác…<small>gõ tên</small>';
  other.onclick = () => {
    ($('chordInput') as HTMLInputElement).value = draft?.chord ? chordName(draft.chord, key) : '';
    ($('chordDialog') as HTMLDialogElement).showModal();
  };
  chips.append(other);
  const prev = cur > 0 ? effectiveChord(cur - 1) : null;
  $('edChordNow').textContent = draft.chord ? '' : prev ? `· đang vang ${chordName(prev, key)}` : '· chưa có';

  // cảnh báo dấu thanh cho chữ này (so với chữ trước)
  const warnEl = $('edWarn');
  warnEl.hidden = true;
  if (draft.midi !== null && cur > 0) {
    let pi = cur - 1;
    while (pi >= 0 && cs.words[pi].midi === null) pi--;
    if (pi >= 0) {
      const a = cs.words[pi];
      const warns = checkTones([
        { start: 0, dur: 4, midi: a.midi!, lyric: a.text },
        { start: 4, dur: 4, midi: draft.midi, lyric: w.text },
      ]);
      if (warns.length) {
        warnEl.textContent = '💡 ' + warns[0].message;
        warnEl.hidden = false;
      }
    }
  }
}

function setDraftMidi(m: number) {
  if (!draft) return;
  draft.midi = Math.max(KB_LO - 12, Math.min(KB_HI + 12, m));
  dirty = true;
  renderEditor();
  renderLines();
  preview();
}

function setDraftChord(c: WordChord | null) {
  if (!draft) return;
  draft.chord = c;
  dirty = true;
  renderEditor();
  renderLines();
  preview();
}

function preview() {
  if (cur === null || !draft) return;
  const ch = effectiveChord(cur);
  // bass (G2–F#3) + hợp âm (G3–F#4), giống phần đệm tay trái
  const lh = ch ? [43 + mod12(ch.root - 7), ...chordPcs(ch).map((pc) => 55 + mod12(pc - 7))] : [];
  const secs = Math.min(1.6, (draft.dur * 60) / cs.tempo / TPB);
  void getPlayer().then((p) => p.previewWord(draft?.midi ?? null, lh, Math.max(0.3, secs)));
}

function commitDraft(markDone = true) {
  if (cur === null || !draft) return;
  snapshot();
  const w = cs.words[cur];
  cs.words[cur] = { ...w, ...draft, done: markDone ? true : w.done || dirty };
  dirty = false;
  persist();
}

function closeEditor(save = true) {
  if (save && cur !== null && dirty) commitDraft(false);
  cur = null;
  draft = null;
  dirty = false;
  $('editor').hidden = true;
  document.body.classList.remove('editing');
  renderLines();
  renderSettings();
}

function okNext() {
  if (cur === null) return;
  commitDraft(true);
  if (cur < cs.words.length - 1) {
    openEditor(cur + 1);
  } else {
    closeEditor(false);
    renderSettings();
    toast('Xong cả bài! Bấm ▶ để nghe thử.', 4000);
  }
}

function go(delta: number) {
  if (cur === null) return;
  const n = cur + delta;
  if (n < 0 || n >= cs.words.length) return;
  openEditor(n);
}

// ---------- nghe thử ----------
function setPlayUi(on: boolean) {
  $('btnPlay').classList.toggle('on', on);
  $('btnPlay').textContent = on ? '■' : '▶';
}

/** Các câu (dòng lời): chỉ số chữ đầu và cuối. */
function lineRanges(): { first: number; last: number }[] {
  const out: { first: number; last: number }[] = [];
  let first = 0;
  cs.words.forEach((w, i) => {
    if (w.br || i === cs.words.length - 1) {
      out.push({ first, last: i });
      first = i + 1;
    }
  });
  return out;
}

function lineOfWord(i: number): number {
  return lineRanges().findIndex((r) => i >= r.first && i <= r.last);
}

async function playLine(n: number) {
  const r = lineRanges()[n];
  if (!r) return;
  const starts = wordStarts(cs.words);
  const last = cs.words[r.last];
  await play({ from: starts[r.first], to: starts[r.last] + last.dur + last.rest, line: n });
}

async function play(range?: { from: number; to: number; line: number }) {
  // đang mở bảng chọn nốt mà nghe câu: lưu thay đổi nhưng giữ bảng mở
  if (cur !== null) {
    if (range) {
      if (dirty) commitDraft(false);
    } else closeEditor();
  }
  stopPlay();
  const { song, chords: allChords } = toSong(cs);
  const from = range?.from ?? 0;
  const to = range?.to ?? Infinity;
  const hasNotes = song.notes.some((n) => n.start >= from && n.start < to);
  if (!hasNotes) return toast(range ? 'Câu này chưa có nốt nào.' : 'Chưa có nốt nào. Bấm vào một chữ để bắt đầu.');
  // cắt hợp âm theo đoạn được phát để tay trái vào đúng từ đầu câu
  const chords = allChords
    .filter((c) => c.start < to && c.start + c.dur > from)
    .map((c) => {
      const s = Math.max(c.start, from);
      return { ...c, start: s, dur: Math.min(c.start + c.dur, to) - s };
    });
  playing = true;
  playingLine = range ? range.line : null;
  setPlayUi(true);
  renderLines();
  const p = await getPlayer();
  await p.play(song, chords, {
    melody: true,
    accompaniment: ($('playAcc') as HTMLInputElement).checked,
    fromTick: from,
    toTick: range ? to : undefined,
    onEnd: stopPlay,
  });
  const starts = wordStarts(cs.words);
  const total = Math.max(1, (range ? to : totalTicks(cs.words)) - from);
  const tick = () => {
    if (!playing) return;
    const sec = p.position();
    const rel = sec < 0 ? 0 : (sec * cs.tempo * TPB) / 60;
    const t = from + rel;
    ($('pfill') as HTMLElement).style.width = `${Math.min(100, (rel / total) * 100)}%`;
    const wi = starts.findIndex((s, i) => t >= s && t < s + cs.words[i].dur + cs.words[i].rest);
    document.querySelectorAll('.w.playing').forEach((e) => e.classList.remove('playing'));
    if (wi >= 0) document.querySelector(`.w[data-i="${wi}"]`)?.classList.add('playing');
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stopPlay() {
  const wasLine = playingLine !== null;
  playing = false;
  playingLine = null;
  playerMod?.stop();
  setPlayUi(false);
  if (wasLine) renderLines();
  ($('pfill') as HTMLElement).style.width = '0';
  document.querySelectorAll('.w.playing').forEach((e) => e.classList.remove('playing'));
}

// ---------- sheet & tải về ----------
function safeName() {
  return (cs.title || 'bai-hat').replace(/[\\/:*?"<>|]+/g, '').trim() || 'bai-hat';
}

function download(data: BlobPart, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function hasMusic(): boolean {
  if (cs.words.some((w) => w.midi !== null && w.done)) return true;
  toast('Chưa có nốt nào. Bấm vào một chữ để chọn nốt.');
  return false;
}

function midiBytes() {
  const { song, chords } = toSong(cs);
  return songToMidi(song, chords) as Uint8Array<ArrayBuffer>;
}

async function openSheet() {
  if (!hasMusic()) return;
  const dlg = $('sheetDialog') as HTMLDialogElement;
  dlg.showModal();
  const el = $('sheet');
  el.innerHTML = '<p style="padding:12px;color:#666">Đang vẽ sheet…</p>';
  try {
    const { song, chords } = toSong(cs);
    const { renderSheet } = await import('./ui/sheet');
    el.innerHTML = '';
    await renderSheet(el, songToMusicXml(song, chords));
  } catch (e) {
    console.error(e);
    el.innerHTML = '<p style="padding:12px;color:#666">Không vẽ được sheet.</p>';
  }
}

// ---------- thao tác theo câu ----------
let menuLine = 0;
const lineText = (r: { first: number; last: number }) => {
  const t = cs.words.slice(r.first, r.last + 1).map((w) => w.text).join(' ');
  return t.length > 38 ? t.slice(0, 36) + '…' : t;
};

function openLineMenu(n: number) {
  menuLine = n;
  const r = lineRanges()[n];
  $('lmTitle').textContent = `Câu ${n + 1}: ${lineText(r)}`;
  ($('lineMenu') as HTMLDialogElement).showModal();
}

/** Chép nốt & nhịp (và hợp âm nếu chọn) từ câu src sang câu dst, theo thứ tự chữ. */
function copyLine(src: number, dst: number, withChords: boolean) {
  const rs = lineRanges();
  const a = rs[src];
  const b = rs[dst];
  const la = a.last - a.first + 1;
  const lb = b.last - b.first + 1;
  const n = Math.min(la, lb);
  closeEditor(false);
  snapshot();
  let copied = 0;
  for (let k = 0; k < n; k++) {
    const s = cs.words[a.first + k];
    const d = cs.words[b.first + k];
    if (!s.done) continue;
    d.midi = s.midi;
    d.dur = s.dur;
    d.rest = s.rest;
    d.done = true;
    if (withChords) d.chord = s.chord ? { ...s.chord } : null;
    copied++;
  }
  persist();
  renderLines();
  let msg = `Đã chép ${copied} nốt từ câu ${src + 1} sang câu ${dst + 1}.`;
  if (lb > la) msg += ` Câu ${dst + 1} dài hơn ${lb - la} chữ, hãy viết thêm phần cuối.`;
  else if (la > lb) msg += ` Câu ${src + 1} dài hơn, bỏ ${la - lb} nốt cuối.`;
  toast(msg, 4500);
  // chuyển tới chữ đầu tiên chưa có nốt của câu đích (nếu có)
  for (let i = b.first; i <= b.last; i++) if (!cs.words[i].done) return openEditor(i);
}

function openCopy(mode: 'from' | 'to') {
  const rs = lineRanges();
  const me = menuLine;
  ($('lineMenu') as HTMLDialogElement).close();
  $('cpTitle').textContent = mode === 'from' ? `Lấy nốt cho câu ${me + 1} từ…` : `Chép nốt câu ${me + 1} sang…`;
  $('cpHint').textContent =
    'Nốt được chép lần lượt theo từng chữ. Hợp với các câu có giai điệu lặp lại (cùng số chữ). Có thể bấm ↶ để hoàn tác.';
  const myDone = cs.words.slice(rs[me].first, rs[me].last + 1).filter((w) => w.done).length;
  const list = $('cpList');
  list.innerHTML = '';
  if (mode === 'to' && !myDone) {
    list.innerHTML = '<p class="hint">Câu này chưa có nốt nào để chép.</p>';
  }
  rs.forEach((r, n) => {
    if (n === me) return;
    const words = cs.words.slice(r.first, r.last + 1);
    const done = words.filter((w) => w.done).length;
    const b = document.createElement('button');
    const info =
      mode === 'from'
        ? done
          ? `${words.length} chữ · ${done} nốt`
          : `${words.length} chữ · chưa có nốt`
        : `${words.length} chữ${done ? ` · đã có ${done} nốt (sẽ bị ghi đè)` : ' · chưa có nốt'}`;
    b.innerHTML = `<span>Câu ${n + 1}: ${lineText(r).replace(/</g, '&lt;')}</span><small>${info}</small>`;
    b.disabled = mode === 'from' ? !done : !myDone;
    b.onclick = () => {
      ($('copyDialog') as HTMLDialogElement).close();
      const wc = ($('cpChords') as HTMLInputElement).checked;
      mode === 'from' ? copyLine(n, me, wc) : copyLine(me, n, wc);
    };
    list.append(b);
  });
  ($('copyDialog') as HTMLDialogElement).showModal();
}

/** Xóa hợp âm: line = số câu, hoặc null = cả bài. */
function clearChords(line: number | null) {
  const r = line === null ? { first: 0, last: cs.words.length - 1 } : lineRanges()[line];
  const ws = cs.words.slice(r.first, r.last + 1);
  if (!ws.some((w) => w.chord)) return toast(line === null ? 'Bài chưa có hợp âm nào.' : 'Câu này chưa có hợp âm.');
  if (line === null && !confirm('Xóa tất cả hợp âm trong bài? (có thể bấm ↶ để hoàn tác)')) return;
  closeEditor(false);
  snapshot();
  ws.forEach((w) => (w.chord = null));
  persist();
  renderLines();
  toast(line === null ? 'Đã xóa hợp âm cả bài.' : `Đã xóa hợp âm câu ${line + 1}.`);
}

function clearNotes(line: number) {
  const r = lineRanges()[line];
  const ws = cs.words.slice(r.first, r.last + 1);
  if (!ws.some((w) => w.done)) return toast('Câu này chưa có nốt.');
  closeEditor(false);
  snapshot();
  ws.forEach((w) => {
    w.done = false;
    w.midi = null;
    w.rest = 0;
  });
  persist();
  renderLines();
  toast(`Đã xóa nốt câu ${line + 1}.`);
}

// ---------- sửa nhanh hợp âm trên lời ----------
let quickTarget: number | null = null;

function setWordChord(i: number, c: WordChord | null) {
  snapshot();
  cs.words[i].chord = c;
  persist();
  renderLines();
}

function openChordQuick(i: number) {
  const w = cs.words[i];
  if (!w.chord) return;
  quickTarget = i;
  const key = toSong(cs).song.key;
  $('cqTitle').textContent = `Hợp âm trên chữ «${w.text}»`;
  const box = $('cqChips');
  box.innerHTML = '';
  const seen = new Set<string>();
  const opts = [{ ...w.chord, sub: 'đang dùng' }, ...diatonicChords(key).map((c) => ({ root: c.root, quality: c.quality, sub: c.degree }))];
  for (const c of opts) {
    const name = chordName(c, key);
    if (seen.has(name)) continue;
    seen.add(name);
    const b = document.createElement('button');
    b.className = c.root === w.chord.root && c.quality === w.chord.quality ? 'on' : '';
    b.innerHTML = `${name}<small>${c.sub}</small>`;
    b.onclick = () => {
      setWordChord(i, { root: c.root, quality: c.quality });
      ($('chordQuick') as HTMLDialogElement).close();
    };
    box.append(b);
  }
  const other = document.createElement('button');
  other.innerHTML = 'Khác…<small>gõ tên</small>';
  other.onclick = () => {
    ($('chordInput') as HTMLInputElement).value = chordName(w.chord!, key);
    ($('chordDialog') as HTMLDialogElement).showModal();
  };
  box.append(other);
  ($('chordQuick') as HTMLDialogElement).showModal();
}

// ---------- tra vần ----------
type RhymeMod = typeof import('./lyrics/rhyme');
let rhymeMod: RhymeMod | null = null;
let rhymeIdx: import('./lyrics/rhyme').RhymeIndex | null = null;
let rhymeSameTone = true;
let lyricsCaret: { start: number; end: number } | null = null;

/** Chữ ngay trước con trỏ (hoặc chữ đang bôi đen) trong ô lời. */
function wordAtCaret(): string {
  const ta = $('lyrics') as HTMLTextAreaElement;
  const { selectionStart: a, selectionEnd: b, value } = ta;
  if (b > a) return value.slice(a, b).trim().split(/\s+/).pop() ?? '';
  const before = value.slice(0, a).match(/([\p{L}]+)[^\p{L}]*$/u);
  return before ? before[1] : '';
}

async function openRhyme(word: string) {
  const dlg = $('rhymeDialog') as HTMLDialogElement;
  const inp = $('rhymeInput') as HTMLInputElement;
  inp.value = word;
  if (!dlg.open) dlg.showModal();
  if (!word) {
    $('rhymeInfo').textContent = '';
    $('rhymeBody').innerHTML = '<p class="rh-empty">Gõ một chữ để xem các chữ cùng vần.</p>';
    inp.focus();
    return;
  }
  await showRhymes(word);
}

async function showRhymes(word: string) {
  const body = $('rhymeBody');
  if (!rhymeIdx) {
    body.innerHTML = '<p class="rh-empty">Đang tải từ điển vần (khoảng 1 MB, chỉ lần đầu)…</p>';
    try {
      rhymeMod ??= await import('./lyrics/rhyme');
      rhymeIdx = await rhymeMod.loadRhymeIndex();
    } catch {
      body.innerHTML = '<p class="rh-empty">Không tải được từ điển. Kiểm tra kết nối mạng rồi thử lại.</p>';
      return;
    }
  }
  const R = rhymeMod!;
  const res = R.findRhymes(rhymeIdx, word, rhymeSameTone);
  body.innerHTML = '';
  if (!res) {
    $('rhymeInfo').textContent = '';
    body.innerHTML = '<p class="rh-empty">Không nhận ra chữ này. Hãy gõ một chữ tiếng Việt, ví dụ: mưa, người, tình.</p>';
    return;
  }
  const q = res.query;
  $('rhymeInfo').innerHTML = `Vần <b>-${q.rime}</b> · ${R.TONE_NAME[q.tone].toLowerCase()} (${R.isBang(q.tone) ? 'thanh bằng' : 'thanh trắc'})`;

  const chip = (text: string, rare = false) => {
    const b = document.createElement('button');
    b.textContent = text;
    if (rare) b.className = 'rare';
    b.onclick = () => useRhymeWord(text);
    return b;
  };
  const chipsBox = (items: string[], limit: number, rareOf?: (t: string) => boolean) => {
    const box = document.createElement('div');
    box.className = 'rh-chips';
    const render = (n: number) => {
      box.innerHTML = '';
      items.slice(0, n).forEach((t) => box.append(chip(t, rareOf?.(t))));
      if (items.length > n) {
        const more = document.createElement('button');
        more.className = 'more';
        more.textContent = `+${items.length - n} nữa`;
        more.onclick = () => render(n + limit * 3);
        box.append(more);
      }
    };
    render(limit);
    return box;
  };
  const section = (title: string, sub: string) => {
    const sec = document.createElement('div');
    sec.className = 'rh-sec';
    const h = document.createElement('h4');
    h.textContent = title;
    if (sub) {
      const sm = document.createElement('small');
      sm.textContent = sub;
      h.append(sm);
    }
    sec.append(h);
    body.append(sec);
    return sec;
  };
  const rare = (t: string) => (rhymeIdx!.freq.get(t) ?? 0) <= R.RARE;

  const total = res.sameRime.reduce((n, g) => n + g.syllables.length, 0);
  const s1 = section(`Cùng vần -${q.rime}`, `${total} chữ`);
  if (!total) s1.append(Object.assign(document.createElement('p'), { className: 'rh-empty', textContent: 'Không có chữ nào khác cùng vần.' }));
  for (const g of res.sameRime) {
    const row = document.createElement('div');
    row.className = 'rh-group';
    row.append(Object.assign(document.createElement('span'), { textContent: R.TONE_NAME[g.tone] }), chipsBox(g.syllables, 30, rare));
    s1.append(row);
  }
  if (res.words.length) section('Từ gợi ý ý tưởng', `${res.words.length} từ kết thúc bằng vần này`).append(chipsBox(res.words, 40));
  if (res.near.length) {
    const s3 = section('Vần gần', 'nghe gần giống, dùng khi cần linh hoạt');
    for (const g of res.near) {
      const row = document.createElement('div');
      row.className = 'rh-group';
      row.append(Object.assign(document.createElement('span'), { textContent: '-' + g.rime }), chipsBox(g.syllables, 12, rare));
      s3.append(row);
    }
  }
  body.scrollTop = 0;
}

function useRhymeWord(text: string) {
  const editing = !$('lyricsEdit').hidden;
  if (editing && lyricsCaret) {
    const ta = $('lyrics') as HTMLTextAreaElement;
    const v = ta.value;
    const before = v.slice(0, lyricsCaret.start);
    const after = v.slice(lyricsCaret.end);
    const pre = before && !/\s$/.test(before) ? ' ' : '';
    const post = after && !/^\s/.test(after) ? ' ' : '';
    ta.value = before + pre + text + post + after;
    const pos = before.length + pre.length + text.length + post.length;
    lyricsCaret = { start: pos, end: pos };
    ta.setSelectionRange(pos, pos);
    cs.lyricsText = ta.value;
    persist();
    toast(`Đã chèn «${text}» vào lời`);
    return;
  }
  navigator.clipboard?.writeText(text).then(
    () => toast(`Đã chép «${text}». Dán vào lời khi sửa lời.`),
    () => toast(text),
  );
}

// ---------- danh sách bài ----------
function openSongs() {
  const ul = $('songsList');
  ul.innerHTML = '';
  const all = listSongs();
  if (!all.length) ul.innerHTML = '<li><span>Chưa có bài nào.</span></li>';
  for (const s of all) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.innerHTML = '';
    name.append(s.title);
    const small = document.createElement('small');
    small.textContent = new Date(s.updated).toLocaleString('vi-VN');
    name.append(small);
    const open = document.createElement('button');
    open.className = 'small';
    open.textContent = 'Mở';
    open.onclick = () => {
      stopPlay();
      closeEditor(false);
      cs = s;
      undoStack.length = 0;
      renderAll();
      ($('songsDialog') as HTMLDialogElement).close();
    };
    const del = document.createElement('button');
    del.className = 'small ghost';
    del.textContent = 'Xóa';
    del.onclick = () => {
      if (!confirm(`Xóa bài "${s.title}"?`)) return;
      deleteSong(s.id);
      openSongs();
    };
    li.append(name, open, del);
    ul.append(li);
  }
  const dlg = $('songsDialog') as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
}

function newSongAction() {
  stopPlay();
  closeEditor();
  persist();
  cs = newCompose({ tempo: cs.tempo, beatsPerMeasure: cs.beatsPerMeasure, lhPattern: cs.lhPattern });
  undoStack.length = 0;
  renderAll();
  ($('lyrics') as HTMLTextAreaElement).focus();
}

// ---------- gắn sự kiện ----------
function bind() {
  ($('title') as HTMLInputElement).onchange = (e) => {
    cs.title = (e.target as HTMLInputElement).value.trim() || 'Bài hát mới';
    persist();
  };
  const setTempo = (v: number) => {
    cs.tempo = Math.max(40, Math.min(200, Math.round(v) || 80));
    renderSettings();
    persist();
  };
  ($('tempo') as HTMLInputElement).onchange = (e) => setTempo(Number((e.target as HTMLInputElement).value));
  $('tempoDown').onclick = () => setTempo(cs.tempo - 5);
  $('tempoUp').onclick = () => setTempo(cs.tempo + 5);
  document.querySelectorAll<HTMLButtonElement>('#meterSeg button').forEach((b) => {
    b.onclick = () => {
      snapshot();
      cs.beatsPerMeasure = Number(b.dataset.v);
      renderAll();
      persist();
    };
  });
  ($('lh') as HTMLSelectElement).onchange = (e) => {
    cs.lhPattern = (e.target as HTMLSelectElement).value as ComposeSong['lhPattern'];
    persist();
  };
  ($('key') as HTMLSelectElement).onchange = (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === 'auto') cs.keyAuto = true;
    else {
      const [t, m] = v.split(':');
      cs.keyAuto = false;
      cs.key = { tonic: Number(t), mode: m as 'major' | 'minor' };
    }
    renderAll();
    if (cur !== null) renderEditor();
    persist();
  };

  $('lyricsDone').onclick = () => {
    const text = ($('lyrics') as HTMLTextAreaElement).value;
    if (!text.trim()) return toast('Hãy gõ lời bài hát trước.');
    snapshot();
    cs.lyricsText = text;
    cs.words = relyric(cs.words, text);
    renderAll();
    persist();
    const first = cs.words.findIndex((w) => !w.done);
    if (first >= 0) openEditor(first);
  };
  $('btnEditLyrics').onclick = () => {
    closeEditor();
    ($('lyrics') as HTMLTextAreaElement).value = cs.lyricsText || cs.words.map((w) => w.text + (w.br ? '\n' : ' ')).join('').trim();
    $('songView').hidden = true;
    $('lyricsEdit').hidden = false;
    $('lyricsCancel').hidden = false;
  };
  $('lyricsCancel').onclick = () => renderAll();
  $('btnSuggest').onclick = () => {
    if (!cs.words.some((w) => w.midi !== null && w.done)) return toast('Viết nốt cho vài chữ trước, rồi app mới gợi ý hợp âm được.');
    if (cs.words.some((w) => w.chord) && !confirm('Thay các hợp âm hiện có bằng hợp âm gợi ý?')) return;
    snapshot();
    cs.words = suggestChords(cs);
    renderAll();
    persist();
    toast('Đã gợi ý hợp âm. Bấm vào chữ để đổi nếu muốn.');
  };

  // theo câu / hợp âm
  $('lmCopyFrom').onclick = () => openCopy('from');
  $('lmCopyTo').onclick = () => openCopy('to');
  $('lmClearChords').onclick = () => {
    ($('lineMenu') as HTMLDialogElement).close();
    clearChords(menuLine);
  };
  $('lmClearNotes').onclick = () => {
    ($('lineMenu') as HTMLDialogElement).close();
    clearNotes(menuLine);
  };
  $('lmClearAllChords').onclick = () => {
    ($('lineMenu') as HTMLDialogElement).close();
    clearChords(null);
  };
  $('cqDelete').onclick = () => {
    if (quickTarget !== null) setWordChord(quickTarget, null);
    ($('chordQuick') as HTMLDialogElement).close();
    toast('Đã xóa hợp âm.');
  };
  ($('chordQuick') as HTMLDialogElement).addEventListener('close', () => (quickTarget = null));

  // tra vần
  $('rhymeFromLyrics').onclick = () => {
    const ta = $('lyrics') as HTMLTextAreaElement;
    lyricsCaret = { start: ta.selectionStart, end: ta.selectionEnd };
    // đang bôi đen một chữ: chèn chữ gợi ý sẽ thay chữ đó; còn không thì chèn tại con trỏ
    if (lyricsCaret.end === lyricsCaret.start) lyricsCaret = { start: ta.selectionStart, end: ta.selectionStart };
    void openRhyme(wordAtCaret());
  };
  $('rhymeFromSong').onclick = () => {
    const last = cs.words.length ? cs.words[cs.words.length - 1].text : '';
    void openRhyme(last);
  };
  $('edRhyme').onclick = () => cur !== null && void openRhyme(cs.words[cur].text);
  $('rhymeGo').onclick = () => void showRhymes(($('rhymeInput') as HTMLInputElement).value);
  ($('rhymeInput') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void showRhymes((e.target as HTMLInputElement).value);
    }
  });
  document.querySelectorAll<HTMLButtonElement>('#rhymeMode button').forEach((b) => {
    b.onclick = () => {
      rhymeSameTone = b.dataset.v === 'same';
      document.querySelectorAll('#rhymeMode button').forEach((x) => x.classList.toggle('on', x === b));
      const v = ($('rhymeInput') as HTMLInputElement).value;
      if (v.trim()) void showRhymes(v);
    };
  });

  // bảng chọn nốt
  $('edOk').onclick = okNext;
  $('edPrev').onclick = () => go(-1);
  $('edNext').onclick = () => go(1);
  $('edClose').onclick = () => closeEditor();
  $('edListen').onclick = preview;
  $('edLine').onclick = () => {
    if (cur === null) return;
    const n = lineOfWord(cur);
    playingLine === n ? stopPlay() : void playLine(n);
  };
  $('edClear').onclick = () => {
    if (!draft) return;
    draft.midi = null;
    dirty = true;
    renderEditor();
    renderLines();
  };
  $('octDown').onclick = () => draft && setDraftMidi((draft.midi ?? 60) - 12);
  $('octUp').onclick = () => draft && setDraftMidi((draft.midi ?? 60) + 12);
  $('chordOk').onclick = () => {
    const c = parseChordName(($('chordInput') as HTMLInputElement).value);
    if (!c) return toast('Không hiểu tên hợp âm. Ví dụ: C, Am, F#m, Bb, G7, Bdim.');
    ($('chordDialog') as HTMLDialogElement).close();
    if (quickTarget !== null) {
      setWordChord(quickTarget, c);
      ($('chordQuick') as HTMLDialogElement).close();
    } else setDraftChord(c);
  };

  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (cur === null || !draft) {
      if (e.key === ' ') {
        e.preventDefault();
        playing ? stopPlay() : void play();
      }
      return;
    }
    const map: Record<string, () => void> = {
      ArrowUp: () => setDraftMidi((draft!.midi ?? 60) + 1),
      ArrowDown: () => setDraftMidi((draft!.midi ?? 60) - 1),
      ArrowLeft: () => go(-1),
      ArrowRight: () => go(1),
      Enter: okNext,
      Escape: () => closeEditor(),
    };
    if (map[e.key]) {
      e.preventDefault();
      map[e.key]();
    }
  });

  // nghe thử
  $('btnPlay').onclick = () => (playing ? stopPlay() : void play());
  $('btnSheet').onclick = openSheet;
  $('btnUndo').onclick = undo;

  // menu
  $('btnMenu').onclick = () => ($('menuDialog') as HTMLDialogElement).showModal();
  $('menuDialog').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button');
    const act = t?.dataset.act;
    if (!act) return;
    ($('menuDialog') as HTMLDialogElement).close();
    if (act === 'clearChords') clearChords(null);
    else if (act === 'new') newSongAction();
    else if (act === 'open') openSongs();
    else if (act === 'sheet') void openSheet();
    else if (act === 'midi' && hasMusic()) download(midiBytes(), 'audio/midi', `${safeName()}.mid`);
    else if (act === 'xml' && hasMusic()) {
      const { song, chords } = toSong(cs);
      download(songToMusicXml(song, chords), 'application/vnd.recordare.musicxml+xml', `${safeName()}.musicxml`);
    } else if (act === 'share' && hasMusic()) {
      const f = new File([midiBytes()], `${safeName()}.mid`, { type: 'audio/midi' });
      navigator.share({ files: [f], title: cs.title }).catch(() => undefined);
    }
  });
  const probe = new File([new Uint8Array(1)], 'a.mid', { type: 'audio/midi' });
  $('menuShare').hidden = !navigator.canShare?.({ files: [probe] });
  $('sheetPdf').onclick = () => window.print();
  $('sheetMidi').onclick = () => hasMusic() && download(midiBytes(), 'audio/midi', `${safeName()}.mid`);
}

// ---------- khởi động ----------
bind();
buildKeyboard();
$('appVersion').textContent = `v${APP_VERSION}`;
$('menuVersion').textContent = `v${APP_VERSION}`;
setupInstall(
  [$('btnInstall')],
  () => ($('iosDialog') as HTMLDialogElement).showModal(),
  () => toast('Đã cài app ra màn hình chính 🎉'),
);
setupUpdates({
  canReloadNow: () => true,
  beforeReload: () => {
    if (cur !== null && dirty) commitDraft(false);
    cs.updated = Date.now();
    saveSong(cs);
  },
});
renderAll();
