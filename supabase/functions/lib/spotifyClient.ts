

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
let spotifyAccessToken: string | null = null;
let spotifyTokenExpiry = 0;

import { CircuitBreakerRegistry } from './circuitBreaker.ts';
import { globalCache } from './cache.ts';
import { logger } from './logger.ts';
import { withRetry, withRateLimitedRetry, wait, getRetryDelayFromHeaders, ErrorCategory, categorizeError } from './retry.ts';
import { getEnvConfig } from './dbHelpers.ts';

// Create a logger instance specifically for Spotify API
const spotifyLogger = logger.child({ service: 'SpotifyAPI' });
const env = getEnvConfig();

// Track concurrency for backpressure control
let concurrentRequests = 0;
const MAX_CONCURRENT = 2; // Maximum concurrent requests to Spotify API

// Defaults for rate limit handling
const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 60; // Default retry after 1 minute if no header
const MAX_RATE_LIMIT_RETRY_SECONDS = 3600; // Cap retry delay to 1 hour max

/** Get a valid Spotify access token via Client Credentials Flow */
async function refreshSpotifyToken(): Promise<void> {
  const clientId = env.getRequired('SPOTIFY_CLIENT_ID');
  const clientSecret = env.getRequired('SPOTIFY_CLIENT_SECRET');
  
  const creds = btoa(`${clientId}:${clientSecret}`);
  
  // Use circuit breaker for token refresh
  const circuit = CircuitBreakerRegistry.getOrCreate({
    name: 'spotify-token-refresh',
    failureThreshold: 3,
    resetTimeoutMs: 60 * 60 * 1000, // 1 hour
    halfOpenSuccessThreshold: 1
  });
  
  await circuit.fire(async () => {
    spotifyLogger.debug('Refreshing Spotify access token');
    
    let response; // FIXED: Properly declare the response variable before using it
    
    response = await withRetry(async () => {
      // Use controlledFetch to respect backpressure
      return await controlledFetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: { 
          'Authorization': `Basic ${creds}`, 
          'Content-Type': 'application/x-www-form-urlencoded' 
        },
        body: 'grant_type=client_credentials',
      });
    }, {
      maxAttempts: 5,
      initialDelayMs: 1000,
      retryableErrorPredicate: (error) => {
        return categorizeError(error) !== ErrorCategory.PERMANENT;
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to refresh Spotify token: ${response.status} ${response.statusText}. Details: ${errorText}`);
    }
    
    const data = await response.json();
    spotifyAccessToken = data.access_token;
    // Refresh 1min early (or 10% of time if less than 10min)
    const refreshBuffer = Math.min(60000, data.expires_in * 100);
    spotifyTokenExpiry = Date.now() + (data.expires_in * 1000) - refreshBuffer;
    
    spotifyLogger.info('Refreshed Spotify access token', { 
      expiresIn: data.expires_in,
      expiryTime: new Date(spotifyTokenExpiry).toISOString()
    });
  });
}

async function ensureToken(): Promise<string> {
  if (!spotifyAccessToken || Date.now() > spotifyTokenExpiry) {
    await refreshSpotifyToken();
  }
  return spotifyAccessToken!;
}

/**
 * Validates a rate limit response from Spotify
 * Returns true if it appears to be a legitimate rate limit
 */
function isValidRateLimitResponse(response: Response): boolean {
  // Check for proper status code first
  if (response.status !== 429) {
    return false;
  }
  
  // Validate the Retry-After header exists
  const retryAfter = response.headers.get('Retry-After');
  if (!retryAfter) {
    spotifyLogger.warn('Got 429 status but no Retry-After header, suspicious', {
      headers: Object.fromEntries(response.headers.entries())
    });
    return false;
  }
  
  // Get the retry delay and make sure it's reasonable
  const retryDelay = getRetryDelayFromHeaders(response.headers);
  if (!retryDelay || retryDelay <= 0) {
    spotifyLogger.warn('Got invalid Retry-After value', { retryAfter });
    return false;
  }
  
  // Cap the retry delay to a reasonable maximum
  if (retryDelay > MAX_RATE_LIMIT_RETRY_SECONDS * 1000) {
    spotifyLogger.warn(`Suspiciously long Retry-After value: ${retryDelay}ms, capping to ${MAX_RATE_LIMIT_RETRY_SECONDS}s`);
    return true; // Still valid, but we'll cap the delay later
  }
  
  return true;
}

/**
 * Calculate an appropriate retry delay from headers with reasonable limits
 */
function getReasonableRetryDelay(headers: Headers): number {
  // Get the suggested delay from the headers
  const suggestedDelay = getRetryDelayFromHeaders(headers);
  
  // If no valid delay, use a default
  if (!suggestedDelay || suggestedDelay <= 0) {
    return DEFAULT_RATE_LIMIT_RETRY_SECONDS * 1000;
  }
  
  // Cap the delay to a reasonable maximum
  return Math.min(suggestedDelay, MAX_RATE_LIMIT_RETRY_SECONDS * 1000);
}

/** Call Spotify API with the proper token and retry logic */
export async function spotifyApi<T>(path: string, retries = 3): Promise<T> {
  const contextLogger = spotifyLogger.child({ operation: path.split('?')[0] });
  
  // Create a unique cache key for this request
  const cacheKey = `spotify-api:${path}`;
  
  // Try to get from cache first, with a 10 min TTL for most Spotify data
  // This avoids hitting rate limits and speeds up responses
  return globalCache.getOrFetch<T>(cacheKey, async () => {
    // Use specialized rate limit circuit breaker for Spotify API calls
    const rateLimitCircuit = CircuitBreakerRegistry.getOrCreate({
      name: 'spotify-rate-limit',
      failureThreshold: 3, // Increased from 1 to 3 to make it less aggressive
      resetTimeoutMs: 60 * 60 * 1000, // 1 hour default, but we'll use Retry-After when available
      halfOpenSuccessThreshold: 1
    });
    
    // General API circuit breaker
    const apiCircuit = CircuitBreakerRegistry.getOrCreate({
      name: 'spotify-api',
      failureThreshold: 5, // Increased from 3 to 5
      resetTimeoutMs: 15 * 60 * 1000, // 15 minutes (reduced from 1 hour)
      halfOpenSuccessThreshold: 2
    });
    
    return apiCircuit.fire(async () => {
      return withRateLimitedRetry(async () => {
        const token = await ensureToken();
        
        // Set up a controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
        
        try {
          // Use controlledFetch to implement backpressure
          const res = await controlledFetch(`https://api.spotify.com/v1/${path}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (res.status === 429) {
            // Validate the rate limit response
            if (isValidRateLimitResponse(res)) {
              // Get a reasonable retry delay
              const retryDelay = getReasonableRetryDelay(res.headers);
              
              contextLogger.warn(`Rate limited by Spotify, waiting for ${retryDelay}ms before retry`, {
                retryAfter: res.headers.get('Retry-After'),
                path,
                cappedDelay: retryDelay
              });
              
              // Tell the rate limit circuit about this failure
              await rateLimitCircuit.recordFailure(res, retryDelay); // Pass the capped delay
              
              // Let the retry mechanism handle this
              const error = new Error(`Spotify API rate limited`);
              (error as any).status = 429;
              (error as any).headers = res.headers;
              throw error;
            } else {
              // This looks like a suspicious rate limit response
              contextLogger.warn('Received suspicious rate limit response, treating as regular error', {
                path,
                status: res.status,
                headers: Object.fromEntries(res.headers.entries())
              });
              
              // Treat as a regular error, not a rate limit
              const error = new Error(`Suspicious rate limit response`);
              (error as any).status = res.status;
              throw error;
            }
          }
          
          if (!res.ok) {
            const errorText = await res.text();
            const error = new Error(`Spotify API error: ${res.status} ${res.statusText}. Details: ${errorText}`);
            (error as any).status = res.status;
            (error as any).headers = res.headers;
            throw error;
          }
          
          const data = await res.json();
          return data as T;
          
        } catch (error) {
          clearTimeout(timeoutId);
          
          // Handle AbortError specifically
          if (error.name === 'AbortError') {
            throw new Error(`Spotify API request timed out for ${path}`);
          }
          
          throw error;
        }
      }, 'spotify-api', {
        maxAttempts: retries,
        initialDelayMs: 2000,
        maxDelayMs: 30000,
        factor: 1.5,
        jitter: true
      });
    });
  }, 600000); // 10 minute cache TTL for Spotify data
}

// Helper function to verify artist is primary on a Spotify item
function isArtistPrimary(item: any, artistId: string): boolean {
  return item.artists && 
         item.artists.length > 0 && 
         item.artists[0].id === artistId;
}

export async function getSpotifyArtistId(name: string): Promise<string | null> {
  try {
    const data = await spotifyApi<any>(`search?q=${encodeURIComponent(name)}&type=artist&limit=1`);
    return data.artists.items[0]?.id || null;
  } catch (error) {
    spotifyLogger.error(`Error getting artist ID for ${name}:`, error);
    return null;
  }
}

export async function getArtistAlbums(artistId: string, offset = 0): Promise<any> {
  const contextLogger = spotifyLogger.child({ 
    operation: 'getArtistAlbums',
    artistId,
    offset 
  });
  
  // Only get albums and singles where the artist is the primary artist
  // We'll filter further in the results to ensure they're truly primary artist releases
  const albums = await spotifyApi<any>(`artists/${artistId}/albums?include_groups=album,single&limit=50&offset=${offset}`);
  
  if (albums && albums.items) {
    contextLogger.debug(`Retrieved ${albums.items.length} albums from Spotify`, {
      total: albums.total
    });
    
    // Filter to only include albums where the specified artist is the primary artist
    albums.items = albums.items.filter(album => {
      // Exclude compilations and appears_on album types
      if (album.album_type === 'compilation' || album.album_group === 'appears_on') {
        return false;
      }
      
      // Ensure the specified artist is the primary artist
      return isArtistPrimary(album, artistId);
    });
    
    // Update the total count to reflect our filtered results
    albums.total = albums.items.length;
    
    contextLogger.debug(`Filtered to ${albums.items.length} primary artist albums`);
  }
  
  return albums;
}

export async function getAlbumTracks(albumId: string, offset = 0): Promise<any> {
  return spotifyApi<any>(`albums/${albumId}/tracks?limit=50&offset=${offset}`);
}

export async function getTrackDetails(trackId: string): Promise<any> {
  return spotifyApi<any>(`tracks/${trackId}`);
}

// Backpressure-aware fetch wrapper
export async function controlledFetch(url: string, options?: RequestInit): Promise<Response> {
  // Wait until we're under concurrency limit
  while (concurrentRequests >= MAX_CONCURRENT) {
    await wait(200);
  }
  
  concurrentRequests++;
  try {
    return await fetch(url, options);
  } finally {
    concurrentRequests--;
    // Add small delay between requests to prevent rate limit issues
    await wait(250);
  }
}

// Add export for wait function
export { wait } from './retry.ts';

