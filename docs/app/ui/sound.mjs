// All audio cues are synthesised — no asset files, always in tune with the app.
export class Sound {
  constructor() {
    this.ctx = null;
    this.ringTimer = null;
    this.dialTimer = null;
    this.enabled = true;
  }

  ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  tone({ freq = 660, to = null, dur = 0.16, type = 'sine', gain = 0.06, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx || !this.enabled) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.04);
  }

  sent() { this.tone({ freq: 700, to: 940, dur: 0.09, gain: 0.035, type: 'sine' }); }

  received() {
    this.tone({ freq: 880, dur: 0.1, gain: 0.05, type: 'sine' });
    this.tone({ freq: 1180, dur: 0.13, gain: 0.042, type: 'sine', delay: 0.085 });
  }

  incoming() {
    this.tone({ freq: 760, dur: 0.18, gain: 0.05, type: 'triangle' });
    this.tone({ freq: 950, dur: 0.2, gain: 0.045, type: 'triangle', delay: 0.19 });
  }

  connect() {
    [523, 659, 784].forEach((f, i) => this.tone({ freq: f, dur: 0.22, gain: 0.045, delay: i * 0.07, type: 'sine' }));
  }

  end() {
    this.tone({ freq: 420, to: 260, dur: 0.28, gain: 0.05, type: 'sine' });
  }

  error() {
    this.tone({ freq: 220, dur: 0.16, gain: 0.05, type: 'square' });
  }

  chatOpen() { this.tone({ freq: 520, to: 660, dur: 0.1, gain: 0.028, type: 'sine' }); }

  dialStart() {
    this.stopDial();
    const pattern = () => {
      this.tone({ freq: 440, dur: 0.6, gain: 0.022, type: 'sine' });
      this.tone({ freq: 480, dur: 0.6, gain: 0.018, type: 'sine' });
    };
    pattern();
    this.dialTimer = setInterval(pattern, 2400);
  }

  stopDial() {
    clearInterval(this.dialTimer);
    this.dialTimer = null;
  }

  ringStart() {
    this.stopRing();
    const pattern = () => {
      for (let i = 0; i < 2; i++) {
        this.tone({ freq: 620, dur: 0.28, gain: 0.07, type: 'triangle', delay: i * 0.36 });
        this.tone({ freq: 780, dur: 0.28, gain: 0.05, type: 'triangle', delay: i * 0.36 });
      }
      this.tone({ freq: 620, dur: 0.28, gain: 0.07, type: 'triangle', delay: 0.86 });
      this.tone({ freq: 780, dur: 0.3, gain: 0.05, type: 'triangle', delay: 0.86 });
    };
    pattern();
    this.ringTimer = setInterval(pattern, 3000);
  }

  stopRing() {
    clearInterval(this.ringTimer);
    this.ringTimer = null;
  }

  stopAll() {
    this.stopRing();
    this.stopDial();
  }
}
