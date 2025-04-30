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
 * Error categories for Genius API
 */
enum GeniusErrorCategory {
  RateLimit = 'rate-limit',
  Authentication = 'authentication',
  NotFound = 'not-found',
  ServerError = 'server-error',
  NetworkError = 'network-error',
  Unknown = 'unknown'
}

/**
 * Custom error class for Genius API errors
 */
class GeniusApiError extends Error {
  category: GeniusErrorCategory;
  status?: number;
  retryAfterMs?: number;
  
  constructor(message: string, category: GeniusErrorCategory, options: { status?: number, retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'GeniusApiError';
    this.category = category;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Genius API client with resilience features
 * - Circuit breaker for API error handling
 * - Caching with TTL to avoid duplicate requests
 * - Rate limiting to respect the Genius API limits
 */
export class GeniusClient {
  private apiCircuitBreaker;
  private rateLimitCircuitBreaker;
  private rateLimiter;
  private logger = logger.child({ service: 'GeniusAPI' });
  private apiMaxRequestsPerMin = 120; // Genius API limit is approx 100-120 per minute
  
  constructor(private token: string, private supabase: SupabaseClient<Database>) {
    // Circuit breaker for general API errors
    this.apiCircuitBreaker = CircuitBreakerRegistry.getOrCreate({
      name: 'genius-api',
      failureThreshold: 5,
      resetTimeoutMs: 60000, // 1 minute
      halfOpenMaxCalls: 1,
      halfOpenSuccessThreshold: 1
    });
    
    // Special circuit breaker for rate limiting
    this.rateLimitCircuitBreaker = CircuitBreakerRegistry.getOrCreate({
      name: 'genius-rate-limit',
      failureThreshold: 1, // Trip immediately on rate limit
      resetTimeoutMs: 60000, // Default 1 minute, will be overridden by Retry-After
      halfOpenMaxCalls: 1,
      halfOpenSuccessThreshold: 1,
      onStateChange: (from, to, context) => {
        this.logger.info(`Circuit genius-rate-limit state changed from ${from} to ${to}`);
        
        // If we're opening the circuit due to a rate limit, set custom timeout
        if (to === 'open' && context?.retryAfterMs) {
          this.logger.info(`Setting custom reset timeout for genius-rate-limit: ${context.retryAfterMs}ms`);
          this.rateLimitCircuitBreaker.setCustomResetTimeout(context.retryAfterMs);
        }
      }
    });
    
    // Ensure we pass the supabase client to the rate limiter
    this.rateLimiter = new RateLimiter(supabase);
  }
  
  /**
   * Make a request to the Genius API with resilience patterns
   */
  private async geniusRequest<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `https://api.genius.com/${path}`;
    const contextLogger = this.logger.child({ operation: path });
    
    try {
      // Check rate limits before making request
      const canProceed = await this.rateLimiter.canProceed({
        key: 'genius-api',
        maxRequests: this.apiMaxRequestsPerMin, 
        windowMs: 60000 // 1 minute window
      });

      if (!canProceed) {
        contextLogger.warn('Rate limiter prevented request to Genius API');
        throw new GeniusApiError('Rate limit reached for Genius API', GeniusErrorCategory.RateLimit, {
          retryAfterMs: 30000 // Default retry after 30s when rate limited locally
        });
      }
      
      // Check if rate limit circuit is open
      await this.rateLimitCircuitBreaker.fire(async () => {
        // If rate limit circuit is closed, proceed with main API circuit
        return this.apiCircuitBreaker.fire(async () => {
          contextLogger.debug(`Making Genius API request to ${path}`);
          
          const headers = {
            Authorization: `Bearer ${this.token}`,
            ...(options?.headers || {})
          };
          
          const res = await fetch(url, {
            ...options,
            headers
          });
          
          // Increment the rate limit counter for successful requests
          await this.rateLimiter.increment('genius-api');
          
          // Handle different response statuses
          if (!res.ok) {
            let retryAfterMs: number | undefined;
            
            // Extract retry-after if present (convert from seconds to ms)
            const retryAfter = res.headers.get('retry-after');
            if (retryAfter) {
              retryAfterMs = parseInt(retryAfter, 10) * 1000;
            }
            
            const errorText = await res.text();
            
            // Categorize the error based on status code
            let category = GeniusErrorCategory.Unknown;
            switch (res.status) {
              case 401:
              case 403:
                category = GeniusErrorCategory.Authentication;
                break;
              case 404:
                category = GeniusErrorCategory.NotFound;
                break;
              case 429:
                category = GeniusErrorCategory.RateLimit;
                // Default retry-after if header is missing
                retryAfterMs = retryAfterMs || 60000; 
                // Update rate limiter when we get a 429
                if (retryAfterMs) {
                  await this.rateLimiter.reset('genius-api', Date.now() + retryAfterMs);
                }
                break;
              case 500:
              case 502:
              case 503:
              case 504:
                category = GeniusErrorCategory.ServerError;
                break;
              default:
                category = GeniusErrorCategory.Unknown;
            }
            
            const error = new GeniusApiError(
              `Genius API error: ${res.status}. Details: ${errorText}`, 
              category,
              { status: res.status, retryAfterMs }
            );
            
            contextLogger.error(`Request failed: ${error.message}`, {
              category: error.category,
              status: res.status,
              path
            });
            
            // Pass the retry-after information to the circuit breaker
            if (category === GeniusErrorCategory.RateLimit) {
              throw { 
                error, 
                circuitBreakerContext: { retryAfterMs } 
              };
            }
            
            throw error;
          }

          const data = await res.json();
          return data as T;
        });
      });
    } catch (error) {
      // Handle circuit breaker context wrapper
      if (error && typeof error === 'object' && 'error' in error && 'circuitBreakerContext' in error) {
        throw error.error;
      }
      
      contextLogger.error(`Error in Genius API request to ${path}`, error);
      throw error;
    }
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
      // Use cache with 1-day TTL for search results (increased from 7-day for more frequent freshness)
      return globalCache.getOrFetch<GeniusSearchResult>(cacheKey, async () => {
        contextLogger.debug(`Making Genius API search request`, { query });
        
        // Use rate-limited retry with exponential backoff
        return withRateLimitedRetry(async () => {
          return await this.geniusRequest<GeniusSearchResult>(`search?q=${query}`);
        }, 'genius-search', {
          isRetryableError: (err) => {
            if (err instanceof GeniusApiError) {
              // Only retry on rate limits and server errors
              return [
                GeniusErrorCategory.RateLimit, 
                GeniusErrorCategory.ServerError, 
                GeniusErrorCategory.NetworkError
              ].includes(err.category);
            }
            // Retry on network errors
            return err instanceof TypeError || err.message?.includes('network');
          },
          getRetryDelayMs: (err, attempt) => {
            if (err instanceof GeniusApiError && err.retryAfterMs) {
              // Use the server-provided retry delay
              return err.retryAfterMs;
            }
            // Default exponential backoff
            return Math.min(2 ** attempt * 1000, 30000);
          }
        });
      }, 24 * 60 * 60 * 1000); // 1-day cache
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
      // Use cache with 30-day TTL for song details (unchanged as these rarely change)
      return globalCache.getOrFetch<GeniusSongResult>(cacheKey, async () => {
        contextLogger.debug(`Making Genius API song request`, { songId: id });
        
        // Use rate-limited retry with exponential backoff
        return withRateLimitedRetry(async () => {
          return await this.geniusRequest<GeniusSongResult>(`songs/${id}`);
        }, 'genius-song', {
          isRetryableError: (err) => {
            if (err instanceof GeniusApiError) {
              // Only retry on rate limits and server errors
              return [
                GeniusErrorCategory.RateLimit, 
                GeniusErrorCategory.ServerError, 
                GeniusErrorCategory.NetworkError
              ].includes(err.category);
            }
            // Retry on network errors
            return err instanceof TypeError || err.message?.includes('network');
          },
          getRetryDelayMs: (err, attempt) => {
            if (err instanceof GeniusApiError && err.retryAfterMs) {
              // Use the server-provided retry delay
              return err.retryAfterMs;
            }
            // Default exponential backoff
            return Math.min(2 ** attempt * 1000, 30000);
          }
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
