// Tra vần tiếng Việt: tách âm tiết thành phụ âm đầu + vần + thanh, rồi tìm chữ/từ cùng vần.
import { toneOf, type Tone } from './vietnamese';

export const TONE_ORDER: Tone[] = ['ngang', 'huyen', 'sac', 'hoi', 'nga', 'nang'];
export const TONE_NAME: Record<Tone, string> = {
  ngang: 'Ngang',
  huyen: 'Huyền',
  sac: 'Sắc',
  hoi: 'Hỏi',
  nga: 'Ngã',
  nang: 'Nặng',
};
export const isBang = (t: Tone) => t === 'ngang' || t === 'huyen';

export interface Syllable {
  text: string; // âm tiết gốc (chữ thường)
  initial: string; // phụ âm đầu
  rime: string; // vần (không dấu thanh), vd "ưa", "oan"
  near: string; // nhóm vần gần, vd "aN"
  tone: Tone;
}

const TONE_MARKS = /[̣̀́̃̉]/g;
const INITIALS = ['ngh', 'ng', 'gh', 'gi', 'kh', 'nh', 'ph', 'th', 'tr', 'ch', 'qu', 'b', 'c', 'd', 'đ', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'x'];
const VOWELS = 'aăâeêioôơuưy';
const RIME_RE = new RegExp(`^[${VOWELS}]{1,3}(ch|ng|nh|c|m|n|p|t)?$`);

export function stripTone(s: string): string {
  return s.normalize('NFD').replace(TONE_MARKS, '').normalize('NFC');
}

/** Tách một âm tiết. Trả về null nếu không phải âm tiết tiếng Việt hợp lệ. */
export function parseSyllable(raw: string): Syllable | null {
  const text = raw.normalize('NFC').toLowerCase().trim();
  if (!text || text.length > 8) return null;
  // nhiều hơn một dấu thanh là dữ liệu lỗi
  if ((text.normalize('NFD').match(TONE_MARKS) ?? []).length > 1) return null;
  const tone = toneOf(text);
  const base = stripTone(text);
  let initial = '';
  for (const ini of INITIALS) {
    if (base.startsWith(ini)) {
      initial = ini;
      break;
    }
  }
  let rest = base.slice(initial.length);
  // "gi" đứng trước phụ âm hoặc đứng một mình: "gì", "gìn" -> phụ âm g + vần i/in
  if (initial === 'gi' && (rest === '' || !VOWELS.includes(rest[0]))) {
    initial = 'g';
    rest = 'i' + rest;
  }
  if (!RIME_RE.test(rest)) return null;
  // "qu" mang âm đệm: quan ~ hoan, quê ~ huê
  let rime = rest;
  if (initial === 'qu') rime = (/^[aăe]/.test(rest) ? 'o' : 'u') + rest;
  if (rime === 'y') rime = 'i'; // ly = li
  return { text, initial, rime, near: nearKey(rime), tone };
}

/** Vần gần: bỏ âm đệm, gộp n/ng/nh và c/ch/t, i/y. */
export function nearKey(rime: string): string {
  let r = rime;
  if (/^o[aăe]/.test(r)) r = r.slice(1);
  else if (/^u[âêyơ]/.test(r)) r = r.slice(1);
  r = r.replace(/^y/, 'i').replace(/^iê|^yê/, 'iê');
  return r.replace(/(ng|nh|n)$/, 'N').replace(/(ch|c|t)$/, 'T');
}

export interface RhymeIndex {
  bySyllable: Map<string, Syllable>; // âm tiết (dạng chuẩn) -> thông tin
  freq: Map<string, number>; // âm tiết (dạng chuẩn) -> số từ có chứa nó (càng nhiều càng thông dụng)
  byRime: Map<string, Set<string>>; // vần -> các âm tiết
  byNear: Map<string, Set<string>>; // vần gần -> các vần
  wordsByRime: Map<string, string[]>; // vần của chữ cuối -> từ ghép
}

const sylKey = (s: Syllable) => `${s.initial}|${s.rime}|${s.tone}`;

/**
 * Dựng chỉ mục từ danh sách từ (mỗi dòng một từ). Bỏ tên riêng và từ vay mượn có gạch nối.
 * Các cách bỏ dấu khác nhau (hoà/hòa) được gộp làm một, lấy cách viết hay gặp nhất.
 */
export function buildIndex(text: string): RhymeIndex {
  const idx: RhymeIndex = { bySyllable: new Map(), freq: new Map(), byRime: new Map(), byNear: new Map(), wordsByRime: new Map() };
  const add = <K, V>(m: Map<K, Set<V>>, k: K, v: V) => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    s.add(v);
  };
  // lượt 1: đếm cách viết của từng âm tiết
  const entries: { parts: string[]; syl: Syllable[] }[] = [];
  const spell = new Map<string, Map<string, number>>();
  const keyFreq = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const w = line.trim().normalize('NFC');
    if (!w || w.includes('-') || w !== w.toLowerCase()) continue;
    const parts = w.split(/\s+/);
    if (parts.length > 3) continue;
    const syl = parts.map(parseSyllable);
    if (syl.some((x) => !x)) continue;
    entries.push({ parts, syl: syl as Syllable[] });
    for (const x of syl as Syllable[]) {
      const k = sylKey(x);
      keyFreq.set(k, (keyFreq.get(k) ?? 0) + 1);
      const m = spell.get(k) ?? new Map<string, number>();
      m.set(x.text, (m.get(x.text) ?? 0) + 1);
      spell.set(k, m);
    }
  }
  const canon = new Map<string, string>();
  for (const [k, m] of spell) canon.set(k, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);

  // lượt 2: dựng chỉ mục bằng cách viết chuẩn
  const seenWord = new Set<string>();
  for (const { syl } of entries) {
    const texts = syl.map((x) => canon.get(sylKey(x))!);
    syl.forEach((x, i) => {
      const t = texts[i];
      if (!idx.bySyllable.has(t)) {
        idx.bySyllable.set(t, { ...x, text: t });
        idx.freq.set(t, keyFreq.get(sylKey(x)) ?? 0);
        add(idx.byRime, x.rime, t);
        add(idx.byNear, x.near, x.rime);
      }
    });
    const w = texts.join(' ');
    if (texts.length >= 2 && !seenWord.has(w)) {
      seenWord.add(w);
      const last = syl[syl.length - 1];
      let arr = idx.wordsByRime.get(last.rime);
      if (!arr) idx.wordsByRime.set(last.rime, (arr = []));
      arr.push(w);
    }
  }
  return idx;
}

export interface RhymeResult {
  query: Syllable;
  /** chữ cùng vần, chia theo thanh */
  sameRime: { tone: Tone; syllables: string[] }[];
  /** từ ghép có chữ cuối cùng vần */
  words: string[];
  /** vần gần, chia theo vần */
  near: { rime: string; syllables: string[] }[];
}

const viSort = (a: string, b: string) => a.localeCompare(b, 'vi');

/** Ngưỡng coi là chữ ít dùng (xuất hiện trong rất ít từ). */
export const RARE = 2;

/**
 * Tra vần. sameTone = true: chỉ lấy cùng nhóm thanh (bằng: ngang, huyền; trắc: sắc, hỏi, ngã, nặng).
 */
export function findRhymes(idx: RhymeIndex, word: string, sameTone: boolean): RhymeResult | null {
  const q = parseSyllable(word.trim().split(/\s+/).pop() ?? '');
  if (!q) return null;
  const okTone = (t: Tone) => !sameTone || isBang(t) === isBang(q.tone);

  const pool = [...(idx.byRime.get(q.rime) ?? [])].map((t) => idx.bySyllable.get(t)!);
  const sameRime = TONE_ORDER.filter(okTone)
    .map((tone) => ({
      tone,
      syllables: pool
        .filter((s) => s.tone === tone && s.text !== q.text)
        .map((s) => s.text)
        .sort((a, b) => (idx.freq.get(b) ?? 0) - (idx.freq.get(a) ?? 0) || viSort(a, b)),
    }))
    .filter((g) => g.syllables.length > 0);

  const wordsSorted = (idx.wordsByRime.get(q.rime) ?? [])
    .filter((w) => {
      const last = parseSyllable(w.split(/\s+/).pop()!)!;
      return okTone(last.tone);
    })
    .map((w) => ({ w, score: Math.min(...w.split(' ').map((t) => idx.freq.get(t) ?? 0)) }))
    .sort((a, b) => a.w.split(' ').length - b.w.split(' ').length || b.score - a.score || viSort(a.w, b.w))
    .map((x) => x.w);
  // xen kẽ theo chữ cuối để gợi ý đa dạng (không bị một chữ chiếm hết)
  const byLast = new Map<string, string[]>();
  for (const w of wordsSorted) {
    const k = w.split(' ').pop()!;
    byLast.set(k, [...(byLast.get(k) ?? []), w]);
  }
  const lists = [...byLast.values()];
  const words: string[] = [];
  for (let i = 0; words.length < wordsSorted.length; i++) for (const l of lists) if (l[i]) words.push(l[i]);

  const near = [...(idx.byNear.get(q.near) ?? [])]
    .filter((r) => r !== q.rime)
    .sort(viSort)
    .map((rime) => ({
      rime,
      syllables: [...(idx.byRime.get(rime) ?? [])]
        .map((t) => idx.bySyllable.get(t)!)
        .filter((s) => okTone(s.tone))
        .map((s) => s.text)
        .sort((a, b) => (idx.freq.get(b) ?? 0) - (idx.freq.get(a) ?? 0) || viSort(a, b)),
    }))
    .filter((g) => g.syllables.length > 0);

  return { query: q, sameRime, words, near };
}

// ---------- tải từ điển (lần đầu, rồi lưu cache) ----------
const SOURCES = [
  'https://cdn.jsdelivr.net/gh/duyet/vietnamese-wordlist@master/Viet74K.txt',
  'https://raw.githubusercontent.com/duyet/vietnamese-wordlist/master/Viet74K.txt',
];
let loading: Promise<RhymeIndex> | null = null;

export function loadRhymeIndex(): Promise<RhymeIndex> {
  if (!loading) {
    loading = (async () => {
      let lastErr: unknown = null;
      for (const url of SOURCES) {
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return buildIndex(await r.text());
        } catch (e) {
          lastErr = e;
        }
      }
      loading = null;
      throw lastErr ?? new Error('Không tải được từ điển');
    })();
  }
  return loading;
}
