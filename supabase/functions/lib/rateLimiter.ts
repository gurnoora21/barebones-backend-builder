
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';
import { logger } from './logger.ts';
import { wait, withRetry } from './retry.ts';

export interface RateLimitOptions {
  key: string;       // Unique identifier for this rate limit (e.g. "spotify-api")
  maxRequests: number; // Maximum requests in window
  windowMs: number;  // Window size in milliseconds
  retryCount?: number; // Optional retry count to enable progressive backoff
}

export class RateLimiter {
  private supabase: SupabaseClient<Database>;
  private logger = logger.child({ component: 'RateLimiter' });
  
  constructor(supabaseClient: SupabaseClient<Database>) {
    this.supabase = supabaseClient;
  }
  
  // Enhanced canProceed with more robust concurrency handling and progressive backoff
  async canProceed(opts: RateLimitOptions): Promise<boolean> {
    const now = Date.now();
    const windowEnd = now + opts.windowMs;
    const logContext = { key: opts.key, maxRequests: opts.maxRequests };
    
    try {
      // Add retries for database operations
      return await withRetry(async () => {
        // Start by checking if we have an entry for this key
        const { data: limitRecord, error } = await this.supabase
          .from('rate_limits')
          .select('*')
          .eq('key', opts.key)
          .maybeSingle();
        
        if (error) {
          this.logger.error(`Rate limit check error for ${opts.key}:`, error, logContext);
          
          await this.logRateLimitEvent(opts.key, 'error', {
            error: error.message,
            timestamp: new Date().toISOString()
          });
          
          return true; // Fail open with detailed logging
        }
        
        // Progressive backoff logic
        let adjustedWindow = opts.windowMs;
        if (opts.retryCount && opts.retryCount > 0) {
          // Exponential backoff - doubles window size for each retry
          adjustedWindow = opts.windowMs * Math.pow(2, Math.min(opts.retryCount, 5));
          this.logger.info(`Progressive backoff for ${opts.key}`, {
            ...logContext,
            window: adjustedWindow,
            retryCount: opts.retryCount
          });
        }
        
        // If no record or window expired, create/reset
        if (!limitRecord || now > (limitRecord.window_end as number)) {
          // Use atomic database function to avoid race conditions
          const { error: atomicError } = await this.supabase.rpc('atomic_reset_counter', {
            counter_key: opts.key,
            new_window_end: now + adjustedWindow
          });
          
          if (atomicError) {
            this.logger.error(`Error resetting rate limit counter`, atomicError, logContext);
          }
          
          await this.logRateLimitEvent(opts.key, 'reset', {
            count: 1,
            window_ms: adjustedWindow,
            timestamp: new Date().toISOString()
          });
          
          this.logger.debug(`Rate limit reset for ${opts.key}`, {
            ...logContext,
            windowEnd: new Date(now + adjustedWindow).toISOString()
          });
          
          return true;
        }
        
        // More granular rate limit handling
        const currentCount = limitRecord.count as number;
        const remainingRequests = opts.maxRequests - currentCount;
        
        if (remainingRequests > 0) {
          // Use atomic increment to avoid race conditions
          const { data: newCount, error: incrementError } = await this.supabase.rpc('atomic_increment', {
            counter_key: opts.key,
            increment_by: 1,
            metadata: {
              max_requests: opts.maxRequests,
              last_updated: new Date().toISOString(),
              remaining: remainingRequests - 1
            }
          });
          
          if (incrementError) {
            this.logger.error(`Error incrementing rate limit counter`, incrementError, logContext);
          }
          
          await this.logRateLimitEvent(opts.key, 'increment', {
            count: currentCount + 1,
            remaining: remainingRequests - 1,
            timestamp: new Date().toISOString()
          });
          
          this.logger.debug(`Rate limit incremented for ${opts.key}`, {
            ...logContext,
            count: currentCount + 1,
            remaining: remainingRequests - 1
          });
          
          return true;
        }
        
        // Rate limit exceeded - log the event
        await this.logRateLimitEvent(opts.key, 'exceeded', {
          max: opts.maxRequests,
          current: currentCount,
          window_end: new Date(limitRecord.window_end as number).toISOString(),
          retry_count: opts.retryCount || 0,
          timestamp: new Date().toISOString()
        });
        
        this.logger.warn(`Rate limit exceeded for ${opts.key}`, {
          ...logContext,
          current: currentCount,
          windowEnd: new Date(limitRecord.window_end as number).toISOString()
        });
        
        return false;
      }, {
        maxAttempts: 3,
        initialDelayMs: 100
      });
    } catch (err) {
      this.logger.error('Unexpected error in rate limiter:', err, logContext);
      return true; // Always fail open to prevent total service disruption
    }
  }
  
  // Increment usage count for a key
  async increment(key: string): Promise<void> {
    try {
      // Use atomic increment to avoid race conditions
      const { error } = await this.supabase.rpc('atomic_increment', {
        counter_key: key,
        increment_by: 1
      });
      
      if (error) {
        this.logger.error(`Error incrementing rate limit count for ${key}:`, error);
        return;
      }
      
      await this.logRateLimitEvent(key, 'increment', {
        timestamp: new Date().toISOString()
      });
      
    } catch (err) {
      this.logger.error(`Error incrementing rate limit count for ${key}:`, err);
    }
  }
  
  // Reset a rate limit window (useful for handling API reset headers)
  async reset(key: string, windowEnd?: number): Promise<void> {
    try {
      // Use atomic reset function to avoid race conditions
      const { error } = await this.supabase.rpc('atomic_reset_counter', {
        counter_key: key,
        new_window_end: windowEnd || Date.now() + 60000 // Default 1min
      });
      
      if (error) {
        this.logger.error(`Error resetting rate limit for ${key}:`, error);
        return;
      }
      
      await this.logRateLimitEvent(key, 'reset', {
        window_end: new Date(windowEnd || Date.now() + 60000).toISOString(),
        timestamp: new Date().toISOString()
      });
      
      this.logger.debug(`Rate limit reset for ${key}`, {
        windowEnd: new Date(windowEnd || Date.now() + 60000).toISOString()
      });
    } catch (err) {
      this.logger.error(`Error resetting rate limit for ${key}:`, err);
    }
  }
  
  // Log rate limit events for monitoring
  private async logRateLimitEvent(key: string, event: string, details: any): Promise<void> {
    try {
      await this.supabase
        .from('rate_limit_events')
        .insert({
          key,
          event,
          details,
          created_at: new Date().toISOString()
        });
    } catch (err) {
      // Don't fail if logging fails
      this.logger.error('Failed to log rate limit event:', err);
    }
  }
  
  // Check remaining capacity for a rate limit
  async getRemainingCapacity(key: string): Promise<{ remaining: number, resetAt: Date | null }> {
    try {
      const { data, error } = await this.supabase
        .from('rate_limits')
        .select('count, window_end, metadata')
        .eq('key', key)
        .maybeSingle();
        
      if (error || !data) {
        return { remaining: Infinity, resetAt: null }; // No limit found
      }
      
      const metadata = data.metadata as any || {};
      const maxRequests = metadata.max_requests || 100; // Default if not specified
      const remaining = Math.max(0, maxRequests - (data.count as number));
      const resetAt = new Date(data.window_end as number);
      
      return { remaining, resetAt };
    } catch (err) {
      this.logger.error('Error checking remaining capacity:', err);
      return { remaining: 1, resetAt: null }; // Conservative default
    }
  }
}
