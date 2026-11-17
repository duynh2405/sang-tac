import { analyzePitchAsync, resample } from './audio/pitch';
import type { Recording } from './audio/recorder';
import { framesToRawNotes, quantize } from './audio/segment';
import type { Note } from './model';

export interface TranscribeResult {
  notes: Note[];
  audio16k: Float32Array;
  tuning: number;
}

export async function transcribeMelody(
  rec: Recording,
  o: { tempo: number; beatsPerMeasure: number; grid: number; legato: boolean },
  onProgress?: (p: number) => void,
): Promise<TranscribeResult> {
  const audio16k = resample(rec.samples, rec.sampleRate);
  const frames = await analyzePitchAsync(audio16k, onProgress);
  const { notes: raw, tuning } = framesToRawNotes(frames);
  // file tải lên không có máy đếm nhịp: lấy nốt đầu tiên làm phách 1
  const t0 = Number.isFinite(rec.t0) ? rec.t0 : raw.length ? raw[0].start : 0;
  const notes = quantize(raw, { tempo: o.tempo, beatsPerMeasure: o.beatsPerMeasure, t0, grid: o.grid, legato: o.legato });
  return { notes, audio16k, tuning };
}
