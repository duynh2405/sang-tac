import './styles.css';
import { TPB } from './model';
import { chordName, chordPcs, diatonicChords, keyName, midiName, parseChordName, solfegeName, mod12 } from './music/theory';
import { songToMusicXml } from './music/musicxml';
import { songToMidi } from './music/midi';
import { checkTones, splitSyllables } from './lyrics/vietnamese';
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
  wordLen,
  sungLen,
  lastMidi,
  type ComposeSong,
  type SlurNote,
  type WordChord,
} from './compose';
import { listSongs, saveSong, deleteSong } from './storage';
import { APP_VERSION, setupInstall, setupUpdates } from './pwa';
import './fonts';
import { decodeSong, pack, sharedCodeInUrl, shareLink, unpack } from './share';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Phần nặng (tiếng piano, vẽ sheet) chỉ tải khi cần
type PlayerMod = typeof import('./ui/player');
let playerMod: PlayerMod | null = null;
const getPlayer = async () => (playerMod ??= await import('./ui/player'));

// ---------- trạng thái ----------
let cs: ComposeSong = listSongs()[0] ?? demoCompose();
let cur: number | null = null; // chữ đang chọn
let draft: { midi: number | null; dur: number; rest: number; chord: WordChord | null; slur: SlurNote[] } | null = null;
/** Nốt đang sửa trong chữ: 0 = nốt chính, 1–2 = nốt luyến. */
let sub = 0;
const activeMidi = () => (!draft ? null : sub > 0 ? (draft.slur[sub - 1]?.midi ?? null) : draft.midi);
const activeDur = () => (!draft ? 0 : sub > 0 ? (draft.slur[sub - 1]?.dur ?? 0) : draft.dur);
let dirty = false;
let playing = false;
let playingLine: number | null = null; // câu đang phát (null = cả bài)
let playingFrom: number | null = null; // đang phát từ câu này đến hết bài
let paused = false;
const SVG_PLAY = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
const SVG_PAUSE =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="6.5" y="5.5" width="4" height="13" rx="1.2" fill="currentColor"/><rect x="13.5" y="5.5" width="4" height="13" rx="1.2" fill="currentColor"/></svg>';
const SVG_STOP = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
const ICON_FROM = '<svg viewBox="0 0 22 14" width="20" height="13" aria-hidden="true"><path d="M1 1.5v11l8.5-5.5z" fill="currentColor"/><path d="M16 1.5v9.5M12.6 7.8 16 11.4l3.4-3.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 22 14" width="20" height="13" aria-hidden="true"><rect x="6" y="2" width="10" height="10" rx="1.5" fill="currentColor"/></svg>';
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
  const whole = Math.floor(t / TPB);
  const frac = ['', '¼', '½', '¾'][t % TPB];
  return whole === 0 ? frac || '0' : `${whole}${frac}`;
};

// ---------- lưu ----------
let saveTimer: number | null = null;
function setSaveState(kind: 'ok' | 'busy' | 'err') {
  const el = $('saveState');
  el.className = 'save-state' + (kind === 'ok' ? '' : ' ' + kind);
  el.textContent = kind === 'ok' ? '✓ Đã lưu trong máy' : kind === 'busy' ? 'Đang lưu…' : '⚠ Chưa lưu được';
}

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  setSaveState('busy');
  saveTimer = window.setTimeout(() => {
    cs.updated = Date.now();
    if (saveSong(cs)) setSaveState('ok');
    else {
      setSaveState('err');
      toast('Không lưu được trên trình duyệt này. Hãy dùng ☰ → Lưu bài ra file.');
    }
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
  const warnWords = new Set(checkTones(song.notes).map((w) => song.notes[w.noteIndex].word));

  // đường nét giai điệu: khoảng cao độ của từng câu
  const lineOfW: number[] = [];
  const span: { lo: number; hi: number }[] = [];
  lineRanges().forEach((r, n) => {
    let lo = 127;
    let hi = 0;
    for (let i = r.first; i <= r.last; i++) {
      lineOfW[i] = n;
      const w = i === cur && draft ? { ...cs.words[i], ...draft, done: true } : cs.words[i];
      if (w.midi !== null && (w.done || i === cur)) {
        for (const m of [w.midi, ...(w.slur ?? []).map((x) => x.midi)]) {
          lo = Math.min(lo, m);
          hi = Math.max(hi, m);
        }
      }
    }
    // tối thiểu một quãng 7 để giai điệu ít biến động không bị phóng đại
    if (hi - lo < 7) {
      const mid = (hi + lo) / 2;
      lo = mid - 3.5;
      hi = mid + 3.5;
    }
    span[n] = { lo, hi };
  });

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
    const fb = document.createElement('button');
    fb.className = 'lf' + (playingFrom === n ? ' on' : '');
    fb.title = n === playingFrom ? 'Dừng' : `Nghe từ câu ${n + 1} đến hết bài`;
    fb.setAttribute('aria-label', fb.title);
    fb.innerHTML = playingFrom === n ? ICON_STOP : ICON_FROM;
    fb.onclick = () => (playingFrom === n ? stopPlay() : void playFrom(n));
    const mb = document.createElement('button');
    mb.className = 'lm';
    mb.textContent = '⋯';
    mb.title = `Tùy chọn câu ${n + 1}: chép nốt, xóa hợp âm`;
    mb.setAttribute('aria-label', mb.title);
    mb.onclick = () => openLineMenu(n);
    const ctl = document.createElement('div');
    ctl.className = 'lctl';
    ctl.append(fb, pb, mb);
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
        ? `${[shown.midi, ...(shown.slur ?? []).map((x) => x.midi)].map(solfegeName).join('⌒')} · ${beatsLabel(sungLen(shown))}${
            shown.rest ? ` +${beatsLabel(shown.rest)}` : ''
          }`
        : w.done
          ? `lặng · ${beatsLabel(shown.dur)}`
          : '';
    const pc = document.createElement('span');
    pc.className = 'pc';
    if (shown.midi !== null && (w.done || i === cur)) {
      const sp = span[lineOfW[i]];
      const seq = [{ midi: shown.midi, dur: shown.dur }, ...(shown.slur ?? [])];
      // cùng một thước đo cho mọi chữ: độ dài vạch tỉ lệ với độ dài nốt
      let acc = 0;
      seq.forEach((x, k) => {
        const pd = document.createElement('i');
        pd.className = 'pd';
        pd.style.setProperty('--y', String(1 - (x.midi - sp.lo) / (sp.hi - sp.lo)));
        // 1 phách = 12px, tối thiểu 7px; nốt luyến nối tiếp, cách nhau 3px
        const wpx = Math.max(7, x.dur * 3);
        pd.style.width = `${wpx}px`;
        pd.style.left = `${6 + acc}px`;
        acc += wpx + 3;
        if (i === cur && k === sub) pd.classList.add('act');
        pc.append(pd);
      });
      if (seq.length > 1) b.classList.add('melisma');
    }
    if (i === justDone) b.classList.add('just');
    b.append(ch, pc, tx, nt);
    b.onclick = () => openEditor(i);
    line.append(b);
    if (w.br) {
      box.append(line);
      lineNo++;
      line = newLine();
    }
  });
  if (line.childElementCount > 1) box.append(line);
  // nút sửa lời ở cuối mỗi câu
  box.querySelectorAll<HTMLElement>('.line').forEach((l) => {
    const n = Number(l.dataset.line);
    const eb = document.createElement('button');
    eb.className = 'le';
    eb.innerHTML = '✎';
    eb.title = `Sửa lời câu ${n + 1}`;
    eb.setAttribute('aria-label', eb.title);
    eb.onclick = () => openLineEdit(n);
    l.append(eb);
  });

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
  t.classList.remove('out');
  t.hidden = false;
  clearTimeout((toast as any)._t);
  clearTimeout((toast as any)._o);
  (toast as any)._o = setTimeout(() => t.classList.add('out'), ms - 260);
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
    k.onclick = () => {
      navigator.vibrate?.(8);
      setDraftMidi(m);
    };
    kb.append(k);
  }
  kb.style.width = `${whiteIndex * 40}px`;
}

function highlightKey(scroll: boolean) {
  const m = activeMidi();
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
  endWordEdit();
  stopPlay();
  cur = i;
  const w = cs.words[i];
  const key = currentKey();
  draft = {
    midi: w.done ? w.midi : defaultMidi(cs.words, i, key),
    dur: w.done ? w.dur : defaultDur(cs.words, i),
    rest: w.rest,
    chord: w.chord,
    slur: w.done && w.midi !== null ? (w.slur ?? []).map((x) => ({ ...x })) : [],
  };
  sub = 0;
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
  const am = activeMidi();
  $('edNote').innerHTML =
    am === null ? 'Lặng <small>(không hát)</small>' : `${solfegeName(am)} <small>${midiName(am, key)}</small>`;
  highlightKey(scrollKeys);
  renderSlurTabs();

  const dur = $('durChips');
  dur.innerHTML = '';
  for (const [t, name, frac] of DURS) {
    const b = document.createElement('button');
    b.className = t === activeDur() ? 'on' : '';
    b.innerHTML = `${name}<small>${frac}</small>`;
    b.onclick = () => {
      if (sub > 0) draft!.slur[sub - 1].dur = t;
      else draft!.dur = t;
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
        { start: 0, dur: 4, midi: lastMidi(a)!, lyric: a.text },
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
  const v = Math.max(KB_LO - 12, Math.min(KB_HI + 12, m));
  if (sub > 0 && draft.slur[sub - 1]) draft.slur[sub - 1].midi = v;
  else draft.midi = v;
  dirty = true;
  renderEditor();
  renderLines();
  preview();
}

/** Hàng chọn nốt trong chữ: Nốt 1 (chính), Nốt 2–3 (luyến), nút thêm luyến. */
function renderSlurTabs() {
  const row = $('slurRow');
  const box = $('slurTabs');
  box.innerHTML = '';
  if (!draft || draft.midi === null) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  const seq = [{ midi: draft.midi, dur: draft.dur }, ...draft.slur];
  seq.forEach((x, k) => {
    const b = document.createElement('button');
    b.className = 'st' + (k === sub ? ' on' : '');
    b.innerHTML = `<small>Nốt ${k + 1}</small>${solfegeName(x.midi)}`;
    b.onclick = () => {
      sub = k;
      renderEditor(true);
      renderLines();
    };
    box.append(b);
    if (k > 0) {
      const del = document.createElement('button');
      del.className = 'st-del';
      del.textContent = '✕';
      del.title = `Bỏ nốt luyến ${k + 1}`;
      del.setAttribute('aria-label', del.title);
      del.onclick = () => {
        draft!.slur.splice(k - 1, 1);
        sub = Math.min(sub, draft!.slur.length);
        dirty = true;
        renderEditor(true);
        renderLines();
        preview();
      };
      box.append(del);
    }
    if (k < seq.length - 1) box.append(Object.assign(document.createElement('span'), { className: 'st-arc', textContent: '⌒' }));
  });
  if (seq.length < 3) {
    const add = document.createElement('button');
    add.className = 'st-add';
    add.textContent = seq.length === 1 ? '＋ Luyến thêm nốt' : '＋';
    add.title = 'Thêm một nốt hát luyến trên cùng chữ này';
    add.onclick = () => {
      const last = seq[seq.length - 1];
      // nốt luyến mới: cao hơn một bậc (2 nửa cung), dài nửa phách
      draft!.slur.push({ midi: last.midi + 2, dur: Math.max(1, Math.min(last.dur, 2)) });
      sub = draft!.slur.length;
      dirty = true;
      renderEditor(true);
      renderLines();
      preview();
    };
    box.append(add);
  }
}

// ---------- sửa lời từng câu ----------
let editLine = 0;
/** null = đang sửa câu; còn không: thêm câu mới phía trên/dưới câu editLine */
let insertWhere: 'above' | 'below' | null = null;

function openLineEdit(n: number) {
  closeEditor();
  stopPlay();
  const r = lineRanges()[n];
  if (!r) return;
  editLine = n;
  insertWhere = null;
  $('leTitle').textContent = `Sửa lời câu ${n + 1}`;
  $('leHint').textContent =
    'Chữ nào giữ nguyên thì giữ nốt và hợp âm. Chữ mới thêm sẽ chưa có nốt. Xuống dòng để tách thành nhiều câu.';
  $('leDelete').hidden = false;
  $('leSave').textContent = 'Lưu';
  const ta = $('leText') as HTMLTextAreaElement;
  ta.value = cs.words.slice(r.first, r.last + 1).map((w) => w.text).join(' ');
  ($('lineEditDialog') as HTMLDialogElement).showModal();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function openLineInsert(n: number, where: 'above' | 'below') {
  closeEditor();
  stopPlay();
  if (!lineRanges()[n]) return;
  editLine = n;
  insertWhere = where;
  $('leTitle').textContent = where === 'above' ? `Thêm câu mới trước câu ${n + 1}` : `Thêm câu mới sau câu ${n + 1}`;
  $('leHint').textContent = 'Gõ lời câu mới. Xuống dòng để thêm nhiều câu một lúc. Câu mới chưa có nốt.';
  $('leDelete').hidden = true;
  $('leSave').textContent = 'Thêm';
  const ta = $('leText') as HTMLTextAreaElement;
  ta.value = '';
  ($('lineEditDialog') as HTMLDialogElement).showModal();
  ta.focus();
}

function saveLineInsert() {
  const rs = lineRanges();
  const r = rs[editLine];
  if (!r || !insertWhere) return;
  const fresh = relyric([], ($('leText') as HTMLTextAreaElement).value);
  if (!fresh.length) return toast('Hãy gõ lời cho câu mới.');
  const blanks = blankLinesMap();
  snapshot();
  const at = insertWhere === 'above' ? r.first : r.last + 1;
  const atEnd = at >= cs.words.length;
  if (atEnd) cs.words[cs.words.length - 1].br = true; // câu cuối giờ phải xuống dòng
  fresh[fresh.length - 1].br = !atEnd;
  cs.words.splice(at, 0, ...fresh);
  const m = new Map<number, number>();
  blanks.forEach((v, k) => m.set(k >= at ? k + fresh.length : k, v));
  rebuildLyrics(m);
  persist();
  ($('lineEditDialog') as HTMLDialogElement).close();
  const nLines = fresh.filter((w) => w.br).length + (atEnd ? 1 : 0);
  toast(`Đã thêm ${nLines > 1 ? nLines + ' câu' : 'câu'} mới. Chọn nốt cho chữ đầu tiên nhé.`, 4000);
  openEditor(at);
}

function saveLineEdit() {
  if (insertWhere) return saveLineInsert();
  const r = lineRanges()[editLine];
  if (!r) return;
  const text = ($('leText') as HTMLTextAreaElement).value;
  const old = cs.words.slice(r.first, r.last + 1);
  const lastBr = old[old.length - 1].br;
  const fresh = relyric(old, text);
  const changed =
    fresh.length !== old.length || fresh.some((w, k) => w.text !== old[k].text || (k < fresh.length - 1 && w.br));
  if (!changed) {
    ($('lineEditDialog') as HTMLDialogElement).close();
    return;
  }
  if (!fresh.length) {
    if (cs.words.length === old.length) return toast('Bài phải còn ít nhất một câu.');
    if (!confirm(`Xóa cả câu ${editLine + 1} khỏi bài? (có thể bấm ↶ để hoàn tác)`)) return;
  }
  const blanks = blankLinesMap();
  snapshot();
  if (fresh.length) fresh[fresh.length - 1].br = lastBr;
  // câu cuối bị xóa: câu trước thành câu cuối
  if (!fresh.length && !lastBr && r.first > 0) cs.words[r.first - 1].br = false;
  cs.words.splice(r.first, old.length, ...fresh);
  const d = fresh.length - old.length;
  const m = new Map<number, number>();
  blanks.forEach((v, k) => {
    if (k < r.first) m.set(k, v);
    else if (k >= r.last) m.set(Math.max(r.first - 1, k + d), v);
  });
  rebuildLyrics(m);
  persist();
  ($('lineEditDialog') as HTMLDialogElement).close();
  renderLines();
  const added = fresh.filter((w) => !w.done).length - old.filter((w) => !w.done).length;
  toast(
    !fresh.length
      ? `Đã xóa câu ${editLine + 1}.`
      : added > 0
        ? `Đã sửa lời câu ${editLine + 1}. Có ${added} chữ mới chưa có nốt.`
        : `Đã sửa lời câu ${editLine + 1}.`,
    4000,
  );
}

// ---------- sửa chữ ngay trong bảng chọn nốt ----------
function startWordEdit() {
  if (cur === null) return;
  const inp = $('edWordInput') as HTMLInputElement;
  inp.value = cs.words[cur].text;
  $('edWordBtn').hidden = true;
  $('edWordForm').hidden = false;
  inp.focus();
  inp.select();
}

function endWordEdit() {
  $('edWordBtn').hidden = false;
  $('edWordForm').hidden = true;
}

/** Viết lại lời từ danh sách chữ, giữ các dòng trống (ngắt đoạn) như cũ. */
function rebuildLyrics(blankAfter: Map<number, number>) {
  let out = '';
  cs.words.forEach((w, i) => {
    out += w.text;
    if (w.br) out += '\n' + '\n'.repeat(blankAfter.get(i) ?? 0);
    else if (i < cs.words.length - 1) out += ' ';
  });
  cs.lyricsText = out;
}

/** Vị trí các dòng trống trong lời hiện tại: chữ cuối dòng -> số dòng trống theo sau. */
function blankLinesMap(): Map<number, number> {
  const m = new Map<number, number>();
  let count = 0;
  let lastWord = -1;
  for (const line of cs.lyricsText.split(/\r?\n/)) {
    const n = splitSyllables(line).length;
    if (n === 0) {
      if (lastWord >= 0) m.set(lastWord, (m.get(lastWord) ?? 0) + 1);
    } else {
      count += n;
      lastWord = count - 1;
    }
  }
  return m;
}

function applyWordEdit(value: string) {
  if (cur === null) return;
  const i = cur;
  const old = cs.words[i];
  const toks = splitSyllables(value);
  if (toks.length === 1 && toks[0] === old.text) return endWordEdit();
  if (!toks.length && cs.words.length === 1) return toast('Bài phải còn ít nhất một chữ.');
  if (!toks.length && !confirm(`Xóa chữ «${old.text}» khỏi lời? (có thể bấm ↶ để hoàn tác)`)) return;
  if (dirty) commitDraft(false);
  const blanks = blankLinesMap();
  snapshot();
  // dời vị trí dòng trống theo số chữ thêm (d > 0) hoặc bớt (d = -1) tại chữ i
  const shift = (d: number) => {
    const m = new Map<number, number>();
    blanks.forEach((v, k) => m.set(k >= i ? Math.max(0, k + d) : k, v));
    return m;
  };
  if (!toks.length) {
    // xóa chữ: chuyển xuống dòng và hợp âm sang chữ bên cạnh
    const prev = cs.words[i - 1];
    const next = cs.words[i + 1];
    if (old.br && prev) prev.br = true;
    if (old.chord && next && !next.chord) next.chord = old.chord;
    cs.words.splice(i, 1);
    rebuildLyrics(shift(-1));
    persist();
    endWordEdit();
    toast(`Đã xóa chữ «${old.text}».`);
    if (!cs.words.length) return closeEditor(false);
    const ni = Math.min(i, cs.words.length - 1);
    cur = null;
    openEditor(ni);
    return;
  }
  const extra = toks.slice(1).map((t) => ({ text: t, midi: null, dur: TPB, rest: 0, chord: null, br: false, done: false }));
  cs.words[i] = { ...old, text: toks[0], br: extra.length ? false : old.br };
  if (extra.length) extra[extra.length - 1].br = old.br;
  cs.words.splice(i + 1, 0, ...extra);
  rebuildLyrics(shift(extra.length));
  persist();
  endWordEdit();
  if (draft) dirty = false;
  renderEditor();
  renderLines();
  if (extra.length) toast(`Đã thêm ${extra.length} chữ mới sau «${toks[0]}». Chọn nốt cho chúng bằng nút ▶.`, 4500);
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
  const tickSec = 60 / cs.tempo / TPB;
  if (draft.midi !== null && draft.slur.length) {
    const seq = [{ midi: draft.midi, dur: draft.dur }, ...draft.slur].map((x) => ({ midi: x.midi, secs: Math.max(0.18, x.dur * tickSec) }));
    void getPlayer().then((p) => p.previewSeq(seq, lh));
    return;
  }
  const secs = Math.min(1.6, draft.dur * tickSec);
  void getPlayer().then((p) => p.previewWord(draft?.midi ?? null, lh, Math.max(0.3, secs)));
}

let justDone: number | null = null;

function commitDraft(markDone = true) {
  if (cur === null || !draft) return;
  snapshot();
  if (markDone) {
    justDone = cur;
    setTimeout(() => (justDone = null), 50);
  }
  const w = cs.words[cur];
  const { slur, ...rest } = draft;
  const nw = { ...w, ...rest, done: markDone ? true : w.done || dirty };
  if (slur.length && rest.midi !== null) nw.slur = slur.map((x) => ({ ...x }));
  else delete nw.slur;
  cs.words[cur] = nw;
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
  const b = $('btnPlay');
  b.classList.toggle('on', on && !paused);
  b.classList.toggle('paused', on && paused);
  b.innerHTML = on && !paused ? SVG_PAUSE : SVG_PLAY;
  b.setAttribute('aria-label', on && !paused ? 'Tạm dừng' : paused ? 'Phát tiếp' : 'Phát');
  b.title = b.getAttribute('aria-label')!;
  ($('btnStop') as HTMLButtonElement).disabled = !on;
  document.querySelector('.ptitle')!.textContent = !on
    ? 'Nghe thử'
    : paused
      ? 'Tạm dừng'
      : playingLine !== null
        ? `Câu ${playingLine + 1}`
        : playingFrom !== null
          ? `Từ câu ${playingFrom + 1}`
          : 'Cả bài';
}

/** Nút phát lớn: chưa phát -> phát cả bài; đang phát -> tạm dừng; đang dừng -> phát tiếp. */
function togglePlayPause() {
  if (!playing) return void play();
  if (paused) {
    paused = false;
    playerMod?.resume();
  } else {
    paused = true;
    playerMod?.pause();
  }
  setPlayUi(true);
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
  await play({ from: starts[r.first], to: starts[r.last] + wordLen(last), line: n });
}

/** Nghe từ đầu câu n đến hết bài. */
async function playFrom(n: number) {
  const r = lineRanges()[n];
  if (!r) return;
  await play({ from: wordStarts(cs.words)[r.first], to: Infinity, fromLine: n });
}

async function play(range?: { from: number; to: number; line?: number; fromLine?: number }) {
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
  if (!hasNotes)
    return toast(
      range?.line !== undefined
        ? 'Câu này chưa có nốt nào.'
        : range
          ? 'Từ câu này trở đi chưa có nốt nào.'
          : 'Chưa có nốt nào. Bấm vào một chữ để bắt đầu.',
    );
  // cắt hợp âm theo đoạn được phát để tay trái vào đúng từ đầu câu
  const chords = allChords
    .filter((c) => c.start < to && c.start + c.dur > from)
    .map((c) => {
      const s = Math.max(c.start, from);
      return { ...c, start: s, dur: Math.min(c.start + c.dur, to) - s };
    });
  playing = true;
  paused = false;
  playingLine = range?.line ?? null;
  playingFrom = range?.fromLine ?? null;
  setPlayUi(true);
  renderLines();
  const p = await getPlayer();
  await p.play(song, chords, {
    melody: true,
    accompaniment: ($('playAcc') as HTMLInputElement).checked,
    fromTick: from,
    toTick: range && isFinite(to) ? to : undefined,
    onEnd: stopPlay,
  });
  const starts = wordStarts(cs.words);
  const total = Math.max(1, (isFinite(to) ? to : totalTicks(cs.words)) - from);
  let lastWi = -1;
  const tick = () => {
    if (!playing) return;
    const sec = p.position();
    const rel = sec < 0 ? 0 : (sec * cs.tempo * TPB) / 60;
    const t = from + rel;
    ($('pfill') as HTMLElement).style.width = `${Math.min(100, (rel / total) * 100)}%`;
    const wi = starts.findIndex((s, i) => t >= s && t < s + wordLen(cs.words[i]));
    if (wi !== lastWi) {
      lastWi = wi;
      document.querySelectorAll('.w.playing').forEach((e) => e.classList.remove('playing'));
      const el = wi >= 0 ? document.querySelector<HTMLElement>(`.w[data-i="${wi}"]`) : null;
      if (el) {
        el.classList.add('playing');
        // phát nhiều câu: tô câu đang hát và cuộn theo
        if (playingLine === null && cur === null) {
          const ln = el.closest('.line');
          document.querySelectorAll('.line.follow').forEach((x) => x !== ln && x.classList.remove('follow'));
          ln?.classList.add('follow');
          const rc = el.getBoundingClientRect();
          const bar = $('playerbar')?.getBoundingClientRect().top ?? innerHeight;
          if (rc.top < 120 || rc.bottom > bar - 40) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stopPlay() {
  const wasLine = playingLine !== null || playingFrom !== null;
  playing = false;
  paused = false;
  playingLine = null;
  playingFrom = null;
  document.querySelectorAll('.line.follow').forEach((x) => x.classList.remove('follow'));
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
    if (s.slur?.length) d.slur = s.slur.map((x) => ({ ...x }));
    else delete d.slur;
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
    delete w.slur;
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

// ---------- lưu / mở file bài ----------
async function saveToFile() {
  if (cur !== null && dirty) commitDraft(false);
  const data = JSON.stringify({ app: 'sang-tac', ...pack(cs) });
  const name = `${safeName()}.sangtac`;
  // Máy tính (Chrome/Edge): cho chọn nơi lưu
  const picker = (window as any).showSaveFilePicker;
  if (picker) {
    try {
      const h = await picker({ suggestedName: name, types: [{ description: 'Bài Sáng tác', accept: { 'application/octet-stream': ['.sangtac'] } }] });
      const w = await h.createWritable();
      await w.write(data);
      await w.close();
      toast(`Đã lưu «${h.name}».`);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') toast('Không lưu được file. Hãy thử lại.');
    }
    return;
  }
  // Điện thoại: trình duyệt tự lưu vào thư mục Tải xuống, không hỏi nơi lưu
  download(data, 'application/octet-stream', name);
  toast(`Đã lưu «${name}» vào thư mục Tải xuống (Download) của máy. Mở lại bằng ☰ → Mở file bài.`, 6000);
}

async function openFromFile(f: File) {
  try {
    const o = JSON.parse(await f.text());
    const got = unpack(o);
    if (cur !== null && dirty) commitDraft(false);
    saveSong(cs);
    cs = got;
    saveSong(cs);
    undoStack.length = 0;
    closeEditor(false);
    renderAll();
    toast(`Đã mở bài «${got.title}» (lưu thành một bài riêng trong máy).`, 4500);
  } catch {
    toast('File này không phải file bài của app Sáng tác.', 4500);
  }
}

// ---------- gửi bài qua link ----------
async function openLinkDialog() {
  if (cur !== null && dirty) commitDraft(false);
  if (!cs.words.length && !cs.lyricsText.trim()) return toast('Bài còn trống, hãy viết lời trước đã.');
  let url = '';
  try {
    url = await shareLink(cs);
  } catch {
    return toast('Không tạo được link trên trình duyệt này.');
  }
  ($('linkText') as HTMLInputElement).value = url;
  const text = `Mời bạn xem và sửa bài «${cs.title}» của mình trên app Sáng tác:`;
  $('linkShare').hidden = !navigator.share;
  $('linkShare').onclick = () => navigator.share({ title: cs.title, text, url }).catch(() => undefined);
  $('linkCopy').onclick = () => {
    const done = () => toast('Đã sao chép link. Dán vào Zalo, Messenger… để gửi.');
    navigator.clipboard?.writeText(url).then(done, () => {
      ($('linkText') as HTMLInputElement).select();
      document.execCommand('copy');
      done();
    }) ?? (($('linkText') as HTMLInputElement).select(), document.execCommand('copy'), done());
  };
  ($('linkDialog') as HTMLDialogElement).showModal();
}

/** Mở bài từ link bạn bè gửi: luôn tạo bản sao riêng trên máy này. */
async function importFromUrl() {
  const code = sharedCodeInUrl();
  if (!code) return;
  history.replaceState(null, '', location.pathname + location.search);
  const key = code.slice(0, 64) + code.length;
  const existing = listSongs().find((s) => s.sharedFrom === key);
  if (existing) {
    saveSong(cs);
    cs = existing;
    undoStack.length = 0;
    renderAll();
    return toast(`Bài «${existing.title}» đã có trong máy, đã mở bản của bạn.`, 4500);
  }
  try {
    const got = await decodeSong(code);
    got.sharedFrom = key;
    saveSong(cs);
    cs = got;
    saveSong(cs);
    undoStack.length = 0;
    renderAll();
    toast(`Đã nhận bài «${got.title}». Đây là bản của riêng bạn, cứ sửa thoải mái.`, 5000);
  } catch {
    toast('Link bài hát bị lỗi hoặc bị cắt mất một phần.', 5000);
  }
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
  const lineOpen = ($('lineEditDialog') as HTMLDialogElement).open;
  const editing = lineOpen || !$('lyricsEdit').hidden;
  if (editing && lyricsCaret) {
    const ta = $(lineOpen ? 'leText' : 'lyrics') as HTMLTextAreaElement;
    const v = ta.value;
    const before = v.slice(0, lyricsCaret.start);
    const after = v.slice(lyricsCaret.end);
    const pre = before && !/\s$/.test(before) ? ' ' : '';
    const post = after && !/^\s/.test(after) ? ' ' : '';
    ta.value = before + pre + text + post + after;
    const pos = before.length + pre.length + text.length + post.length;
    lyricsCaret = { start: pos, end: pos };
    ta.setSelectionRange(pos, pos);
    if (!lineOpen) {
      cs.lyricsText = ta.value;
      persist();
    }
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

  ($('fileInput') as HTMLInputElement).onchange = (e) => {
    const inp = e.target as HTMLInputElement;
    const f = inp.files?.[0];
    inp.value = '';
    if (f) void openFromFile(f);
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

  // sửa lời từng câu
  $('lmEditLine').onclick = () => {
    ($('lineMenu') as HTMLDialogElement).close();
    openLineEdit(menuLine);
  };
  $('leSave').onclick = saveLineEdit;
  $('lmAddAbove').onclick = () => {
    ($('lineMenu') as HTMLDialogElement).close();
    openLineInsert(menuLine, 'above');
  };
  $('lmAddBelow').onclick = () => {
    ($('lineMenu') as HTMLDialogElement).close();
    openLineInsert(menuLine, 'below');
  };
  $('leDelete').onclick = () => {
    const ta = $('leText') as HTMLTextAreaElement;
    const keep = ta.value;
    ta.value = '';
    saveLineEdit();
    // người dùng bấm "Hủy" ở hộp xác nhận: trả lại lời như cũ
    if (($('lineEditDialog') as HTMLDialogElement).open) ta.value = keep;
  };
  $('leText').addEventListener('keydown', (e) => {
    const k = e as KeyboardEvent;
    if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) {
      e.preventDefault();
      saveLineEdit();
    }
  });
  $('leRhyme').onclick = () => {
    const ta = $('leText') as HTMLTextAreaElement;
    lyricsCaret = { start: ta.selectionStart, end: ta.selectionStart };
    const before = ta.value.slice(0, ta.selectionStart).match(/([\p{L}]+)[^\p{L}]*$/u);
    void openRhyme(before ? before[1] : '');
  };

  // sửa chữ trong bảng chọn nốt
  $('edWordBtn').onclick = startWordEdit;
  $('edWordCancel').onclick = endWordEdit;
  $('edWordForm').addEventListener('submit', (e) => {
    e.preventDefault();
    applyWordEdit(($('edWordInput') as HTMLInputElement).value);
  });
  $('edWordInput').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') {
      e.stopPropagation();
      endWordEdit();
    }
  });

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
    draft.slur = [];
    sub = 0;
    dirty = true;
    renderEditor();
    renderLines();
  };
  $('octDown').onclick = () => draft && setDraftMidi((activeMidi() ?? 60) - 12);
  $('octUp').onclick = () => draft && setDraftMidi((activeMidi() ?? 60) + 12);
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
        togglePlayPause();
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
  $('btnPlay').onclick = togglePlayPause;
  $('btnStop').innerHTML = SVG_STOP;
  $('btnStop').onclick = stopPlay;
  setPlayUi(false);
  $('btnSheet').onclick = openSheet;
  $('btnUndo').onclick = undo;

  // menu
  $('btnMenu').onclick = () => ($('menuDialog') as HTMLDialogElement).showModal();
  $('menuDialog').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button');
    const act = t?.dataset.act;
    if (!act) return;
    ($('menuDialog') as HTMLDialogElement).close();
    if (act === 'sendLink') void openLinkDialog();
    else if (act === 'saveFile') void saveToFile();
    else if (act === 'openFile') ($('fileInput') as HTMLInputElement).click();
    else if (act === 'clearChords') clearChords(null);
    else if (act === 'new') newSongAction();
    else if (act === 'open') openSongs();
    else if (act === 'sheet') void openSheet();
    else if (act === 'midi' && hasMusic()) download(midiBytes(), 'audio/midi', `${safeName()}.mid`);

  });
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
void importFromUrl();
window.addEventListener('hashchange', () => void importFromUrl());
