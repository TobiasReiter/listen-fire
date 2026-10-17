// Questions on the terminal for `lf connect` and `lf credential`. Answers are
// read a line at a time, so a script (or a test) can pipe them in; on a
// terminal a secret's answer is not echoed.

import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';

export interface Ask {
  /** Shown after the question when the answer may be left empty. */
  default?: string;
  /** Not echoed on a terminal. */
  secret?: boolean;
  /** An empty answer is accepted (as the default, else ''). */
  optional?: boolean;
}

export interface Prompter {
  ask(question: string, options?: Ask): Promise<string>;
  /** A line of progress, between questions. */
  print(line: string): void;
  close(): void;
}

export function terminalPrompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Prompter {
  let muted = false;
  const echo = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const terminal = 'isTTY' in input && input.isTTY === true;
  const lines: Interface = createInterface({ input, output: echo, terminal });
  const queued: string[] = [];
  const waiting: { resolve(line: string): void; reject(error: Error): void }[] = [];
  let ended = false;
  lines.on('line', (line) => {
    const next = waiting.shift();
    if (next !== undefined) next.resolve(line);
    else queued.push(line);
  });
  lines.on('close', () => {
    ended = true;
    for (const next of waiting.splice(0)) next.reject(new Error('the input ended before every question was answered'));
  });
  const nextLine = (): Promise<string> => {
    const line = queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (ended) return Promise.reject(new Error('the input ended before every question was answered'));
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  return {
    async ask(question, options = {}) {
      for (;;) {
        const hint = options.default !== undefined ? ` [${options.secret === true ? 'enter keeps the current one' : options.default}]` : options.optional === true ? ' [optional]' : '';
        output.write(`${question}${hint}: `);
        muted = terminal && options.secret === true;
        let answer: string;
        try {
          answer = (await nextLine()).trim();
        } finally {
          if (muted) output.write('\n');
          muted = false;
        }
        if (!terminal) output.write('\n');
        if (answer !== '') return answer;
        if (options.default !== undefined) return options.default;
        if (options.optional === true) return '';
        output.write('an answer is needed\n');
      }
    },
    print(line) {
      output.write(`${line}\n`);
    },
    close() {
      lines.close();
    },
  };
}
