
// Simple in-memory TTL cache for API responses with automatic cleanup

interface CacheEntry<T> {
  value: T;
  expires: number;
}

export class MemoryCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private maxEntries: number = 2000; // Default max entries
  private cleanupInterval: number | undefined;
  
  constructor(options?: { maxEntries?: number; cleanupIntervalMs?: number }) {
    this.maxEntries = options?.maxEntries || 2000;
    
    // Set up automatic cleanup interval if specified
    if (options?.cleanupIntervalMs) {
      this.cleanupInterval = setInterval(() => {
        this.removeExpiredEntries();
      }, options.cleanupIntervalMs);
    }
  }
  
  // Get a cached item or fetch it using the provided function
  async getOrFetch<T>(
    key: string, 
    fetchFn: () => Promise<T>, 
    ttlMs: number = 60000 // Default 1min TTL
  ): Promise<T> {
    const now = Date.now();
    
    // Check cache first
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      // Return if not expired
      if (now < entry.expires) {
        return entry.value as T;
      }
      // Remove expired entry
      this.cache.delete(key);
    }
    
    // Fetch fresh data
    const result = await fetchFn();
    
    // Store in cache
    this.set(key, result, ttlMs);
    
    return result;
  }
  
  // Manual set to cache
  set<T>(key: string, value: T, ttlMs: number = 60000): void {
    // If cache is at max capacity, remove oldest items before adding new one
    if (this.cache.size >= this.maxEntries) {
      this.removeOldestEntries(Math.ceil(this.maxEntries * 0.1)); // Remove 10% of oldest entries
    }
    
    this.cache.set(key, {
      value,
      expires: Date.now() + ttlMs
    });
  }
  
  // Check if key exists and is not expired
  has(key: string): boolean {
    if (!this.cache.has(key)) return false;
    
    const entry = this.cache.get(key)!;
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }
  
  // Get a cached value (or undefined if not found/expired)
  get<T>(key: string): T | undefined {
    if (!this.has(key)) return undefined;
    return this.cache.get(key)!.value as T;
  }
  
  // Delete a cached item
  delete(key: string): boolean {
    return this.cache.delete(key);
  }
  
  // Clear entire cache
  clear(): void {
    this.cache.clear();
  }
  
  // Get all keys matching a prefix
  getKeysByPrefix(prefix: string): string[] {
    return Array.from(this.cache.keys())
      .filter(key => key.startsWith(prefix));
  }
  
  // Delete all keys with a prefix
  deleteByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.getKeysByPrefix(prefix)) {
      if (this.cache.delete(key)) count++;
    }
    return count;
  }
  
  // Remove all expired entries
  removeExpiredEntries(): number {
    const now = Date.now();
    let removed = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expires) {
        this.cache.delete(key);
        removed++;
      }
    }
    
    return removed;
  }
  
  // Remove oldest entries by access time
  private removeOldestEntries(count: number): void {
    if (count <= 0 || this.cache.size === 0) return;
    
    // Convert cache entries to array for sorting
    const entries = Array.from(this.cache.entries());
    
    // Sort by expiration time (oldest first)
    entries.sort((a, b) => a[1].expires - b[1].expires);
    
    // Delete the oldest entries
    const toRemove = Math.min(count, entries.length);
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
  }
  
  // Get current cache size
  get size(): number {
    return this.cache.size;
  }
  
  // Cleanup resources when no longer needed
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Singleton instance for global use with automatic cleanup every 5 minutes
export const globalCache = new MemoryCache({ 
  maxEntries: 5000,
  cleanupIntervalMs: 5 * 60 * 1000  // 5 minutes
});
