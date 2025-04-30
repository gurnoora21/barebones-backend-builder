
// Simple in-memory TTL cache for API responses with automatic cleanup

interface CacheEntry<T> {
  value: T;
  expires: number;
  lastAccessed: number; // Track when entries are accessed for LRU eviction
}

export class MemoryCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private maxEntries: number = 2000; // Default max entries
  private cleanupInterval: number | undefined;
  private hits: number = 0;
  private misses: number = 0;
  
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
    ttlMs: number = 60000, // Default 1min TTL
    fetchTimeout: number = 25000 // Add timeout parameter with 25s default
  ): Promise<T> {
    const now = Date.now();
    
    // Check cache first
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      // Return if not expired
      if (now < entry.expires) {
        // Update access time and increment hits counter
        entry.lastAccessed = now;
        this.hits++;
        return entry.value as T;
      }
      // Remove expired entry
      this.cache.delete(key);
    }
    
    this.misses++;
    
    // Fetch with timeout
    const fetchPromise = fetchFn();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Fetch timeout after ${fetchTimeout}ms for key: ${key}`)), fetchTimeout);
    });
    
    try {
      // Race between the fetch and timeout
      const result = await Promise.race([fetchPromise, timeoutPromise]);
      
      // Only store valid results in cache
      if (result !== undefined && result !== null) {
        this.set(key, result, ttlMs);
      }
      
      return result;
    } catch (error) {
      // Check if there's a stale value we can return as fallback
      const staleEntry = this.cache.get(key);
      if (staleEntry) {
        console.warn(`Using stale cache entry for ${key} after fetch error: ${error.message}`);
        return staleEntry.value as T;
      }
      throw error;
    }
  }
  
  // Manual set to cache
  set<T>(key: string, value: T, ttlMs: number = 60000): void {
    // If cache is at max capacity, remove oldest items before adding new one
    if (this.cache.size >= this.maxEntries) {
      this.removeOldestEntries(Math.ceil(this.maxEntries * 0.1)); // Remove 10% of oldest entries
    }
    
    this.cache.set(key, {
      value,
      expires: Date.now() + ttlMs,
      lastAccessed: Date.now()
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
    
    // Update access time
    entry.lastAccessed = Date.now();
    return true;
  }
  
  // Get a cached value (or undefined if not found/expired)
  get<T>(key: string): T | undefined {
    if (!this.has(key)) return undefined;
    const entry = this.cache.get(key)!;
    // Update access timestamp
    entry.lastAccessed = Date.now();
    this.hits++;
    return entry.value as T;
  }
  
  // Delete a cached item
  delete(key: string): boolean {
    return this.cache.delete(key);
  }
  
  // Clear entire cache
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
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
  
  // Remove oldest entries by last accessed time (LRU algorithm)
  private removeOldestEntries(count: number): void {
    if (count <= 0 || this.cache.size === 0) return;
    
    // Convert cache entries to array for sorting
    const entries = Array.from(this.cache.entries());
    
    // Sort by last accessed time (oldest first)
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    
    // Delete the oldest entries
    const toRemove = Math.min(count, entries.length);
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
  }
  
  // Get cache statistics
  getStats(): {
    size: number;
    hits: number;
    misses: number;
    hitRatio: number;
    keyCount: number;
  } {
    const totalAccesses = this.hits + this.misses;
    return {
      size: this.estimateCacheSize(),
      hits: this.hits,
      misses: this.misses,
      hitRatio: totalAccesses > 0 ? this.hits / totalAccesses : 0,
      keyCount: this.cache.size
    };
  }
  
  // Estimate the cache size in bytes (rough approximation)
  private estimateCacheSize(): number {
    let size = 0;
    for (const [key, entry] of this.cache.entries()) {
      // Key size (approximate)
      size += key.length * 2;
      
      // Entry structure overhead
      size += 24; // timestamps and reference overhead
      
      // Value size (very rough estimate)
      try {
        const valueSize = JSON.stringify(entry.value).length * 2;
        size += valueSize;
      } catch (e) {
        // If serialization fails, make a conservative estimate
        size += 1000;
      }
    }
    return size;
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

// Create two singleton instances with different settings
// One for API responses with 5 minute cleanup interval
export const globalCache = new MemoryCache({ 
  maxEntries: 5000,
  cleanupIntervalMs: 5 * 60 * 1000  // 5 minutes
});

// A smaller cache with more frequent cleanup for volatile data
export const volatileCache = new MemoryCache({
  maxEntries: 1000,
  cleanupIntervalMs: 1 * 60 * 1000  // 1 minute
});
