interface Job {
  run(): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onPosition?: (position: number) => void;
  abort?: () => void;
}

/** One executing turn per profile; idle conversations never hold the queue. */
export class TurnQueue {
  private pending: Job[] = [];
  private active = false;

  run<T>(run: () => Promise<T>, options: {
    signal?: AbortSignal;
    onPosition?: (position: number) => void;
  } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      const job: Job = { run, resolve: (value) => resolve(value as T), reject, ...options };
      job.abort = () => {
        const index = this.pending.indexOf(job);
        if (index < 0) return; // Active work releases the queue only after it actually stops.
        this.pending.splice(index, 1);
        job.signal?.removeEventListener("abort", job.abort!);
        reject(new DOMException("Aborted", "AbortError"));
        this.notify();
      };
      job.signal?.addEventListener("abort", job.abort, { once: true });
      this.pending.push(job);
      this.drain();
      this.notify();
    });
  }

  private notify(): void {
    this.pending.forEach((job, index) => this.position(job, index + (this.active ? 1 : 0)));
  }

  private position(job: Job, position: number): void {
    try { job.onPosition?.(position); } catch { /* An observer cannot wedge the queue. */ }
  }

  private drain(): void {
    if (this.active) return;
    const job = this.pending.shift();
    if (!job) return;
    this.active = true;
    job.signal?.removeEventListener("abort", job.abort!);
    this.position(job, 0);
    this.notify();
    void Promise.resolve().then(() => {
      if (job.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return job.run();
    }).then(job.resolve, job.reject).finally(() => {
      this.active = false;
      this.drain();
    });
  }
}
