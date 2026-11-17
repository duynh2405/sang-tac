// Gửi bài qua link: toàn bộ bài được nén vào phần #s=... của đường link (không cần máy chủ).
import { newCompose, type ComposeSong, type Word } from './compose';

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (str: string) => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
const canZip = () => typeof CompressionStream !== 'undefined';

/** Dạng gọn của bài: mỗi chữ là một mảng [chữ, nốt, độ dài, nghỉ, gốc HA, loại HA, xuống dòng, xong]. */
export function pack(cs: ComposeSong) {
  return {
    v: 1,
    t: cs.title,
    te: cs.tempo,
    b: cs.beatsPerMeasure,
    l: cs.lhPattern,
    ka: cs.keyAuto ? 1 : 0,
    k: [cs.key.tonic, cs.key.mode],
    y: cs.lyricsText,
    w: cs.words.map((w) => [w.text, w.midi ?? -1, w.dur, w.rest, w.chord?.root ?? -1, w.chord?.quality ?? '', w.br ? 1 : 0, w.done ? 1 : 0, w.slur?.length ? w.slur.map((x) => [x.midi, x.dur]) : 0]),
  };
}

export function unpack(o: any): ComposeSong {
  if (!o || o.v !== 1 || !Array.isArray(o.w)) throw new Error('bad');
  const num = (x: unknown, d: number) => (typeof x === 'number' && isFinite(x) ? x : d);
  const words: Word[] = o.w.map((a: any[]) => ({
    text: String(a[0] ?? ''),
    midi: num(a[1], -1) >= 0 ? num(a[1], 60) : null,
    dur: Math.max(1, num(a[2], 4)),
    rest: Math.max(0, num(a[3], 0)),
    chord: num(a[4], -1) >= 0 ? { root: num(a[4], 0) % 12, quality: a[5] } : null,
    br: !!a[6],
    done: !!a[7],
    ...(Array.isArray(a[8]) && a[8].length
      ? { slur: a[8].slice(0, 2).map((x: any[]) => ({ midi: num(x[0], 60), dur: Math.max(1, num(x[1], 2)) })) }
      : {}),
  }));
  return newCompose({
    title: String(o.t || 'Bài được gửi'),
    tempo: num(o.te, 80),
    beatsPerMeasure: num(o.b, 4),
    lhPattern: o.l ?? 'broken',
    keyAuto: !!o.ka,
    key: { tonic: num(o.k?.[0], 0), mode: o.k?.[1] === 'minor' ? 'minor' : 'major' },
    lyricsText: String(o.y ?? ''),
    words,
  });
}

/** Mã hóa bài thành chuỗi gắn vào link. "1" = đã nén, "0" = không nén (trình duyệt cũ). */
export async function encodeSong(cs: ComposeSong): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(pack(cs)));
  if (canZip()) return '1' + b64url(await pipe(raw, new CompressionStream('deflate-raw')));
  return '0' + b64url(raw);
}

export async function decodeSong(code: string): Promise<ComposeSong> {
  const bytes = unb64url(code.slice(1));
  const raw = code[0] === '1' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
  return unpack(JSON.parse(new TextDecoder().decode(raw)));
}

export async function shareLink(cs: ComposeSong): Promise<string> {
  const base = location.href.split('#')[0].split('?')[0];
  return `${base}#s=${await encodeSong(cs)}`;
}

/** Lấy mã bài từ link đang mở (nếu có). */
export function sharedCodeInUrl(): string | null {
  const m = location.hash.match(/[#&]s=([0-9A-Za-z_-]+)/);
  return m ? m[1] : null;
}
