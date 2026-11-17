export interface AsrCallbacks {
  onStatus?: (text: string) => void;
  onProgress?: (loaded: number, total: number) => void;
}

let worker: Worker | null = null;

/** Gửi âm thanh 16 kHz mono cho worker Whisper, trả về văn bản lời hát. */
export function transcribe(audio16k: Float32Array, model: 'base' | 'small', cb: AsrCallbacks = {}): Promise<string> {
  if (!worker) worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  return new Promise((resolve, reject) => {
    const files = new Map<string, [number, number]>();
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'status') cb.onStatus?.(m.text);
      else if (m.type === 'progress') {
        files.set(m.file, [m.loaded, m.total]);
        let l = 0;
        let t = 0;
        for (const [a, b] of files.values()) {
          l += a;
          t += b;
        }
        cb.onProgress?.(l, t);
      } else if (m.type === 'result') resolve(m.text);
      else if (m.type === 'error') reject(new Error(m.text));
    };
    w.onerror = (e) => reject(new Error(e.message || 'Lỗi worker nhận lời'));
    // sao chép để không chuyển quyền sở hữu bộ đệm gốc
    const copy = audio16k.slice();
    w.postMessage({ type: 'transcribe', audio: copy, model }, [copy.buffer]);
  });
}
