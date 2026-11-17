// Thu âm từ micro (AudioWorklet, khớp mẫu với máy đếm nhịp) và giải mã file âm thanh.

const WORKLET_SRC = `
class RecProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.on = true; this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; }; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && this.on) this.port.postMessage({ t: currentTime, d: ch.slice(0) });
    return this.on;
  }
}
registerProcessor('rec-processor', RecProcessor);
`;

let ctx: AudioContext | null = null;
let workletReady: Promise<void> | null = null;

export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

async function ensureWorklet(c: AudioContext) {
  if (!workletReady) {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    workletReady = c.audioWorklet.addModule(url);
  }
  return workletReady;
}

export function click(c: AudioContext, when: number, accent: boolean, volume = 0.35) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.frequency.value = accent ? 1600 : 1000;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(volume * (accent ? 1 : 0.7), when + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  osc.connect(g).connect(c.destination);
  osc.start(when);
  osc.stop(when + 0.06);
}

export interface Recording {
  samples: Float32Array;
  sampleRate: number;
  t0: number; // giây (trong bản thu) ứng với phách 1 ô nhịp đầu
}

export interface RecordSession {
  stop: () => Promise<Recording>;
  cancel: () => void;
  /** gọi lại mỗi phách: số phách (âm = đang đếm vào), mức âm lượng micro */
  onTick?: (beat: number) => void;
  onLevel?: (rms: number) => void;
}

export interface RecordOptions {
  tempo: number;
  beatsPerMeasure: number;
  countInMeasures: number;
  metronomeDuringTake: boolean;
}

export async function startRecording(opts: RecordOptions): Promise<RecordSession> {
  const c = audioContext();
  await c.resume();
  await ensureWorklet(c);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const src = c.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(c, 'rec-processor');
  const mute = c.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(c.destination);

  const chunks: Float32Array[] = [];
  let firstT: number | null = null;
  const session: RecordSession = { stop: null as any, cancel: null as any };
  node.port.onmessage = (e) => {
    if (firstT === null) firstT = e.data.t;
    const d: Float32Array = e.data.d;
    chunks.push(d);
    if (session.onLevel) {
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      session.onLevel(Math.sqrt(s / d.length));
    }
  };

  const beatSec = 60 / opts.tempo;
  const clickStart = c.currentTime + 0.35;
  const countIn = opts.countInMeasures * opts.beatsPerMeasure;
  const downbeat = clickStart + countIn * beatSec;
  let nextBeat = 0;
  let running = true;
  const schedule = () => {
    if (!running) return;
    while (clickStart + nextBeat * beatSec < c.currentTime + 0.2) {
      const when = clickStart + nextBeat * beatSec;
      const inCountIn = nextBeat < countIn;
      if (inCountIn || opts.metronomeDuringTake) click(c, when, nextBeat % opts.beatsPerMeasure === 0);
      const b = nextBeat - countIn;
      const delay = Math.max(0, (when - c.currentTime) * 1000);
      setTimeout(() => running && session.onTick?.(b), delay);
      nextBeat++;
    }
    setTimeout(schedule, 50);
  };
  schedule();

  const cleanup = () => {
    running = false;
    node.port.postMessage('stop');
    try {
      src.disconnect();
      node.disconnect();
      mute.disconnect();
    } catch {
      /* bỏ qua */
    }
    stream.getTracks().forEach((t) => t.stop());
  };

  session.cancel = cleanup;
  session.stop = async () => {
    cleanup();
    await new Promise((r) => setTimeout(r, 60));
    const total = chunks.reduce((s, x) => s + x.length, 0);
    const samples = new Float32Array(total);
    let o = 0;
    for (const ch of chunks) {
      samples.set(ch, o);
      o += ch.length;
    }
    // bù trễ: người hát nghe tiếng gõ trễ (output latency) và micro thu trễ (input latency)
    const lat = (c.outputLatency || 0) + (c.baseLatency || 0) + 0.03;
    const t0 = downbeat + lat - (firstT ?? clickStart);
    return { samples, sampleRate: c.sampleRate, t0 };
  };
  return session;
}

export async function decodeFile(file: File): Promise<Recording> {
  const c = audioContext();
  const buf = await c.decodeAudioData(await file.arrayBuffer());
  const n = buf.length;
  const mono = new Float32Array(n);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
  }
  return { samples: mono, sampleRate: buf.sampleRate, t0: NaN }; // NaN: không có máy đếm nhịp
}

/** Mã hóa WAV 16-bit để lưu/tải bản thu. */
export function encodeWav(samples: Float32Array, sr: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
