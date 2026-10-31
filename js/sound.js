// 合成音效：全部用 WebAudio 现场合成，不需要音频文件。
let ctx = null;
let master = null;
let noise = null;
let enabled = true;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const ch = noise.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function env(gainNode, t, peak, attack, decay) {
  const g = gainNode.gain;
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(peak, t + attack);
  g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone({ type = 'sine', freq = 440, to = null, peak = 0.2, attack = 0.005, decay = 0.2, delay = 0 }) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  env(g, t, peak, attack, decay);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

function hiss({ filter = 'bandpass', freq = 1200, q = 1, to = null, peak = 0.2, attack = 0.005, decay = 0.12, delay = 0 }) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + delay;
  const src = c.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const f = c.createBiquadFilter();
  f.type = filter;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  f.Q.value = q;
  const g = c.createGain();
  env(g, t, peak, attack, decay);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + attack + decay + 0.05);
}

const guard = (fn) => (...args) => { if (enabled) fn(...args); };

export const sfx = {
  get enabled() { return enabled; },
  setEnabled(v) { enabled = !!v; if (v && ctx) audio(); },
  /** 在用户手势里调用一次，解锁浏览器音频。 */
  unlock() { if (enabled) audio(); },

  // 纸张摩擦（洗牌）
  shuffle: guard(() => {
    hiss({ freq: 2600, q: 0.7, peak: 0.16, attack: 0.01, decay: 0.16 });
    hiss({ freq: 1500, q: 0.9, peak: 0.1, attack: 0.01, decay: 0.12, delay: 0.06 });
  }),
  // 发牌落桌
  deal: guard(() => {
    hiss({ filter: 'highpass', freq: 1800, peak: 0.12, decay: 0.07 });
    tone({ freq: 140, to: 90, peak: 0.12, decay: 0.08 });
  }),
  // 火漆碎裂
  crack: guard(() => {
    hiss({ freq: 900, q: 2.5, peak: 0.32, attack: 0.002, decay: 0.07 });
    hiss({ freq: 2400, q: 3, peak: 0.16, attack: 0.002, decay: 0.05, delay: 0.035 });
    tone({ type: 'triangle', freq: 180, to: 70, peak: 0.18, decay: 0.12 });
  }),
  // 翻面
  flip: guard(() => {
    hiss({ filter: 'lowpass', freq: 600, to: 3200, q: 0.8, peak: 0.12, attack: 0.04, decay: 0.22 });
  }),
  // 人格点亮
  light: guard((i = 0) => {
    tone({ type: 'triangle', freq: 520 * Math.pow(1.122, i % 6), peak: 0.035, decay: 0.12 });
  }),
  // 最终天赋
  ultimate: guard(() => {
    tone({ freq: 880, peak: 0.12, attack: 0.01, decay: 1.1 });
    tone({ freq: 1318.5, peak: 0.08, attack: 0.01, decay: 1.3, delay: 0.05 });
    tone({ freq: 1760, peak: 0.04, attack: 0.01, decay: 0.9, delay: 0.1 });
  }),
  // 轮盘滴答
  tick: guard(() => {
    tone({ type: 'square', freq: 1900, peak: 0.04, attack: 0.001, decay: 0.025 });
  }),
  // 特质锁定
  lock: guard(() => {
    tone({ type: 'triangle', freq: 660, peak: 0.14, decay: 0.25 });
    tone({ type: 'triangle', freq: 990, peak: 0.1, decay: 0.35, delay: 0.07 });
  }),
  // 监管者登场：低频重击
  boom: guard(() => {
    tone({ freq: 110, to: 34, peak: 0.6, attack: 0.008, decay: 0.9 });
    hiss({ filter: 'lowpass', freq: 500, to: 80, peak: 0.35, attack: 0.005, decay: 0.6 });
    tone({ type: 'sawtooth', freq: 55, to: 40, peak: 0.08, attack: 0.01, decay: 0.7 });
  }),
  // 监管者蓄势：心跳
  heartbeat: guard(() => {
    tone({ freq: 70, to: 45, peak: 0.35, decay: 0.16 });
    tone({ freq: 70, to: 45, peak: 0.25, decay: 0.16, delay: 0.2 });
  }),
};
