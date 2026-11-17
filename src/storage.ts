import type { Song } from './model';

// Lưu bài hát trên chính trình duyệt của người dùng (không có máy chủ).
const KEY = 'hrn.songs.v1';

export function listSongs(): Song[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as Song[]) : [];
    return arr.sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export function saveSong(song: Song): boolean {
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
  void deleteAudio(id);
}

// Âm thanh (16 kHz) lưu trong IndexedDB để nghe lại / nhận lời sau.
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('hrn', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('audio');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAudio(id: string, audio: Float32Array): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((res, rej) => {
      const tx = d.transaction('audio', 'readwrite');
      tx.objectStore('audio').put(audio, id);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    /* trình duyệt không cho lưu: bỏ qua */
  }
}

export async function loadAudio(id: string): Promise<Float32Array | null> {
  try {
    const d = await db();
    return await new Promise((res) => {
      const req = d.transaction('audio').objectStore('audio').get(id);
      req.onsuccess = () => res((req.result as Float32Array) ?? null);
      req.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

async function deleteAudio(id: string): Promise<void> {
  try {
    const d = await db();
    d.transaction('audio', 'readwrite').objectStore('audio').delete(id);
  } catch {
    /* bỏ qua */
  }
}
