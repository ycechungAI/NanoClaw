export class RingBuffer<T> {
  private buffer: T[];
  private head = 0;
  private tail = 0;
  private _size = 0;

  constructor(public readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  get size(): number {
    return this._size;
  }

  isFull(): boolean {
    return this._size === this.capacity;
  }

  push(item: T): boolean {
    if (this._size === this.capacity) {
      return false; // Queue full, explicitly drop
    }
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    this._size++;
    return true;
  }

  shift(): T | undefined {
    if (this._size === 0) return undefined;
    const item = this.buffer[this.head];
    // Remove reference so it can be garbage collected
    this.buffer[this.head] = undefined as any;
    this.head = (this.head + 1) % this.capacity;
    this._size--;
    return item;
  }
}
