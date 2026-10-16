/** Small LRU with an expiry per entry. `now` is a seam for tests. */
export class TtlLru<V> {
  private readonly items = new Map<string, { value: V; at: number }>();

  constructor(
    private readonly max = 100,
    private readonly ttlMs = 6 * 3600_000,
    private readonly now = Date.now,
  ) {}

  get(key: string) {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    this.items.delete(key);
    if (this.now() - hit.at > this.ttlMs) return undefined;
    this.items.set(key, hit); // most recently used goes last
    return hit.value;
  }

  set(key: string, value: V) {
    this.items.delete(key);
    this.items.set(key, { value, at: this.now() });
    if (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
  }
}
