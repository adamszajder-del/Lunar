// In-Memory Cache — reduces DB load for rarely-changing data
// Caches: tricks catalog, articles catalog, products, achievement definitions
// TTL-based with manual invalidation support

const log = require('./logger');

class MemoryCache {
  constructor() {
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.value;
  }

  set(key, value, ttlMs = 60000) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });
  }

  invalidate(key) {
    this.store.delete(key);
  }

  invalidatePrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear() {
    this.store.clear();
  }

  stats() {
    return {
      keys: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0
        ? ((this.hits / (this.hits + this.misses)) * 100).toFixed(1) + '%'
        : '0%'
    };
  }
}

const cache = new MemoryCache();

// TTL constants
const TTL = {
  CATALOG: 5 * 60 * 1000,    // 5 min — tricks, articles, products (change rarely)
  EVENTS: 60 * 1000,          // 1 min — events (attendees change)
  CREW: 2 * 60 * 1000,        // 2 min — crew list
  NEWS: 2 * 60 * 1000,        // 2 min — news items
  ACHIEVEMENTS_DEF: 10 * 60 * 1000, // 10 min — achievement definitions (almost never change)
};

module.exports = { cache, TTL };
