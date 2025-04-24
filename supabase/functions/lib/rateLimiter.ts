import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';

export interface RateLimitOptions {
  key: string;       // Unique identifier for this rate limit (e.g. "spotify-api")
  maxRequests: number; // Maximum requests in window
  windowMs: number;  // Window size in milliseconds
}

export class RateLimiter {
  private supabase: SupabaseClient<Database>;
  
  constructor(supabaseClient: SupabaseClient<Database>) {
    this.supabase = supabaseClient;
  }
  
  // Enhanced canProceed with more robust concurrency handling
  async canProceed(opts: RateLimitOptions): Promise<boolean> {
    const now = Date.now();
    const windowEnd = now + opts.windowMs;
    
    try {
      const { data: limitRecord, error } = await this.supabase
        .from('rate_limits')
        .select('*')
        .eq('key', opts.key)
        .maybeSingle();
      
      if (error) {
        console.error(`Rate limit check error for ${opts.key}:`, error);
        return true; // Fail open with detailed logging
      }
      
      // If no record or window expired, create/reset
      if (!limitRecord || now > (limitRecord.window_end as number)) {
        await this.supabase
          .from('rate_limits')
          .upsert({
            key: opts.key,
            count: 1, 
            window_end: windowEnd
          });
        return true;
      }
      
      // More granular rate limit handling
      const currentCount = limitRecord.count as number;
      const remainingRequests = opts.maxRequests - currentCount;
      
      if (remainingRequests > 0) {
        await this.supabase
          .from('rate_limits')
          .update({ count: currentCount + 1 })
          .eq('key', opts.key);
        return true;
      }
      
      // Log when rate limit is reached
      console.warn(`Rate limit exceeded for ${opts.key}. 
        Max: ${opts.maxRequests}, Current: ${currentCount}`);
      return false;
    } catch (err) {
      console.error('Unexpected error in rate limiter:', err);
      return true; // Always fail open to prevent total service disruption
    }
  }
  
  // Increment usage count for a key
  async increment(key: string): Promise<void> {
    const { error, data } = await this.supabase
      .from('rate_limits')
      .select('count')
      .eq('key', key)
      .single();
      
    if (!error && data) {
      await this.supabase
        .from('rate_limits')
        .update({ count: (data.count as number) + 1 })
        .eq('key', key);
    }
  }
  
  // Reset a rate limit window (useful for handling API reset headers)
  async reset(key: string, windowEnd?: number): Promise<void> {
    await this.supabase
      .from('rate_limits')
      .update({ 
        count: 0,
        window_end: windowEnd || Date.now() + 60 * 1000 // Default 1min
      })
      .eq('key', key);
  }
}
