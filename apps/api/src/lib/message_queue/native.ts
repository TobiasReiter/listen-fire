import { EventEmitter } from 'node:events';
import { nextTick } from 'node:process';

import { Queue } from 'movement-engine/public/queue';
import { PassThrough } from '../utils/stream';

type NodeOptions<T> =
  | {
      type: 'queue';
    }
  | {
      type: 'fanout';
    }
  | {
      type: 'direct';
      key:
        | (keyof T & string)
        | ((message: T) => Promise<string[] | string | null> | string[] | string | null);
      keyPrefix?: string;
    };

type NodeSpecification<T> = {
  name: string;
  match?: (message: T) => Promise<boolean> | boolean;
} & NodeOptions<T>;

type NodeProps<T> = {
  name: string;
  options: NodeOptions<T>;
  match?: (message: T) => Promise<boolean> | boolean;
};

class Node<T> extends EventEmitter {
  readonly sources: Map<string, Node<T>> = new Map();
  readonly destinations: Map<string, Node<T>> = new Map();
  readonly name: string;
  readonly options: NodeOptions<T>;
  readonly match?: (message: T) => Promise<boolean> | boolean;
  readonly queue = new Queue({ concurrency: 8 });

  constructor({ name, options, match }: NodeProps<T>) {
    super();
    this.name = name;
    this.options = options;
    this.match = match;
    this.setMaxListeners(Infinity);
  }

  asStream() {
    const rs = new PassThrough<T>({ objectMode: true });

    this.on('message', (message) => {
      rs.push(message);
    });

    return rs;
  }

  attachTo(source: Node<T>) {
    if (source === this) {
      throw new Error(`Node ${this.name} cannot attach to itself`);
    }

    source.destinations.set(this.name, this);
    this.sources.set(source.name, source);
    return this;
  }

  detachFrom(source: Node<T>) {
    const existing = this.sources.get(source.name);

    if (!existing) {
      throw new Error(`Node ${this.name} is not attached to ${source.name}`);
    }

    this.sources.delete(source.name);
    existing.destinations.delete(this.name);
    return this;
  }

  destroy() {
    for (const source of this.sources.values()) {
      source.destinations.delete(this.name);
    }

    for (const destination of this.destinations.values()) {
      destination.sources.delete(this.name);
    }

    this.sources.clear();
    this.destinations.clear();
    this.emit('destroyed');
  }

  emit(event: 'message', message: T): boolean;
  emit(event: 'destroyed', message?: undefined): boolean;
  emit<Ev extends 'message' | 'destroyed'>(
    event: Ev,
    message: Ev extends 'message' ? T : undefined,
  ): boolean {
    return super.emit(event, message);
  }

  on<Ev extends 'message' | 'destroyed'>(
    event: Ev,
    listener: Ev extends 'message' ? (message: T) => void : () => void,
  ): this {
    return super.on(event, listener);
  }

  once<Ev extends 'message' | 'destroyed'>(
    event: Ev,
    listener: Ev extends 'message' ? (message: T) => void : () => void,
  ): this {
    return super.once(event, listener);
  }

  async publish(message: T) {
    this.emit('message', message);
    switch (this.options.type) {
      case 'queue': {
        break;
      }
      case 'fanout': {
        for (const destination of this.destinations.values()) {
          this.queue
            .enqueue(async () => {
              if (!destination.match || (await destination.match(message))) {
                await destination.publish(message);
              }
              await new Promise((resolve) => nextTick(resolve));
            })
            .catch(console.error);
        }
        break;
      }
      case 'direct': {
        const rawValue =
          typeof this.options.key === 'string'
            ? message[this.options.key]
            : await this.options.key(message);

        if (rawValue === null) {
          break;
        }

        const values = Array.isArray(rawValue) ? rawValue : [rawValue];

        for (const value of values) {
          if (typeof value !== 'string') {
            throw new Error(
              `Direct exchange ${this.name} key is not a string (got ${typeof value})`,
            );
          }

          const destination = this.destinations.get(`${this.options.keyPrefix ?? ''}${value}`);
          if (!destination) {
            continue;
          }
          this.queue
            .enqueue(async () => {
              if (!destination.match || (await destination.match(message))) {
                await destination.publish(message);
              }
              await new Promise((resolve) => nextTick(resolve));
            })
            .catch(console.error);
        }

        break;
      }
      default: {
        throw new Error(`Unknown exchange type ${(this.options as { type: unknown }).type}`);
      }
    }
  }
}

class MQ<T> {
  private nodes: Map<string, Node<T>> = new Map();

  setPresets<N extends Record<string, NodeSpecification<T>>>(presetNodes: N) {
    for (const [name, spec] of Object.entries(presetNodes)) {
      const node = this.node(spec);
      this.nodes.set(name, node);
      Object.defineProperty(this, name, {
        get() {
          return node;
        },
      });
    }

    return this as MQ<T> & { [K in keyof N]: Node<T> };
  }

  node(spec: NodeSpecification<T>) {
    return this.getOrCreateNode(spec);
  }

  getOrCreateNode({ name, match, ...options }: NodeSpecification<T>) {
    let queue = this.nodes.get(name);

    if (!queue) {
      queue = new Node({
        name,
        options,
        match,
      });
      queue.on('destroyed', () => {
        this.nodes.delete(name);
      });
      this.nodes.set(name, queue);
    }

    return queue;
  }

  getNode(name: string) {
    const existing = this.nodes.get(name);

    if (!existing) {
      throw new Error(`Node ${name} does not exist`);
    }

    return existing;
  }

  find(name: string) {
    return this.nodes.get(name);
  }

  set(name: string, value: Node<T>) {
    this.nodes.set(name, value);
  }

  delete(name: string) {
    this.nodes.delete(name);
  }

  deleteAll() {
    this.nodes.clear();
  }
}

export { MQ };
