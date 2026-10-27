export class VideoProgress {
  private buffer = "";
  constructor(readonly duration: number, readonly emit: (fraction: number) => void) {}
  push(chunk: string) {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (line === "progress=end") this.emit(1);
      else if (line.startsWith("out_time_us=")) {
        const time = Number(line.slice(12));
        if (Number.isFinite(time) && this.duration > 0)
          this.emit(Math.max(0, Math.min(1, time / 1e6 / this.duration)));
      }
    }
    if (this.buffer.length > 4096) this.buffer = "";
  }
}
