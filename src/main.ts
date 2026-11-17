import './styles.css';
import { TPB, measureTicks, newSong, normalizeNotes, type Chord, type LhPattern, type Note, type Song } from './model';
import { detectKey, diatonicChords, chordName, keyName, midiName, parseChordName } from './music/theory';
import { harmonize, fitChordsToSong } from './music/harmonize';
import { songToMusicXml } from './music/musicxml';
import { songToMidi } from './music/midi';
import { assignLyrics, checkTones, lyricsFromNotes, type ToneWarning } from './lyrics/vietnamese';
import { transcribe } from './lyrics/asr';
import { startRecording, decodeFile, encodeWav, type RecordSession } from './audio/recorder';
import { transcribeMelody } from './pipeline';
import { PianoRoll } from './ui/pianoroll';
import { renderSheet } from './ui/sheet';
import * as player from './ui/player';
import { listSongs, saveSong, deleteSong, saveAudio, loadAudio } from './storage';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- trạng thái ----------
let song: Song = loadLastSong() ?? demoSong();
let audio16k: Float32Array | null = null;
let warnings: ToneWarning[] = [];
const undoStack: string[] = [];
const redoStack: string[] = [];
let recSession: RecordSession | null = null;
let sheetTimer: number | null = null;
let playing = false;

function loadLastSong(): Song | null {
  const all = listSongs();
  return all.length ? all[0] : null;
}

function demoSong(): Song {
  // ví dụ để người mới thấy app làm được gì
  const mel = [64, 67, 69, 67, 64, 62, 60, 62, 64, 67, 64, 62, 60];
  const lyr = 'Em ơi hãy cất tiếng hát cho đời thêm vui mãi mãi'.split(' ');
  const durs = [2, 2, 4, 2, 2, 4, 2, 2, 4, 2, 2, 4, 8];
  let t = 0;
  const notes: Note[] = mel.map((m, i) => {
    const n = { start: t, dur: durs[i], midi: m, lyric: lyr[i] };
    t += durs[i];
    return n;
  });
  return newSong({ title: 'Bài ví dụ', notes, lyricsText: lyr.join(' ') });
}

// ---------- tính toán ----------
function derive() {
  song.notes = song.notes.map((n) => ({ ...n }));
  if (song.keyAuto) song.key = detectKey(song.notes);
  song.chords = song.chordsAuto ? harmonize(song) : fitChordsToSong(song);
  warnings = checkTones(song.notes);
}

function snapshot() {
  undoStack.push(JSON.stringify(song));
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}

function commit(opts: { rederive?: boolean; save?: boolean } = {}) {
  if (opts.rederive !== false) derive();
  render();
  if (opts.save !== false) persist();
}

let saveTimer: number | null = null;
function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    song.updated = Date.now();
    if (!saveSong(song)) toast('Không lưu được trên trình duyệt này (bộ nhớ đầy hoặc bị chặn).');
  }, 400);
}

// ---------- giao diện ----------
const roll = new PianoRoll($('roll'), song, {
  onChange: (notes, done) => {
    if (done) {
      snapshot();
      song.notes = normalizeNotes(notes);
      commit();
    } else {
      song.notes = notes;
      roll.setData(song, song.chords, warnSet());
    }
  },
  onSelect: () => renderInspector(),
  onChordClick: (ci) => openChordDialog(ci),
  onPreview: (m) => void player.previewNote(m),
});

function warnSet(): Set<number> {
  return new Set(warnings.map((w) => w.noteIndex));
}

function render() {
  ($('title') as HTMLInputElement).value = song.title;
  ($('tempo') as HTMLInputElement).value = String(song.tempo);
  ($('meter') as HTMLSelectElement).value = String(song.beatsPerMeasure);
  ($('lh') as HTMLSelectElement).value = song.lhPattern;
  ($('cpm') as HTMLSelectElement).value = String(song.chordsPerMeasure);
  renderKeySelect();
  if (document.activeElement !== $('lyrics')) ($('lyrics') as HTMLTextAreaElement).value = song.lyricsText;
  roll.setData(song, song.chords, warnSet());
  renderInspector();
  renderWarnings();
  ($('btnUndo') as HTMLButtonElement).disabled = undoStack.length === 0;
  ($('btnRedo') as HTMLButtonElement).disabled = redoStack.length === 0;
  ($('btnVoice') as HTMLButtonElement).disabled = !audio16k;
  ($('btnWav') as HTMLButtonElement).disabled = !audio16k;
  scheduleSheet();
}

function renderKeySelect() {
  const sel = $('key') as HTMLSelectElement;
  if (!sel.options.length) {
    const auto = new Option('Tự nhận', 'auto');
    sel.add(auto);
    for (const mode of ['major', 'minor'] as const)
      for (let t = 0; t < 12; t++) sel.add(new Option(keyName({ tonic: t, mode }), `${t}:${mode}`));
  }
  sel.options[0].text = `Tự nhận (${keyName(song.key)})`;
  sel.value = song.keyAuto ? 'auto' : `${song.key.tonic}:${song.key.mode}`;
}

function renderInspector() {
  const i = roll.selected;
  const box = $('inspector');
  if (i === null || !song.notes[i]) {
    box.hidden = true;
    return;
  }
  const n = song.notes[i];
  box.hidden = false;
  const beat = n.start / TPB;
  const m = Math.floor(n.start / measureTicks(song)) + 1;
  $('insName').textContent = `Nốt ${midiName(n.midi, song.key)} · ô nhịp ${m} · phách ${((beat % song.beatsPerMeasure) + 1).toFixed(
    n.start % TPB ? 2 : 0,
  )} · dài ${n.dur / TPB} phách`;
  const inp = $('insLyric') as HTMLInputElement;
  if (document.activeElement !== inp) inp.value = n.lyric ?? '';
}

function renderWarnings() {
  const box = $('toneBox');
  const ul = $('toneList');
  ul.innerHTML = '';
  box.hidden = warnings.length === 0;
  for (const w of warnings) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="sev">[${w.severity}]</span> `;
    li.append(w.message);
    li.onclick = () => {
      roll.selected = w.noteIndex;
      roll.draw();
      renderInspector();
      $('roll').scrollIntoView({ behavior: 'smooth', block: 'center' });
      player.previewNote(song.notes[w.noteIndex].midi);
    };
    ul.append(li);
  }
}

function scheduleSheet() {
  if (sheetTimer) clearTimeout(sheetTimer);
  sheetTimer = window.setTimeout(async () => {
    const el = $('sheet');
    if (song.notes.length === 0) {
      el.innerHTML = '<p class="hint">Hát xong, sheet nhạc sẽ hiện ở đây.</p>';
      return;
    }
    try {
      if (el.querySelector('p.hint')) el.innerHTML = '';
      await renderSheet(el, songToMusicXml(song, song.chords));
    } catch (e) {
      console.error(e);
      el.innerHTML = '<p class="hint">Không vẽ được sheet. Hãy thử chỉnh lại nốt.</p>';
    }
  }, 350);
}

function toast(msg: string, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((toast as any)._t);
  (toast as any)._t = setTimeout(() => (t.hidden = true), ms);
}

function setProgress(id: string, frac: number | null, text?: string) {
  const box = $(id);
  if (frac === null) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  (box.querySelector('div') as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
  if (text) (box.querySelector('span') as HTMLElement).textContent = text;
}

// ---------- thu âm ----------
function renderBeats(active: number | null) {
  const el = $('beats');
  const n = song.beatsPerMeasure;
  if (el.children.length !== n) {
    el.innerHTML = '';
    for (let i = 0; i < n; i++) el.append(document.createElement('span'));
  }
  [...el.children].forEach((c, i) => {
    c.className = active !== null && i === ((active % n) + n) % n ? 'on' + (i === 0 ? ' first' : '') : '';
  });
}

async function toggleRecord() {
  const btn = $('btnRecord');
  if (recSession) {
    const s = recSession;
    recSession = null;
    btn.classList.remove('on');
    $('recLabel').textContent = 'Bấm để thu';
    renderBeats(null);
    ($('level') as HTMLElement).style.width = '0';
    const rec = await s.stop();
    if (rec.samples.length < rec.sampleRate * 0.5) {
      toast('Bản thu quá ngắn, hãy hát lâu hơn một chút.');
      return;
    }
    await analyze(rec);
    return;
  }
  player.stop();
  readSettings();
  try {
    const s = await startRecording({
      tempo: song.tempo,
      beatsPerMeasure: song.beatsPerMeasure,
      countInMeasures: 1,
      metronomeDuringTake: ($('clickDuring') as HTMLInputElement).checked,
    });
    recSession = s;
    btn.classList.add('on');
    $('recLabel').textContent = 'Đang đếm nhịp…';
    s.onTick = (b) => {
      renderBeats(b);
      $('recLabel').textContent = b < 0 ? `Chuẩn bị… ${-b}` : 'Đang thu – bấm để dừng';
    };
    s.onLevel = (rms) => (($('level') as HTMLElement).style.width = `${Math.min(100, rms * 400)}%`);
  } catch (e: any) {
    console.error(e);
    toast(
      e?.name === 'NotAllowedError'
        ? 'Bạn cần cho phép dùng micro (bấm biểu tượng ổ khóa cạnh thanh địa chỉ).'
        : 'Không mở được micro: ' + (e?.message ?? e),
      6000,
    );
  }
}

async function analyze(rec: Parameters<typeof transcribeMelody>[0]) {
  setProgress('anaProgress', 0, 'Đang phân tích giọng hát…');
  try {
    const grid = Number(($('grid') as HTMLSelectElement).value);
    const legato = ($('legato') as HTMLInputElement).checked;
    const res = await transcribeMelody(rec, { tempo: song.tempo, beatsPerMeasure: song.beatsPerMeasure, grid, legato }, (p) =>
      setProgress('anaProgress', p),
    );
    setProgress('anaProgress', null);
    if (res.notes.length === 0) {
      toast('Không nghe thấy giai điệu. Hãy hát to và rõ hơn, gần micro hơn.', 5000);
      return;
    }
    snapshot();
    audio16k = res.audio16k;
    if (song.title === 'Bài ví dụ') {
      // thu đè lên bài ví dụ thì tạo bài mới, giữ các cài đặt
      song = newSong({ tempo: song.tempo, beatsPerMeasure: song.beatsPerMeasure, lhPattern: song.lhPattern, lyricsText: '' });
    }
    song.notes = res.notes;
    song.keyAuto = true;
    song.chordsAuto = true;
    if (song.lyricsText.trim()) song.notes = assignLyrics(song.notes, song.lyricsText).notes;
    roll.selected = null;
    commit();
    void saveAudio(song.id, audio16k);
    toast(`Đã nhận ${res.notes.length} nốt. Bấm ▶ Phát để nghe, kéo nốt để sửa.`);
    $('editCard').scrollIntoView({ behavior: 'smooth' });
  } catch (e: any) {
    console.error(e);
    setProgress('anaProgress', null);
    toast('Lỗi khi phân tích: ' + (e?.message ?? e), 6000);
  }
}

function readSettings() {
  const tempo = Math.max(40, Math.min(200, Number(($('tempo') as HTMLInputElement).value) || 80));
  song.tempo = tempo;
  song.beatsPerMeasure = Number(($('meter') as HTMLSelectElement).value);
}

// ---------- phát ----------
function tickNow(): number {
  const sec = player.position();
  return sec < 0 ? -1 : (sec * song.tempo * TPB) / 60;
}

function animate() {
  if (!playing) {
    roll.setPlayhead(-1);
    return;
  }
  roll.setPlayhead(tickNow());
  requestAnimationFrame(animate);
}

async function playSong() {
  player.stopVoice();
  playing = true;
  ($('btnPlay') as HTMLButtonElement).disabled = true;
  try {
    await player.play(song, song.chords, {
      melody: ($('playMelody') as HTMLInputElement).checked,
      accompaniment: ($('playAcc') as HTMLInputElement).checked,
      onEnd: stopAll,
    });
    requestAnimationFrame(animate);
  } catch (e) {
    console.error(e);
    stopAll();
  } finally {
    ($('btnPlay') as HTMLButtonElement).disabled = false;
  }
}

function stopAll() {
  playing = false;
  player.stop();
  player.stopVoice();
  roll.setPlayhead(-1);
}

// ---------- sửa nốt ----------
function editSelected(fn: (n: Note, notes: Note[], i: number) => Note[] | void) {
  const i = roll.selected;
  if (i === null || !song.notes[i]) {
    toast('Chọn một nốt trước (bấm vào nốt).');
    return;
  }
  snapshot();
  const notes = song.notes.map((n) => ({ ...n }));
  const res = fn(notes[i], notes, i);
  const target = notes[i];
  song.notes = normalizeNotes(res ?? notes);
  // giữ nốt đang chọn sau khi sắp xếp lại
  const ni = song.notes.findIndex((n) => n.start === target.start && n.midi === target.midi);
  roll.selected = ni >= 0 ? ni : null;
  commit();
  if (roll.selected !== null) player.previewNote(song.notes[roll.selected].midi);
}

function grid(): number {
  return Number(($('grid') as HTMLSelectElement).value);
}

function bindEditing() {
  $('nUp').onclick = () => editSelected((n) => void (n.midi = Math.min(100, n.midi + 1)));
  $('nDown').onclick = () => editSelected((n) => void (n.midi = Math.max(24, n.midi - 1)));
  $('nLeft').onclick = () => editSelected((n) => void (n.start = Math.max(0, n.start - grid())));
  $('nRight').onclick = () => editSelected((n) => void (n.start += grid()));
  $('nLonger').onclick = () => editSelected((n) => void (n.dur += grid()));
  $('nShorter').onclick = () => editSelected((n) => void (n.dur = Math.max(1, n.dur - grid())));
  $('nDelete').onclick = () =>
    editSelected((_n, notes, i) => {
      notes.splice(i, 1);
      roll.selected = null;
      return notes;
    });
  $('nSplit').onclick = () =>
    editSelected((n, notes, i) => {
      if (n.dur < 2) return notes;
      const half = Math.max(1, Math.floor(n.dur / 2 / grid()) * grid() || Math.floor(n.dur / 2));
      notes.splice(i + 1, 0, { start: n.start + half, dur: n.dur - half, midi: n.midi });
      n.dur = half;
      return notes;
    });
  $('nMerge').onclick = () =>
    editSelected((n, notes, i) => {
      const next = notes[i + 1];
      if (!next) return notes;
      n.dur = next.start + next.dur - n.start;
      notes.splice(i + 1, 1);
      return notes;
    });
  const all = (fn: (n: Note) => void) => {
    if (!song.notes.length) return;
    snapshot();
    song.notes.forEach(fn);
    song.notes = normalizeNotes(song.notes);
    commit();
  };
  $('allUp').onclick = () => all((n) => void (n.midi += 1));
  $('allDown').onclick = () => all((n) => void (n.midi -= 1));
  $('allLeft').onclick = () => {
    if (song.notes.length && song.notes[0].start - grid() < 0) return toast('Bài đã bắt đầu từ đầu ô nhịp.');
    all((n) => void (n.start -= grid()));
  };
  $('allRight').onclick = () => all((n) => void (n.start += grid()));

  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;

  ($('insLyric') as HTMLInputElement).addEventListener('change', (e) => {
    const i = roll.selected;
    if (i === null) return;
    snapshot();
    const v = (e.target as HTMLInputElement).value.trim();
    song.notes[i].lyric = v || undefined;
    song.lyricsText = lyricsFromNotes(song.notes);
    commit();
  });

  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (roll.selected !== null) {
      const map: Record<string, string> = e.shiftKey
        ? { ArrowRight: 'nLonger', ArrowLeft: 'nShorter' }
        : { ArrowUp: 'nUp', ArrowDown: 'nDown', ArrowLeft: 'nLeft', ArrowRight: 'nRight', Delete: 'nDelete', Backspace: 'nDelete' };
      if (map[k]) {
        e.preventDefault();
        $(map[k]).click();
      }
    } else if (k === ' ') {
      e.preventDefault();
      playing ? stopAll() : playSong();
    }
  });
}

function undo() {
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push(JSON.stringify(song));
  song = JSON.parse(s);
  roll.selected = null;
  commit({ rederive: true });
}

function redo() {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push(JSON.stringify(song));
  song = JSON.parse(s);
  roll.selected = null;
  commit({ rederive: true });
}

// ---------- hợp âm ----------
let chordTarget = -1;
function openChordDialog(ci: number) {
  chordTarget = ci;
  const dlg = $('chordDialog') as HTMLDialogElement;
  const box = $('chordChoices');
  box.innerHTML = '';
  for (const c of diatonicChords(song.key)) {
    const b = document.createElement('button');
    b.innerHTML = `${chordName(c, song.key)}<small>${c.degree}</small>`;
    b.onclick = () => {
      setChord(ci, c);
      dlg.close();
    };
    box.append(b);
  }
  ($('chordInput') as HTMLInputElement).value = chordName(song.chords[ci], song.key);
  dlg.showModal();
}

function setChord(ci: number, c: Pick<Chord, 'root' | 'quality'>) {
  snapshot();
  song.chordsAuto = false;
  song.chords = song.chords.map((x, i) => (i === ci ? { ...x, root: c.root, quality: c.quality } : x));
  commit();
}

// ---------- lời ----------
function assignFromTextarea() {
  const text = ($('lyrics') as HTMLTextAreaElement).value;
  if (!song.notes.length) return toast('Chưa có nốt nào. Hãy hát trước.');
  snapshot();
  song.lyricsText = text;
  const r = assignLyrics(song.notes, text);
  song.notes = r.notes;
  commit();
  const msg =
    r.extra > 0
      ? `Thừa ${r.extra} chữ so với số nốt. Hãy tách nốt (✂) hoặc bớt chữ.`
      : r.missing > 0
        ? `Thiếu ${r.missing} chữ: ${r.missing} nốt cuối chưa có lời.`
        : 'Đã gán lời: mỗi chữ một nốt.';
  $('lyricMsg').textContent = msg;
}

async function recognizeLyrics() {
  if (!audio16k) {
    audio16k = await loadAudio(song.id);
    if (!audio16k) return toast('Chưa có bản thu giọng cho bài này. Hãy hát trước.');
  }
  const model = ($('asrModel') as HTMLSelectElement).value as 'base' | 'small';
  ($('btnAsr') as HTMLButtonElement).disabled = true;
  setProgress('asrProgress', 0, 'Chuẩn bị…');
  try {
    const text = await transcribe(audio16k, model, {
      onStatus: (t) => setProgress('asrProgress', 0.02, t),
      onProgress: (l, t) =>
        setProgress('asrProgress', t ? l / t : 0, `Đang tải mô hình: ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB`),
    });
    setProgress('asrProgress', null);
    if (!text) return toast('AI chưa nghe ra lời. Bạn có thể gõ lời bằng tay.');
    ($('lyrics') as HTMLTextAreaElement).value = text;
    assignFromTextarea();
    toast('Đã nhận lời (bản nháp). Hãy sửa lại cho đúng rồi bấm "Gán lời vào nốt".', 5000);
  } catch (e: any) {
    console.error(e);
    setProgress('asrProgress', null);
    toast('Không nhận được lời: ' + (e?.message ?? e) + '. Bạn có thể gõ lời bằng tay.', 7000);
  } finally {
    ($('btnAsr') as HTMLButtonElement).disabled = false;
  }
}

// ---------- tải về ----------
function safeName(): string {
  return (song.title || 'bai-hat').replace(/[\\/:*?"<>|]+/g, '').trim() || 'bai-hat';
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

function bindExports() {
  $('btnMidi').onclick = () => {
    if (!song.notes.length) return toast('Chưa có nốt nào.');
    download(songToMidi(song, song.chords) as Uint8Array<ArrayBuffer>, 'audio/midi', `${safeName()}.mid`);
  };
  $('btnXml').onclick = () => {
    if (!song.notes.length) return toast('Chưa có nốt nào.');
    download(songToMusicXml(song, song.chords), 'application/vnd.recordare.musicxml+xml', `${safeName()}.musicxml`);
  };
  $('btnPdf').onclick = () => {
    if (!song.notes.length) return toast('Chưa có nốt nào.');
    toast('Chọn "Lưu dưới dạng PDF" trong hộp thoại in.', 4000);
    setTimeout(() => window.print(), 300);
  };
  $('btnWav').onclick = () => {
    if (!audio16k) return;
    download(encodeWav(audio16k, 16000), 'audio/wav', `${safeName()}-giong-hat.wav`);
  };
  const share = $('btnShare') as HTMLButtonElement;
  const probe = new File([new Uint8Array(1)], 'a.mid', { type: 'audio/midi' });
  if (navigator.canShare?.({ files: [probe] })) {
    share.hidden = false;
    share.onclick = async () => {
      const f = new File([songToMidi(song, song.chords) as Uint8Array<ArrayBuffer>], `${safeName()}.mid`, { type: 'audio/midi' });
      try {
        await navigator.share({ files: [f], title: song.title, text: 'Bài hát mình vừa sáng tác bằng Hát ra nhạc' });
      } catch {
        /* người dùng hủy */
      }
    };
  }
}

// ---------- danh sách bài ----------
function openSongs() {
  const ul = $('songsList');
  ul.innerHTML = '';
  const all = listSongs();
  if (!all.length) ul.innerHTML = '<li><span class="hint">Chưa có bài nào.</span></li>';
  for (const s of all) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${s.title} · ${new Date(s.updated).toLocaleString('vi-VN')}`;
    const open = document.createElement('button');
    open.textContent = 'Mở';
    open.onclick = async () => {
      stopAll();
      song = s;
      audio16k = await loadAudio(s.id);
      undoStack.length = 0;
      redoStack.length = 0;
      roll.selected = null;
      commit({ save: false });
      ($('songsDialog') as HTMLDialogElement).close();
    };
    const del = document.createElement('button');
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

// ---------- gắn sự kiện ----------
function bind() {
  $('btnRecord').onclick = toggleRecord;
  ($('file') as HTMLInputElement).onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    readSettings();
    try {
      const rec = await decodeFile(f);
      await analyze(rec);
    } catch (err: any) {
      toast('Không đọc được file âm thanh: ' + (err?.message ?? err));
    }
    (e.target as HTMLInputElement).value = '';
  };
  ($('title') as HTMLInputElement).onchange = (e) => {
    song.title = (e.target as HTMLInputElement).value.trim() || 'Bài hát mới';
    commit({ rederive: false });
  };
  ($('tempo') as HTMLInputElement).onchange = () => {
    readSettings();
    commit({ rederive: false });
  };
  ($('meter') as HTMLSelectElement).onchange = () => {
    snapshot();
    readSettings();
    commit();
  };
  ($('key') as HTMLSelectElement).onchange = (e) => {
    snapshot();
    const v = (e.target as HTMLSelectElement).value;
    if (v === 'auto') song.keyAuto = true;
    else {
      const [t, m] = v.split(':');
      song.keyAuto = false;
      song.key = { tonic: Number(t), mode: m as 'major' | 'minor' };
    }
    song.chordsAuto = true;
    commit();
  };
  ($('lh') as HTMLSelectElement).onchange = (e) => {
    song.lhPattern = (e.target as HTMLSelectElement).value as LhPattern;
    commit({ rederive: false });
  };
  ($('cpm') as HTMLSelectElement).onchange = (e) => {
    snapshot();
    song.chordsPerMeasure = Number((e.target as HTMLSelectElement).value) as 1 | 2;
    song.chordsAuto = true;
    commit();
  };
  $('btnReharm').onclick = () => {
    snapshot();
    song.chordsAuto = true;
    commit();
    toast('Đã hòa âm lại tự động.');
  };
  ($('zoom') as HTMLInputElement).oninput = (e) => {
    roll.pxPerTick = Number((e.target as HTMLInputElement).value);
    roll.draw();
  };
  ($('grid') as HTMLSelectElement).onchange = () => {
    roll.grid = grid();
    roll.draw();
  };
  $('btnPlay').onclick = playSong;
  $('btnStop').onclick = stopAll;
  $('btnVoice').onclick = async () => {
    if (!audio16k) return;
    stopAll();
    await player.playVoice(audio16k);
  };
  $('btnAssign').onclick = assignFromTextarea;
  $('btnAsr').onclick = recognizeLyrics;
  $('btnNew').onclick = () => {
    stopAll();
    persist();
    song = newSong({ tempo: song.tempo, beatsPerMeasure: song.beatsPerMeasure, lhPattern: song.lhPattern });
    audio16k = null;
    undoStack.length = 0;
    redoStack.length = 0;
    roll.selected = null;
    commit({ save: false });
    $('recordCard').scrollIntoView({ behavior: 'smooth' });
  };
  $('btnOpen').onclick = openSongs;
  $('chordOk').onclick = () => {
    const c = parseChordName(($('chordInput') as HTMLInputElement).value);
    if (!c) return toast('Không hiểu tên hợp âm. Ví dụ: C, Am, F#m, Bb, G7, Bdim.');
    setChord(chordTarget, c);
    ($('chordDialog') as HTMLDialogElement).close();
  };
  bindEditing();
  bindExports();
}

bind();
roll.grid = grid();
derive();
render();
renderBeats(null);
void loadAudio(song.id).then((a) => {
  if (a && !audio16k) {
    audio16k = a;
    render();
  }
});
