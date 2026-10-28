// 树缓存三态（§5.0.7）：fresh（可信任）/ dirty（动作后待重取）/ void（必须重 dump）
// TTL 4000ms（§17 拍板）；动作置脏（§5.0.6 R1）；失败回退强制 void
export const CACHE_TTL_MS = 4000;

export class TreeCache {
  #entry = null;
  #state = 'void';
  #ttlMs;
  #now;
  #stats = { dumps: 0, hits: 0, misses: 0, dirtyResets: 0 };

  constructor({ ttlMs = CACHE_TTL_MS, now = Date.now } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get state() {
    if (this.#state !== 'void' && this.#entry && this.#now() - this.#entry.ts > this.#ttlMs) this.#toVoid();
    return this.#state;
  }

  // 仅 fresh 态返回条目
  peek() {
    return this.state === 'fresh' ? this.#entry : null;
  }

  set({ nodes, hash }) {
    this.#entry = { nodes, hash, ts: this.#now() };
    this.#state = 'fresh';
  }

  // 动作后置脏；fresh → dirty 记一次 dirtyResets
  markDirty() {
    if (this.state === 'fresh') this.#stats.dirtyResets++;
    if (this.#state !== 'void') this.#state = 'dirty';
  }

  invalidate() {
    this.#toVoid();
  }

  recordHit() { this.#stats.hits++; }
  recordMiss() { this.#stats.misses++; }
  recordDump() { this.#stats.dumps++; }

  stats() {
    return { ...this.#stats };
  }

  #toVoid() {
    this.#entry = null;
    this.#state = 'void';
  }
}
