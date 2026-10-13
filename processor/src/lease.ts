import { performance } from "node:perf_hooks";
export type Clock = { mono: () => number; wall: () => number };
export const clock: Clock = {
  mono: () => performance.now(),
  wall: () => Date.now(),
};
export class LeaseClock {
  pending = new Map<string, { mono: number; wall: number }>();
  monoDeadline = 0;
  wallDeadline = 0;
  lastWall = 0;
  granted = false;
  constructor(readonly time: Clock = clock) {}
  sent(id: string) {
    if (!this.pending.has(id))
      this.pending.set(id, { mono: this.time.mono(), wall: this.time.wall() });
    while (this.pending.size > 128)
      this.pending.delete(this.pending.keys().next().value!);
  }
  grant(id: string, seconds: number, safety: number) {
    const sent = this.pending.get(id);
    if (!sent) return false;
    const ms = (seconds - safety) * 1000;
    const mono = sent.mono + ms,
      wall = sent.wall + ms;
    if (
      this.time.mono() >= mono ||
      this.time.wall() >= wall ||
      this.time.wall() < sent.wall - 1000
    )
      return false;
    if (this.granted && !this.valid()) return false;
    this.monoDeadline = Math.max(this.monoDeadline, mono);
    this.wallDeadline = Math.max(this.wallDeadline, wall);
    this.lastWall = this.time.wall();
    this.granted = true;
    return true;
  }
  valid() {
    const wall = this.time.wall();
    const valid =
      this.granted &&
      this.time.mono() < this.monoDeadline &&
      wall < this.wallDeadline &&
      wall >= this.lastWall - 1000;
    this.lastWall = Math.max(this.lastWall, wall);
    return valid;
  }
  remaining() {
    return Math.max(
      0,
      Math.min(
        this.monoDeadline - this.time.mono(),
        this.wallDeadline - this.time.wall(),
      ),
    );
  }
}
