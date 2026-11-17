import type { ComposeSong } from './compose';

// Lưu bài hát ngay trên trình duyệt của người dùng (không có máy chủ).
const KEY = 'hrn.compose.v1';

export function listSongs(): ComposeSong[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as ComposeSong[]) : [];
    return arr.sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export function saveSong(song: ComposeSong): boolean {
  try {
    const all = listSongs().filter((s) => s.id !== song.id);
    all.push({ ...song, updated: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function deleteSong(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(listSongs().filter((s) => s.id !== id)));
  } catch {
    /* bỏ qua */
  }
}
