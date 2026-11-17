import { it, expect } from 'vitest';
import { encodeSong, decodeSong } from '../src/share';
import { demoCompose } from '../src/compose';
it('gửi bài qua link: mã hóa rồi giải mã ra bản sao giống hệt, id mới', async () => {
  const a = demoCompose();
  a.words[2].chord = { root: 9, quality: 'min' } as any;
  const code = await encodeSong(a);
  expect(code[0]).toBe('1');
  expect(code).toMatch(/^[0-9A-Za-z_-]+$/);
  const b = await decodeSong(code);
  expect(b.id).not.toBe(a.id);
  expect(b.words).toEqual(a.words);
  expect([b.title, b.tempo, b.lyricsText, b.lhPattern, b.key]).toEqual([a.title, a.tempo, a.lyricsText, a.lhPattern, a.key]);
  await expect(decodeSong(code.slice(0, 20))).rejects.toThrow();
});
