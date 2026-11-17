import type { Note } from '../model';

export type Tone = 'ngang' | 'huyen' | 'sac' | 'hoi' | 'nga' | 'nang';

export const TONE_LABEL: Record<Tone, string> = {
  ngang: 'thanh ngang',
  huyen: 'dấu huyền',
  sac: 'dấu sắc',
  hoi: 'dấu hỏi',
  nga: 'dấu ngã',
  nang: 'dấu nặng',
};

/** Độ cao tương đối của thanh điệu (gần đúng, dùng để so với hướng giai điệu). */
export const TONE_LEVEL: Record<Tone, number> = {
  huyen: 1,
  nang: 1,
  hoi: 2,
  ngang: 3,
  nga: 3.5,
  sac: 4,
};

/** Nhận dấu thanh của một âm tiết dựa trên dấu kết hợp Unicode. */
export function toneOf(syllable: string): Tone {
  const d = syllable.normalize('NFD');
  if (d.includes('̀')) return 'huyen';
  if (d.includes('́')) return 'sac';
  if (d.includes('̉')) return 'hoi';
  if (d.includes('̃')) return 'nga';
  if (d.includes('̣')) return 'nang';
  return 'ngang';
}

/** Tách lời thành âm tiết (tiếng Việt: mỗi chữ cách nhau bằng khoảng trắng là một âm tiết). */
export function splitSyllables(text: string): string[] {
  return text
    .replace(/[\r\n]+/g, ' ')
    .split(/\s+/)
    .map((s) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((s) => s.length > 0);
}

/** Gán lần lượt mỗi âm tiết vào một nốt. Trả về số âm tiết thừa/thiếu để báo người dùng. */
export function assignLyrics(notes: Note[], text: string): { notes: Note[]; extra: number; missing: number } {
  const syl = splitSyllables(text);
  const out = notes.map((n, i) => ({ ...n, lyric: syl[i] }));
  return {
    notes: out,
    extra: Math.max(0, syl.length - notes.length),
    missing: Math.max(0, notes.length - syl.length),
  };
}

export function lyricsFromNotes(notes: Note[]): string {
  return notes
    .map((n) => n.lyric ?? '')
    .filter(Boolean)
    .join(' ');
}

export interface ToneWarning {
  noteIndex: number; // nốt bị cảnh báo (nốt thứ hai trong cặp)
  severity: 'nhẹ' | 'nặng';
  message: string;
}

/**
 * Kiểm tra lời với giai điệu: tiếng Việt có thanh điệu, nếu giai điệu đi ngược hướng dấu
 * (ví dụ từ chữ huyền lên chữ sắc nhưng nốt lại đi xuống) thì khi hát dễ bị nghe thành chữ khác.
 * Đây là gợi ý theo kinh nghiệm, không phải luật tuyệt đối.
 */
export function checkTones(notes: Note[]): ToneWarning[] {
  const warns: ToneWarning[] = [];
  for (let i = 1; i < notes.length; i++) {
    const a = notes[i - 1];
    const b = notes[i];
    if (!a.lyric || !b.lyric) continue;
    // chỉ so trong cùng câu hát (cách nhau không quá 1 phách lặng)
    if (b.start - (a.start + a.dur) > 4) continue;
    const ta = toneOf(a.lyric);
    const tb = toneOf(b.lyric);
    const dTone = TONE_LEVEL[tb] - TONE_LEVEL[ta];
    const dPitch = b.midi - a.midi;
    if (Math.abs(dTone) >= 2 && Math.abs(dPitch) >= 2 && Math.sign(dTone) !== Math.sign(dPitch)) {
      const severe = Math.abs(dTone) >= 3 && Math.abs(dPitch) >= 3;
      warns.push({
        noteIndex: i,
        severity: severe ? 'nặng' : 'nhẹ',
        message: `"${a.lyric} → ${b.lyric}": ${TONE_LABEL[ta]} sang ${TONE_LABEL[tb]} là đi ${
          dTone > 0 ? 'lên' : 'xuống'
        }, nhưng giai điệu lại đi ${dPitch > 0 ? 'lên' : 'xuống'} ${Math.abs(dPitch)} nửa cung. Hát lên dễ bị nghe sai chữ.`,
      });
      continue;
    }
    // chữ huyền/nặng nhảy vọt lên cao
    if ((tb === 'huyen' || tb === 'nang') && dPitch >= 5) {
      warns.push({
        noteIndex: i,
        severity: 'nhẹ',
        message: `"${b.lyric}" (${TONE_LABEL[tb]}) nằm trên nốt nhảy lên ${dPitch} nửa cung, nghe có thể bị "ngang". Thử hạ nốt này xuống.`,
      });
    }
    // chữ sắc rơi xuống thấp
    if (tb === 'sac' && dPitch <= -5) {
      warns.push({
        noteIndex: i,
        severity: 'nhẹ',
        message: `"${b.lyric}" (${TONE_LABEL[tb]}) nằm trên nốt rơi xuống ${-dPitch} nửa cung, dễ nghe thành dấu khác. Thử nâng nốt này lên.`,
      });
    }
  }
  return warns;
}
