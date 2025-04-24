
// Simple in-memory TTL cache for API responses

interface CacheEntry<T> {
  value: T;
  expires: number;
}

export class MemoryCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  
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
    this.cache.set(key, {
      value: result,
      expires: now + ttlMs
    });
    
    return result;
  }
  
  // Manual set to cache
  set<T>(key: string, value: T, ttlMs: number = 60000): void {
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
}

// Singleton instance for global use
export const globalCache = new MemoryCache();
