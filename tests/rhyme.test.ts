import { describe, it, expect } from 'vitest';
import { parseSyllable, buildIndex, findRhymes } from '../src/lyrics/rhyme';

describe('tra vần', () => {
  it('tách âm tiết', () => {
    expect(parseSyllable('Người')).toMatchObject({ initial: 'ng', rime: 'ươi', tone: 'huyen' });
    expect(parseSyllable('gì')).toMatchObject({ initial: 'g', rime: 'i' });
    expect(parseSyllable('giữa')).toMatchObject({ initial: 'gi', rime: 'ưa', tone: 'nga' });
    expect(parseSyllable('quan')!.rime).toBe('oan');
    expect(parseSyllable('quên')!.rime).toBe('uên');
    expect(parseSyllable('ly')!.rime).toBe('i');
    expect(parseSyllable('abc')).toBeNull();
    expect(parseSyllable('hello')).toBeNull();
  });
  it('tìm chữ cùng vần, gộp cách bỏ dấu, lọc thanh', () => {
    const idx = buildIndex(['mưa', 'thừa', 'đưa', 'vừa', 'xưa', 'cửa', 'giao thừa', 'Hà Nội', 'hoà', 'hòa bình', 'hoà bình', 'tên', 'quên'].join('\n'));
    const r = findRhymes(idx, 'mưa', true)!;
    const all = r.sameRime.flatMap((g) => g.syllables);
    expect(all).toEqual(expect.arrayContaining(['đưa', 'xưa', 'thừa', 'vừa']));
    expect(all).not.toContain('cửa'); // thanh trắc
    expect(r.words).toContain('giao thừa');
    expect(findRhymes(idx, 'mưa', false)!.sameRime.flatMap((g) => g.syllables)).toContain('cửa');
    expect([...idx.bySyllable.keys()].filter((k) => k === 'hoà' || k === 'hòa')).toHaveLength(1);
    expect(findRhymes(idx, 'quên', true)!.near.flatMap((g) => g.syllables)).toContain('tên');
  });
});
