
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';

export interface RateLimitOptions {
  key: string;       // Unique identifier for this rate limit (e.g. "spotify-api")
  maxRequests: number; // Maximum requests in window
  windowMs: number;  // Window size in milliseconds
  retryCount?: number; // Optional retry count to enable progressive backoff
}

export class RateLimiter {
  private supabase: SupabaseClient<Database>;
  
  constructor(supabaseClient: SupabaseClient<Database>) {
    this.supabase = supabaseClient;
  }
  
  // Enhanced canProceed with more robust concurrency handling and progressive backoff
  async canProceed(opts: RateLimitOptions): Promise<boolean> {
    const now = Date.now();
    const windowEnd = now + opts.windowMs;
    
    try {
      // Start by checking if we have an entry for this key
      const { data: limitRecord, error } = await this.supabase
        .from('rate_limits')
        .select('*')
        .eq('key', opts.key)
        .maybeSingle();
      
      if (error) {
        console.error(`Rate limit check error for ${opts.key}:`, error);
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
        console.log(`Progressive backoff for ${opts.key}: window increased to ${adjustedWindow}ms (retry: ${opts.retryCount})`);
      }
      
      // If no record or window expired, create/reset
      if (!limitRecord || now > (limitRecord.window_end as number)) {
        await this.supabase
          .from('rate_limits')
          .upsert({
            key: opts.key,
            count: 1, 
            window_end: now + adjustedWindow,
            metadata: {
              max_requests: opts.maxRequests,
              initial_window_ms: opts.windowMs,
              adjusted_window_ms: adjustedWindow,
              last_reset: new Date().toISOString()
            }
          });
          
        await this.logRateLimitEvent(opts.key, 'reset', {
          count: 1,
          window_ms: adjustedWindow,
          timestamp: new Date().toISOString()
        });
        return true;
      }
      
      // More granular rate limit handling
      const currentCount = limitRecord.count as number;
      const remainingRequests = opts.maxRequests - currentCount;
      
      if (remainingRequests > 0) {
        await this.supabase
          .from('rate_limits')
          .update({ 
            count: currentCount + 1,
            metadata: {
              ...(limitRecord.metadata as any || {}),
              last_updated: new Date().toISOString(),
              remaining: remainingRequests - 1
            }
          })
          .eq('key', opts.key);
          
        await this.logRateLimitEvent(opts.key, 'increment', {
          count: currentCount + 1,
          remaining: remainingRequests - 1,
          timestamp: new Date().toISOString()
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
      
      console.warn(`Rate limit exceeded for ${opts.key}. 
        Max: ${opts.maxRequests}, Current: ${currentCount}, 
        Window ends: ${new Date(limitRecord.window_end as number).toISOString()}`);
      return false;
    } catch (err) {
      console.error('Unexpected error in rate limiter:', err);
      return true; // Always fail open to prevent total service disruption
    }
  }
  
  // Increment usage count for a key
  async increment(key: string): Promise<void> {
    try {
      const { error, data } = await this.supabase
        .from('rate_limits')
        .select('count, metadata')
        .eq('key', key)
        .single();
        
      if (!error && data) {
        const metadata = data.metadata as any || {};
        await this.supabase
          .from('rate_limits')
          .update({ 
            count: (data.count as number) + 1,
            metadata: {
              ...metadata,
              last_updated: new Date().toISOString(),
              remaining: metadata.max_requests ? (metadata.max_requests - ((data.count as number) + 1)) : undefined
            }
          })
          .eq('key', key);
          
        await this.logRateLimitEvent(key, 'increment', {
          count: (data.count as number) + 1,
          timestamp: new Date().toISOString()
        });
      }
    } catch (err) {
      console.error('Error incrementing rate limit count:', err);
    }
  }
  
  // Reset a rate limit window (useful for handling API reset headers)
  async reset(key: string, windowEnd?: number): Promise<void> {
    try {
      await this.supabase
        .from('rate_limits')
        .update({ 
          count: 0,
          window_end: windowEnd || Date.now() + 60 * 1000, // Default 1min
          metadata: {
            last_reset: new Date().toISOString()
          }
        })
        .eq('key', key);
        
      await this.logRateLimitEvent(key, 'reset', {
        window_end: new Date(windowEnd || Date.now() + 60 * 1000).toISOString(),
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error('Error resetting rate limit:', err);
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
      console.error('Failed to log rate limit event:', err);
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
      console.error('Error checking remaining capacity:', err);
      return { remaining: 1, resetAt: null }; // Conservative default
    }
  }
}
