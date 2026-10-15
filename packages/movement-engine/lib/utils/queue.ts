import EventEmitter from "node:events";

type Worker<Response, T extends () => Promise<Response>> = {
  job: T;
  resolve?: (value: Response) => unknown;
  reject?: (error: Error) => unknown;
};

class Queue<
  Response,
  Job extends () => Promise<Response> = () => Promise<Response>,
> extends EventEmitter {
  concurrency: number;
  currentWorkers: Map<Worker<Response, Job>, true> = new Map();
  queuedWorkers: Worker<Response, Job>[] = [];

  constructor({ concurrency }: { concurrency: number }) {
    super();
    this.concurrency = concurrency;
    // https://nodejs.org/api/events.html#error-events
    // node throws by default if no error listener is registered
    // we don't want this behavior as the event emission is secondary
    // to the primary error handling mechanism of promises
    this.on('error', () => {});
  }

  clear() {
    this.currentWorkers.clear();
    this.queuedWorkers = [];
    this.emit('empty');
  }

  async enqueue(job: Job) {
    return new Promise<Response>((resolve, reject) => {
      this.queuedWorkers.push({ job, resolve, reject });
      this.emit('enqueue', job);
      this.tryRun();
    });
  }

  complete(worker: Worker<Response, Job>) {
    this.currentWorkers.delete(worker);
    this.emit('complete', worker.job);
    this.tryRun();
  }

  tryRun() {
    if (!this.queuedWorkers.length && !this.currentWorkers.size) {
      this.emit('empty');
    }

    if (this.currentWorkers.size < this.concurrency) {
      const worker = this.queuedWorkers.shift();
      if (worker) {
        this.currentWorkers.set(worker, true);
        worker
          .job()
          .then((response) => {
            worker.resolve?.(response);
          })
          .catch((error) => {
            this.emit('error', { error, job: worker.job });
            worker.reject?.(error);
          })
          .finally(() => this.complete(worker));
      }
    }
  }

  waitUntilEmpty() {
    return new Promise<void>((resolve) => {
      if (!this.queuedWorkers.length && !this.currentWorkers.size) {
        resolve();
      } else {
        this.once('empty', () => {
          resolve();
        });
      }
    });
  }
}

export { Queue };
