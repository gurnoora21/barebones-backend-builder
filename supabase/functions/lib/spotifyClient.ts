
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
let spotifyAccessToken: string | null = null;
let spotifyTokenExpiry = 0;

/** Get a valid Spotify access token via Client Credentials Flow */
async function refreshSpotifyToken(): Promise<void> {
  const clientId = Deno.env.get('SPOTIFY_CLIENT_ID');
  const clientSecret = Deno.env.get('SPOTIFY_CLIENT_SECRET');
  
  if (!clientId || !clientSecret) {
    throw new Error('Missing Spotify credentials in environment variables');
  }
  
  const creds = btoa(`${clientId}:${clientSecret}`);
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
  spotifyTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // refresh 1min early
  
  console.log('Refreshed Spotify access token');
}

async function ensureToken(): Promise<string> {
  if (!spotifyAccessToken || Date.now() > spotifyTokenExpiry) {
    await refreshSpotifyToken();
  }
  return spotifyAccessToken!;
}

/** Call Spotify API with the proper token and retry logic */
async function spotifyApi(path: string, retries = 3): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const token = await ensureToken();
      const res = await fetch(`https://api.spotify.com/v1/${path}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
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
      await wait(1000 * attempt); // Exponential backoff
    }
  }
  
  throw new Error('Should not reach here - all retries failed');
}

// Specific Spotify helper functions
export async function getSpotifyArtistId(name: string): Promise<string | null> {
  const data = await spotifyApi(`search?q=${encodeURIComponent(name)}&type=artist&limit=1`);
  return data.artists.items[0]?.id || null;
}

export async function getArtistAlbums(artistId: string, offset = 0): Promise<any> {
  return spotifyApi(`artists/${artistId}/albums?include_groups=album,single,appears_on,compilation&limit=50&offset=${offset}`);
}

export async function getAlbumTracks(albumId: string, offset = 0): Promise<any> {
  const data = await spotifyApi(`albums/${albumId}/tracks?limit=50&offset=${offset}`);
  return data;
}

export async function getTrackDetails(trackId: string): Promise<any> {
  return spotifyApi(`tracks/${trackId}`);
}

// Rate limiter utility
export async function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
