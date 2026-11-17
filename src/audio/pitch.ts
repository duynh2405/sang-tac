// Dò cao độ giọng hát bằng thuật toán YIN (chạy hoàn toàn trên máy người dùng).

export const ANALYSIS_SR = 16000;
export const HOP = 160; // 10 ms
const WIN = 1024; // 64 ms
const FMIN = 70;
const FMAX = 1100;

export interface PitchFrame {
  time: number; // giây
  midi: number | null; // cao độ (số thực) hoặc null nếu không có tiếng hát
  conf: number; // 0..1
  db: number; // năng lượng (dBFS)
}

/** Đổi tần số lấy mẫu bằng nội suy tuyến tính, có lọc thông thấp đơn giản khi giảm. */
export function resample(input: Float32Array, fromSr: number, toSr = ANALYSIS_SR): Float32Array {
  if (fromSr === toSr) return input;
  let src = input;
  if (toSr < fromSr) {
    // lọc trung bình trượt để chống răng cưa
    const k = Math.max(1, Math.round(fromSr / toSr));
    const f = new Float32Array(input.length);
    let acc = 0;
    for (let i = 0; i < input.length; i++) {
      acc += input[i];
      if (i >= k) acc -= input[i - k];
      f[i] = acc / Math.min(i + 1, k);
    }
    src = f;
  }
  const ratio = fromSr / toSr;
  const n = Math.floor(src.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const fr = x - i0;
    out[i] = src[i0] * (1 - fr) + src[i1] * fr;
  }
  return out;
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Phân tích toàn bộ tín hiệu (đã ở 16 kHz). */
export function analyzePitch(signal: Float32Array, sr = ANALYSIS_SR, threshold = 0.15): PitchFrame[] {
  const tauMin = Math.floor(sr / FMAX);
  const tauMax = Math.ceil(sr / FMIN);
  const W = WIN;
  const frames: PitchFrame[] = [];
  const d = new Float32Array(tauMax + 1);
  const cmnd = new Float32Array(tauMax + 1);
  for (let start = 0; start + W + tauMax < signal.length; start += HOP) {
    // năng lượng
    let e = 0;
    for (let i = 0; i < W; i++) e += signal[start + i] ** 2;
    const rms = Math.sqrt(e / W);
    const db = 20 * Math.log10(rms + 1e-9);
    const time = (start + W / 2) / sr;
    if (db < -55) {
      frames.push({ time, midi: null, conf: 0, db });
      continue;
    }
    // hàm sai phân
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) {
        const diff = signal[start + i] - signal[start + i + tau];
        s += diff * diff;
      }
      d[tau] = s;
    }
    // chuẩn hóa tích lũy
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    let tauEst = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < threshold) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    if (tauEst < 0) {
      frames.push({ time, midi: null, conf: 0, db });
      continue;
    }
    // nội suy parabol
    let better = tauEst;
    if (tauEst > 1 && tauEst < tauMax) {
      const s0 = cmnd[tauEst - 1];
      const s1 = cmnd[tauEst];
      const s2 = cmnd[tauEst + 1];
      const den = 2 * (2 * s1 - s2 - s0);
      if (den !== 0) better = tauEst + (s2 - s0) / den;
    }
    const hz = sr / better;
    frames.push({ time, midi: hzToMidi(hz), conf: 1 - cmnd[tauEst], db });
  }
  return frames;
}

/** Chạy phân tích theo từng đoạn để không treo giao diện; báo tiến độ. */
export async function analyzePitchAsync(
  signal: Float32Array,
  onProgress?: (p: number) => void,
): Promise<PitchFrame[]> {
  const chunk = ANALYSIS_SR * 3; // 3 giây mỗi lần
  const tauMax = Math.ceil(ANALYSIS_SR / FMIN);
  const all: PitchFrame[] = [];
  for (let s = 0; s < signal.length; s += chunk) {
    // chồng lấn để không mất khung ở ranh giới
    const seg = signal.subarray(s, Math.min(signal.length, s + chunk + WIN + tauMax));
    const fr = analyzePitch(seg);
    for (const f of fr) {
      const t = f.time + s / ANALYSIS_SR;
      if (t * ANALYSIS_SR - WIN / 2 < s + chunk) all.push({ ...f, time: t });
    }
    onProgress?.(Math.min(1, (s + chunk) / signal.length));
    await new Promise((r) => setTimeout(r, 0));
  }
  return all;
}
