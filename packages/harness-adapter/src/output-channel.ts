export class HarnessOutputChannel<T> {
  readonly outputs: AsyncIterable<T>;
  #consumerCreated = false;
  #ended = false;
  #pending: Array<(result: IteratorResult<T>) => void> = [];
  #values: T[] = [];
  #overflowError: Error | null = null;
  readonly #maxBufferedValues: number;

  constructor(options: { maxBufferedValues?: number } = {}) {
    const maxBufferedValues = options.maxBufferedValues ?? 256;
    if (!Number.isSafeInteger(maxBufferedValues) || maxBufferedValues <= 0) {
      throw new Error("Harness output buffer limit must be a positive safe integer");
    }
    this.#maxBufferedValues = maxBufferedValues;
    this.outputs = {
      [Symbol.asyncIterator]: () => {
        if (this.#consumerCreated) {
          throw new Error("Harness outputs allow only one consumer");
        }
        this.#consumerCreated = true;
        return {
          next: () => this.#next(),
        };
      },
    };
  }

  emit(value: T): boolean {
    if (this.#ended || this.#overflowError) return false;
    const resolve = this.#pending.shift();
    if (resolve) resolve({ done: false, value });
    else if (this.#values.length < this.#maxBufferedValues) this.#values.push(value);
    else {
      // A producer must never be allowed to turn a slow Desktop/Host consumer
      // into an unbounded heap. Drop the retained backlog and make the single
      // consumer fail explicitly; the owning runtime can then terminalize the
      // active Turn with a visible error instead of silently losing output.
      this.#overflowError = new Error(
        `Harness output buffer exceeded ${this.#maxBufferedValues} values`,
      );
      this.#values = [];
      this.#ended = true;
      return false;
    }
    return true;
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#values.length !== 0) return;
    for (const resolve of this.#pending.splice(0)) resolve({ done: true, value: undefined });
  }

  #next(): Promise<IteratorResult<T>> {
    if (this.#overflowError) return Promise.reject(this.#overflowError);
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#pending.push(resolve));
  }
}
