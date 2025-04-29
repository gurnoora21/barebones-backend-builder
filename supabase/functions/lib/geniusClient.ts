
import { CircuitBreakerRegistry } from './circuitBreaker.ts';
import { globalCache } from './cache.ts';
import { RateLimiter } from './rateLimiter.ts';
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';
import { logger } from './logger.ts';
import { withRateLimitedRetry } from './retry.ts';

/**
 * Interface for Genius API search results
 */
export interface GeniusSearchResult {
  meta: {
    status: number;
  };
  response: {
    hits: Array<{
      result: {
        id: number;
        title: string;
        primary_artist: {
          id: number;
          name: string;
          image_url?: string;
        };
      };
    }>;
  };
}

/**
 * Interface for Genius song details response
 */
export interface GeniusSongResult {
  meta: {
    status: number;
  };
  response: {
    song: {
      id: number;
      title: string;
      primary_artist: {
        id: number;
        name: string;
        image_url?: string;
      };
      producer_artists?: Array<{
        id: number;
        name: string;
        image_url?: string;
      }>;
      writer_artists?: Array<{
        id: number;
        name: string;
        image_url?: string;
      }>;
    };
  };
}

/**
 * Genius API client with resilience features
 * - Circuit breaker for API error handling
 * - Caching with TTL to avoid duplicate requests
 * - Rate limiting to respect the Genius API limits
 */
export class GeniusClient {
  private circuitBreaker;
  private rateLimiter;
  private logger = logger.child({ service: 'GeniusAPI' });

  constructor(private token: string, private supabase: SupabaseClient<Database>) {
    this.circuitBreaker = CircuitBreakerRegistry.getOrCreate({
      name: 'genius-api',
      failureThreshold: 3,
      resetTimeoutMs: 60000 // 1 minute
    });
    
    // Ensure we pass the supabase client to the rate limiter
    this.rateLimiter = new RateLimiter(supabase);
  }

  /**
   * Search for a track on Genius
   * @param song - Song/track title
   * @param artist - Artist name
   * @returns Search results
   */
  async search(song: string, artist: string): Promise<GeniusSearchResult> {
    const query = encodeURIComponent(`${artist} ${song}`);
    const cacheKey = `genius-search:${query}`;
    const contextLogger = this.logger.child({ operation: 'search', song, artist });
    
    try {
      // Check rate limits before making request
      const canProceed = await this.rateLimiter.canProceed({
        key: 'genius-api',
        maxRequests: 500, // Stay well under the 600 req/min limit
        windowMs: 60000 // 1 minute window
      });

      if (!canProceed) {
        contextLogger.warn('Rate limit exceeded for Genius API');
        throw new Error('Rate limit exceeded for Genius API');
      }

      // Use cache with 7-day TTL for search results
      return globalCache.getOrFetch<GeniusSearchResult>(cacheKey, async () => {
        // Use circuit breaker to handle API errors
        return this.circuitBreaker.fire(async () => {
          contextLogger.debug(`Making Genius API search request`, { query });
          
          // Use rate-limited retry with exponential backoff
          return withRateLimitedRetry(async () => {
            const res = await fetch(`${API}/search?q=${query}`, {
              headers: { Authorization: `Bearer ${this.token}` }
            });

            if (!res.ok) {
              const errorText = await res.text();
              const error = new Error(`Genius API error: ${res.status}. Details: ${errorText}`);
              
              // Add response info to the error for better handling
              (error as any).status = res.status;
              (error as any).headers = res.headers;
              
              contextLogger.error(`Search request failed`, error, {
                status: res.status,
                query
              });
              
              throw error;
            }

            const data = await res.json();
            contextLogger.debug(`Search request successful`, {
              hitCount: data.response?.hits?.length || 0
            });
            return data;
          }, 'genius-search');
        });
      }, 7 * 24 * 60 * 60 * 1000); // 7-day cache
    } catch (error) {
      contextLogger.error(`Error in Genius API search for "${query}"`, error);
      throw error;
    }
  }

  /**
   * Get detailed information about a specific song
   * @param id - Genius song ID
   * @returns Song details including producers and writers
   */
  async getSong(id: number): Promise<GeniusSongResult> {
    if (!id) {
      throw new Error('Invalid Genius song ID');
    }
    
    const cacheKey = `genius-song:${id}`;
    const contextLogger = this.logger.child({ operation: 'getSong', songId: id });
    
    try {
      // Check rate limits before making request
      const canProceed = await this.rateLimiter.canProceed({
        key: 'genius-api',
        maxRequests: 500, // Stay well under the 600 req/min limit
        windowMs: 60000 // 1 minute window
      });

      if (!canProceed) {
        contextLogger.warn('Rate limit exceeded for Genius API');
        throw new Error('Rate limit exceeded for Genius API');
      }

      // Use cache with 30-day TTL for song details (unlikely to change)
      return globalCache.getOrFetch<GeniusSongResult>(cacheKey, async () => {
        // Use circuit breaker to handle API errors
        return this.circuitBreaker.fire(async () => {
          contextLogger.debug(`Making Genius API song request`, { songId: id });
          
          // Use rate-limited retry with exponential backoff
          return withRateLimitedRetry(async () => {
            const res = await fetch(`${API}/songs/${id}`, {
              headers: { Authorization: `Bearer ${this.token}` }
            });
            
            if (!res.ok) {
              const errorText = await res.text();
              const error = new Error(`Genius API error: ${res.status}. Details: ${errorText}`);
              
              // Add response info to the error for better handling
              (error as any).status = res.status;
              (error as any).headers = res.headers;
              
              contextLogger.error(`Song details request failed`, error, {
                status: res.status,
                songId: id
              });
              
              throw error;
            }

            const data = await res.json();
            
            contextLogger.debug(`Song details request successful`, {
              songId: id,
              title: data.response?.song?.title,
              producerCount: data.response?.song?.producer_artists?.length || 0,
              writerCount: data.response?.song?.writer_artists?.length || 0
            });
            
            return data;
          }, 'genius-song');
        });
      }, 30 * 24 * 60 * 60 * 1000); // 30-day cache
    } catch (error) {
      contextLogger.error(`Error in Genius API getSong for ID ${id}`, error);
      throw error;
    }
  }
}

const API = 'https://api.genius.com';

/**
 * Create a Genius client instance with provided token
 * @param token - Genius API access token
 * @param supabase - Supabase client instance
 * @returns GeniusClient instance
 */
export function createGeniusClient(token: string, supabase: SupabaseClient<Database>): GeniusClient {
  if (!token) {
    throw new Error('Missing Genius API token');
  }
  
  if (!supabase) {
    throw new Error('Missing Supabase client instance');
  }
  
  return new GeniusClient(token, supabase);
}
