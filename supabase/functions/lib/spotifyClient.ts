
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
let spotifyAccessToken: string | null = null;
let spotifyTokenExpiry = 0;

import { CircuitBreakerRegistry } from './circuitBreaker.ts';
import { globalCache } from './cache.ts';

/** Get a valid Spotify access token via Client Credentials Flow */
async function refreshSpotifyToken(): Promise<void> {
  const clientId = Deno.env.get('SPOTIFY_CLIENT_ID');
  const clientSecret = Deno.env.get('SPOTIFY_CLIENT_SECRET');
  
  if (!clientId || !clientSecret) {
    throw new Error('Missing Spotify credentials in environment variables');
  }
  
  const creds = btoa(`${clientId}:${clientSecret}`);
  
  // Use circuit breaker for token refresh
  const circuit = CircuitBreakerRegistry.getOrCreate({
    name: 'spotify-token-refresh',
    failureThreshold: 3,
    resetTimeoutMs: 60000 // 1 minute
  });
  
  await circuit.fire(async () => {
    const resp = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 
        'Authorization': `Basic ${creds}`, 
        'Content-Type': 'application/x-www-form-urlencoded' 
      },
      body: 'grant_type=client_credentials',
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
    
    console.log('Refreshed Spotify access token, expires in', data.expires_in, 'seconds');
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
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const token = await ensureToken();
          
          // Set up a controller for timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
          
          const res = await fetch(`https://api.spotify.com/v1/${path}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (res.status === 429) {
            // Rate limited - get retry-after header and wait
            const retryAfter = res.headers.get('Retry-After') || '1';
            const waitTime = parseInt(retryAfter, 10) * 1000;
            console.log(`Rate limited by Spotify, waiting for ${waitTime}ms before retry`);
            await wait(waitTime);
            continue;
          }
          
          if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Spotify API error: ${res.status} ${res.statusText}. Details: ${errorText}`);
          }
          
          return res.json();
        } catch (err) {
          if (attempt === retries) throw err;
          console.warn(`Spotify API error (attempt ${attempt}/${retries}):`, err);
          await wait(1000 * Math.pow(2, attempt-1)); // Exponential backoff
        }
      }
      
      throw new Error('Should not reach here - all retries failed');
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
    console.error(`Error getting artist ID for ${name}:`, error);
    return null;
  }
}

export async function getArtistAlbums(artistId: string, offset = 0): Promise<any> {
  // Only get albums and singles where the artist is the primary artist
  // We'll filter further in the results to ensure they're truly primary artist releases
  const albums = await spotifyApi<any>(`artists/${artistId}/albums?include_groups=album,single&limit=50&offset=${offset}`);
  
  if (albums && albums.items) {
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
