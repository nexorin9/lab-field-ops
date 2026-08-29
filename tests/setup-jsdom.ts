// tests/setup-jsdom.ts
// 在 jsdom 25 + vitest 2.1 组合下，window.localStorage 存在但访问为 undefined；
// 这里挂一个 in-memory polyfill，使 globalThis.localStorage 与 window.localStorage 都可用。

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

const polyfill = new MemoryStorage();

// 覆盖 window.localStorage（jsdom 25 在该版本下访问返回 undefined）
try {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: polyfill,
  });
} catch {
  /* ignore */
}

// 同时挂到 globalThis，确保 store.ts 里 `globalThis.localStorage` 也能拿到
try {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: polyfill,
  });
} catch {
  /* ignore */
}

export {};
