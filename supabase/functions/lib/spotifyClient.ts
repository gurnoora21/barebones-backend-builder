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

// Track API calls for monitoring
let _spotifyCallCount = 0;
export function resetSpotifyCallCount() { _spotifyCallCount = 0; }
export function getSpotifyCallCount() { return _spotifyCallCount; }

// Define endpoint types for better tracking
type EndpointType = 'artists' | 'albums' | 'tracks' | 'token' | 'other';

// Track concurrency for backpressure control with endpoint-specific pools
interface ConcurrencyPool {
  currentCount: number;
  maxConcurrent: number;
}

const endpointPools = new Map<EndpointType, ConcurrencyPool>();
const DEFAULT_MAX_CONCURRENT = 2; // Default value preserved from original code

// Initialize default pools for each endpoint type
function initializePool(endpoint: EndpointType, maxConcurrent: number = DEFAULT_MAX_CONCURRENT): ConcurrencyPool {
  if (!endpointPools.has(endpoint)) {
    endpointPools.set(endpoint, {
      currentCount: 0,
      maxConcurrent
    });
  }
  return endpointPools.get(endpoint)!;
}

// Initialize default pools with increased concurrency limits
initializePool('artists', 4);  // Was 2
initializePool('albums', 3);   // Was 1
initializePool('tracks', 4);   // Was 2
initializePool('token', 1);    // Keep at 1
initializePool('other', 3);    // Was 1

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
      }, 'token'); // Use token endpoint pool
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

/**
 * Determine which endpoint type a path belongs to
 */
function determineEndpointType(path: string): EndpointType {
  if (path.includes('artists')) {
    return 'artists';
  } else if (path.includes('albums')) {
    return 'albums';
  } else if (path.includes('tracks')) {
    return 'tracks';
  } else if (path === SPOTIFY_TOKEN_URL) {
    return 'token';
  } else {
    return 'other';
  }
}

/** Call Spotify API with the proper token and retry logic */
export async function spotifyApi<T>(path: string, options: { timeout?: number } = {}, retries = 3): Promise<T> {
  const endpointType = determineEndpointType(`${path}`);
  const contextLogger = spotifyLogger.child({ 
    operation: path.split('?')[0],
    endpointType
  });
  
  // Create a unique cache key for this request
  const cacheKey = `spotify-api:${path}`;
  
  // Try to get from cache first, with a 10 min TTL for most Spotify data
  // This avoids hitting rate limits and speeds up responses
  return globalCache.getOrFetch<T>(cacheKey, async () => {
    // Use endpoint-specific circuit breaker with more granular control
    const endpointCircuitName = `spotify-${endpointType}-circuit`;
    const endpointCircuit = CircuitBreakerRegistry.getOrCreate({
      name: endpointCircuitName,
      failureThreshold: 8, // Allow more failures before tripping for specific endpoints
      resetTimeoutMs: 15 * 60 * 1000, // 15 minutes
      halfOpenSuccessThreshold: 2
    });
    
    // Rate limit circuit breaker - keep a separate one for rate limits
    const rateLimitCircuit = CircuitBreakerRegistry.getOrCreate({
      name: `spotify-${endpointType}-rate-limit`,
      failureThreshold: 3,
      resetTimeoutMs: 60 * 60 * 1000, // 1 hour default, but we'll use Retry-After when available
      halfOpenSuccessThreshold: 1
    });
    
    return endpointCircuit.fire(async () => {
      return withRateLimitedRetry(async () => {
        const token = await ensureToken();
        
        // Set up a controller for timeout
        const controller = new AbortController();
        const timeoutMs = options.timeout || 10000; // Default 10s timeout
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        try {
          // Use controlledFetch to implement backpressure with endpoint-specific pool
          const res = await controlledFetch(`https://api.spotify.com/v1/${path}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: controller.signal
          }, endpointType);
          
          clearTimeout(timeoutId);
          
          if (res.status === 429) {
            // Validate the rate limit response
            if (isValidRateLimitResponse(res)) {
              // Get a reasonable retry delay
              const retryDelay = getReasonableRetryDelay(res.headers);
              
              contextLogger.warn(`Rate limited by Spotify ${endpointType} endpoint, waiting for ${retryDelay}ms before retry`, {
                retryAfter: res.headers.get('Retry-After'),
                path,
                cappedDelay: retryDelay,
                endpoint: endpointType
              });
              
              // Tell the rate limit circuit about this failure
              await rateLimitCircuit.recordFailure(res, retryDelay); // Pass the capped delay
              
              // Let the retry mechanism handle this
              const error = new Error(`Spotify API rate limited on ${endpointType} endpoint`);
              (error as any).status = 429;
              (error as any).headers = res.headers;
              (error as any).endpointType = endpointType;
              throw error;
            } else {
              // This looks like a suspicious rate limit response
              contextLogger.warn('Received suspicious rate limit response, treating as regular error', {
                path,
                status: res.status,
                headers: Object.fromEntries(res.headers.entries()),
                endpoint: endpointType
              });
              
              // Treat as a regular error, not a rate limit
              const error = new Error(`Suspicious rate limit response on ${endpointType} endpoint`);
              (error as any).status = res.status;
              throw error;
            }
          }
          
          if (!res.ok) {
            const errorText = await res.text();
            const error = new Error(`Spotify ${endpointType} API error: ${res.status} ${res.statusText}. Details: ${errorText}`);
            (error as any).status = res.status;
            (error as any).headers = res.headers;
            (error as any).endpointType = endpointType;
            throw error;
          }
          
          const data = await res.json();
          return data as T;
          
        } catch (error) {
          clearTimeout(timeoutId);
          
          // Handle AbortError specifically
          if (error.name === 'AbortError') {
            throw new Error(`Spotify API request timed out for ${path} (${endpointType} endpoint)`);
          }
          
          throw error;
        }
      }, `spotify-${endpointType}-api`, {
        maxAttempts: retries,
        initialDelayMs: getInitialDelayForEndpoint(endpointType),
        maxDelayMs: 30000, 
        factor: getBackoffFactorForEndpoint(endpointType),
        jitter: true
      });
    });
  }, 600000); // 10 minute cache TTL for Spotify data
}

/**
 * Get initial delay based on endpoint type
 */
function getInitialDelayForEndpoint(endpointType: EndpointType): number {
  switch (endpointType) {
    case 'albums':
      return 3000; // Albums need more conservative backoff
    case 'artists':
      return 2000; 
    case 'tracks':
      return 2000;
    case 'token':
      return 5000; // Token refreshes need more time
    default:
      return 2000;
  }
}

/**
 * Get backoff factor based on endpoint type
 */
function getBackoffFactorForEndpoint(endpointType: EndpointType): number {
  switch (endpointType) {
    case 'albums':
      return 2.0; // Albums use standard backoff
    case 'artists':
      return 1.5; // Artists can be slightly more aggressive
    case 'tracks':
      return 1.5;
    case 'token':
      return 3.0; // Token refreshes need more conservative backoff
    default:
      return 2.0;
  }
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
  const albums = await spotifyApi<any>(
    `artists/${artistId}/albums?include_groups=album,single&limit=50&offset=${offset}`,
    { timeout: 25000 } // Increased timeout for this operation
  );
  
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
  return spotifyApi<any>(
    `albums/${albumId}/tracks?limit=50&offset=${offset}`,
    { timeout: 20000 } // Increased timeout for album track fetching
  );
}

export async function getTrackDetails(trackId: string): Promise<any> {
  return spotifyApi<any>(
    `tracks/${trackId}`,
    { timeout: 15000 } // Increased timeout for track details
  );
}

// Backpressure-aware fetch wrapper with endpoint-specific concurrency control
export async function controlledFetch(url: string, options?: RequestInit, endpointType: EndpointType = 'other'): Promise<Response> {
  // Track API call count
  _spotifyCallCount++;
  
  // Get or create pool for this endpoint
  const pool = endpointPools.get(endpointType) || initializePool(endpointType);
  
  // Log request with call count
  const logContext = { count: _spotifyCallCount, endpoint: endpointType };
  spotifyLogger.debug(`API request #${_spotifyCallCount} for ${endpointType}`, logContext);
  
  // Wait until we're under concurrency limit for this endpoint
  while (pool.currentCount >= pool.maxConcurrent) {
    await wait(200);
  }
  
  pool.currentCount++;
  spotifyLogger.debug(`API request started for ${endpointType} endpoint (${pool.currentCount}/${pool.maxConcurrent})`);
  
  try {
    return await fetch(url, options);
  } finally {
    pool.currentCount--;
    // Add endpoint-specific delay between requests to prevent rate limit issues
    const delayMs = getEndpointCooldown(endpointType);
    spotifyLogger.debug(`API request completed for ${endpointType} endpoint, cooling down for ${delayMs}ms`);
    await wait(delayMs);
  }
}

/**
 * Get appropriate cooldown delay for each endpoint type
 */
function getEndpointCooldown(endpointType: EndpointType): number {
  switch (endpointType) {
    case 'albums':
      return 150; // Was 350ms
    case 'artists':
      return 100; // Was 300ms
    case 'tracks':
      return 100; // Was 250ms
    case 'token':
      return 500; // Token refreshes need more cooldown
    default:
      return 100; // Was 250ms
  }
}

// Add export for wait function
export { wait } from './retry.ts';

// Export pool utilities for testing and monitoring
export function getEndpointPoolStatus(): Record<string, { current: number, max: number }> {
  const status: Record<string, { current: number, max: number }> = {};
  
  for (const [endpoint, pool] of endpointPools.entries()) {
    status[endpoint] = {
      current: pool.currentCount,
      max: pool.maxConcurrent
    };
  }
  
  return status;
}

// Allow updating pool limits at runtime (useful for dynamic configuration)
export function updateEndpointPoolLimit(endpoint: EndpointType, maxConcurrent: number): void {
  if (maxConcurrent < 1) {
    throw new Error(`Invalid concurrency limit: ${maxConcurrent}. Must be at least 1.`);
  }
  
  const pool = endpointPools.get(endpoint);
  if (pool) {
    spotifyLogger.info(`Updating ${endpoint} endpoint concurrency limit: ${pool.maxConcurrent} -> ${maxConcurrent}`);
    pool.maxConcurrent = maxConcurrent;
  } else {
    initializePool(endpoint, maxConcurrent);
    spotifyLogger.info(`Created new ${endpoint} endpoint pool with concurrency limit: ${maxConcurrent}`);
  }
}
