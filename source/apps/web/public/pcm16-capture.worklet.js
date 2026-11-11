/**
 * Downsample the player's audio to 16 kHz signed 16-bit PCM for Soniox.
 *
 * Shipped as a real file rather than a Blob URL on purpose: a blob: worklet is
 * refused outright under a script-src CSP, and this app is served from a host that
 * has one.
 *
 * A stall empties the input. We still emit 16 kHz silence so the ASR session does
 * not time out; when the picture resumes, speech is already flowing on the same
 * socket.
 */
class PCM16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inBuf = new Float32Array(0);
    this.out = new Int16Array(1600); // 100 ms at 16 kHz
    this.outLen = 0;
    this.pos = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    const n = ch ? ch.length : 128;
    const merged = new Float32Array(this.inBuf.length + n);
    merged.set(this.inBuf);
    if (ch) merged.set(ch, this.inBuf.length);
    this.inBuf = merged;

    // Linear resample from the context rate down to 16 kHz.
    const step = sampleRate / 16000;
    while (this.pos + 1 < this.inBuf.length) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      let s = this.inBuf[i] * (1 - f) + this.inBuf[i + 1] * f;
      s = Math.max(-1, Math.min(1, s));
      this.out[this.outLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.pos += step;
      if (this.outLen === 1600) {
        const b = this.out.slice(0);
        this.port.postMessage(b.buffer, [b.buffer]);
        this.outLen = 0;
      }
    }
    const keep = Math.floor(this.pos);
    if (keep > 0) {
      this.inBuf = this.inBuf.slice(keep);
      this.pos -= keep;
    }
    return true;
  }
}
registerProcessor('pcm16-capture', PCM16Capture);
