/// <reference lib="webworker" />
// Nhận lời hát bằng Whisper chạy ngay trên trình duyệt (không gửi âm thanh lên máy chủ).
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

type Req = { type: 'transcribe'; audio: Float32Array; model: 'base' | 'small' };

const cache = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

async function load(model: 'base' | 'small'): Promise<AutomaticSpeechRecognitionPipeline> {
  const id = `onnx-community/whisper-${model}`;
  const hasGpu = typeof (self as any).navigator !== 'undefined' && 'gpu' in (self as any).navigator;
  const key = id + (hasGpu ? ':gpu' : ':wasm');
  if (!cache.has(key)) {
    const progress_callback = (p: any) => {
      if (p.status === 'progress' && p.total) {
        postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
      }
    };
    const make = async (): Promise<AutomaticSpeechRecognitionPipeline> => {
      if (hasGpu) {
        try {
          return (await pipeline('automatic-speech-recognition', id, {
            device: 'webgpu',
            dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } as any,
            progress_callback,
          })) as AutomaticSpeechRecognitionPipeline;
        } catch {
          // WebGPU lỗi thì chuyển sang WASM
        }
      }
      return (await pipeline('automatic-speech-recognition', id, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback,
      })) as AutomaticSpeechRecognitionPipeline;
    };
    cache.set(key, make());
  }
  return cache.get(key)!;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const msg = e.data;
  if (msg.type !== 'transcribe') return;
  try {
    postMessage({ type: 'status', text: 'Đang tải mô hình nhận lời (chỉ lần đầu)…' });
    const asr = await load(msg.model);
    postMessage({ type: 'status', text: 'Đang nghe lời hát…' });
    const out: any = await asr(msg.audio, {
      language: 'vietnamese',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    } as any);
    const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
    postMessage({ type: 'result', text: String(text ?? '').trim() });
  } catch (err: any) {
    postMessage({ type: 'error', text: String(err?.message ?? err) });
  }
};
