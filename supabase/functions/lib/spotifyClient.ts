
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
let spotifyAccessToken: string | null = null;
let spotifyTokenExpiry = 0;

import { CircuitBreakerRegistry } from './circuitBreaker.ts';
import { globalCache } from './cache.ts';
import { logger } from './logger.ts';
import { withRetry, withRateLimitedRetry, wait, getRetryDelayFromHeaders } from './retry.ts';
import { getEnvConfig } from './dbHelpers.ts';

// Create a logger instance specifically for Spotify API
const spotifyLogger = logger.child({ service: 'SpotifyAPI' });
const env = getEnvConfig();

/** Get a valid Spotify access token via Client Credentials Flow */
async function refreshSpotifyToken(): Promise<void> {
  const clientId = env.getRequired('SPOTIFY_CLIENT_ID');
  const clientSecret = env.getRequired('SPOTIFY_CLIENT_SECRET');
  
  const creds = btoa(`${clientId}:${clientSecret}`);
  
  // Use circuit breaker for token refresh
  const circuit = CircuitBreakerRegistry.getOrCreate({
    name: 'spotify-token-refresh',
    failureThreshold: 3,
    resetTimeoutMs: 60000 // 1 minute
  });
  
  await circuit.fire(async () => {
    spotifyLogger.debug('Refreshing Spotify access token');
    
    const resp = await withRetry(async () => {
      const response = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: { 
          'Authorization': `Basic ${creds}`, 
          'Content-Type': 'application/x-www-form-urlencoded' 
        },
        body: 'grant_type=client_credentials',
      });
      
      if (!resp.ok) {
        const errorText = await resp.text();
        const error = new Error(`Failed to refresh Spotify token: ${resp.status} ${resp.statusText}. Details: ${errorText}`);
        (error as any).status = resp.status;
        (error as any).headers = resp.headers;
        throw error;
      }
      
      return response;
    }, {
      maxAttempts: 5,
      initialDelayMs: 1000
    });
    
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Failed to refresh Spotify token: ${resp.status} ${resp.statusText}. Details: ${errorText}`);
    }
    
    const data = await resp.json();
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

/** Call Spotify API with the proper token and retry logic */
export async function spotifyApi<T>(path: string, retries = 3): Promise<T> {
  const contextLogger = spotifyLogger.child({ operation: path.split('?')[0] });
  
  // Create a unique cache key for this request
  const cacheKey = `spotify-api:${path}`;
  
  // Try to get from cache first, with a 10 min TTL for most Spotify data
  // This avoids hitting rate limits and speeds up responses
  return globalCache.getOrFetch<T>(cacheKey, async () => {
    // Use circuit breaker for API calls
    const circuit = CircuitBreakerRegistry.getOrCreate({
      name: 'spotify-api',
      failureThreshold: 5,
      resetTimeoutMs: 30000 // 30 seconds
    });
    
    return circuit.fire(async () => {
      return withRateLimitedRetry(async () => {
        const token = await ensureToken();
        
        // Set up a controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
        
        try {
          const res = await fetch(`https://api.spotify.com/v1/${path}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (res.status === 429) {
            // Rate limited - get retry-after header and wait
            const retryAfter = res.headers.get('Retry-After');
            const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000;
            
            contextLogger.warn(`Rate limited by Spotify, waiting for ${waitTime}ms before retry`);
            
            // Let the retry mechanism handle this
            const error = new Error(`Spotify API rate limited`);
            (error as any).status = 429;
            (error as any).headers = res.headers;
            throw error;
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
        maxDelayMs: 30000
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

// Enhanced wait function with backpressure control
let concurrentRequests = 0;
const MAX_CONCURRENT = 10; // Maximum concurrent requests

export async function wait(ms: number): Promise<void> {
  // If we're at max concurrency, add a bit more wait time
  if (concurrentRequests >= MAX_CONCURRENT) {
    ms += 200; // Add 200ms when under heavy load
  }
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Backpressure-aware fetch wrapper
export async function controlledFetch(url: string, options?: RequestInit): Promise<Response> {
  // Wait until we're under concurrency limit
  while (concurrentRequests >= MAX_CONCURRENT) {
    await wait(100);
  }
  
  concurrentRequests++;
  try {
    return await fetch(url, options);
  } finally {
    concurrentRequests--;
  }
}
