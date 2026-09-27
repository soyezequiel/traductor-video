/** Delivery measurements exclude the first clip (model startup is a one-off cost). */
export class BufferPlanner {
  private lastReady = 0;
  private lastAt = 0;
  private rate: number | null = null;
  private samples = 0;
  private stalls = 0;
  targetMs = 10000;

  reset(): void {
    this.lastReady = this.lastAt = this.samples = this.stalls = 0;
    this.rate = null;
    this.targetMs = 10000;
  }

  observe(ready: number, now: number, speed: number, waiting: boolean): void {
    if (ready <= this.lastReady) return;
    if (this.lastAt && now - this.lastAt >= 250) {
      const measured = Math.min(8, (ready - this.lastReady) / (now - this.lastAt));
      this.rate = this.rate === null ? measured : this.rate * 0.65 + measured * 0.35;
      this.samples += 1;
      if (waiting) this.targetMs = this.target(speed);
    }
    this.lastAt = now;
    this.lastReady = ready;
  }

  private target(speed: number): number {
    const reserve = this.rate === null ? 10 : this.rate >= speed * 1.25 ? 8 :
      this.rate >= speed ? 12 : 24;
    return Math.min(30000, (reserve + this.stalls * 4) * 1000 * speed);
  }

  rebuffer(speed: number): void {
    this.stalls = Math.min(3, this.stalls + 1);
    this.targetMs = this.target(speed);
  }

  estimate(remainingMs: number, now: number): number | null {
    // Never count down to a fictional zero if a clip stops arriving.
    if (!this.rate || this.samples < 1 || now - this.lastAt > 15000) return null;
    return Math.max(1, Math.ceil(remainingMs / this.rate / 1000));
  }
}
