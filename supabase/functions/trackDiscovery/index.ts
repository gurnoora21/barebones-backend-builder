
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getAlbumTracks, getTrackDetails, wait } from "../lib/spotifyClient.ts";
import { withRetry } from "../lib/retry.ts";
import { logger, generateTraceId } from "../lib/logger.ts";
import { createDbTransactionHelpers } from "../lib/dbHelpers.ts";
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from "../types.ts";

interface TrackDiscoveryMsg {
  albumId: string;
  albumName: string;
  artistId: string;
  offset?: number;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class TrackDiscoveryWorker extends PageWorker<TrackDiscoveryMsg> {
  private workerLogger = logger.child({ worker: 'TrackDiscoveryWorker' });
  
  constructor() {
    super('track_discovery', 60);
  }

  private normalizeTrackName(name: string): string {
    this.workerLogger.debug(`Normalizing track name: "${name}"`);
    
    return name
      .toLowerCase()
      .replace(/\(.*?\)/g, '') // Remove parentheses and their contents
      .replace(/\[.*?\]/g, '') // Remove square brackets and their contents
      .replace(/feat\.|ft\./g, '') // Remove feat. or ft.
      .replace(/[^a-z0-9À-ÿ\s]/g, '') // Keep accented characters while removing special chars
      .trim()
      .replace(/\s+/g, ' '); // Normalize whitespace
  }

  private async isArtistPrimaryOnTrack(track: any, artistId: string): Promise<boolean> {
    if (track.artists && track.artists.length > 0) {
      const primaryArtistId = track.artists[0].id;
      return primaryArtistId === artistId;
    }
    
    try {
      const details = await getTrackDetails(track.id);
      return details.artists && details.artists.length > 0 && details.artists[0].id === artistId;
    } catch (error) {
      this.workerLogger.error(`Error fetching track details for ${track.id}:`, error);
      return false;
    }
  }

  private async checkTrackExists(normalizedName: string, artistUuid: string): Promise<boolean> {
    const dbHelpers = createDbTransactionHelpers(this.supabase as SupabaseClient<Database>);
    
    return dbHelpers.withDbRetry(async () => {
      const { data, error } = await this.supabase
        .from('normalized_tracks')
        .select('id')
        .eq('normalized_name', normalizedName)
        .eq('artist_id', artistUuid)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {  // Not a "no rows" error
        this.workerLogger.error(`Error checking for existing track ${normalizedName}:`, error);
        throw error;
      }
      
      return !!data; // Return true if the track exists, false otherwise
    });
  }
  
  /**
   * Create or update a track with proper transaction handling
   */
  private async createTrack(
    track: any, 
    normalizedName: string, 
    albumUuid: string, 
    artistUuid: string
  ): Promise<string> {
    const traceId = generateTraceId();
    const contextLogger = this.workerLogger.child({ 
      operation: 'createTrack',
      trackName: track.name,
      traceId
    });
    
    const dbHelpers = createDbTransactionHelpers(this.supabase as SupabaseClient<Database>);
    
    return dbHelpers.withTransaction(async (tx) => {
      // First insert the track
      contextLogger.debug('Inserting new track');
      
      const { data: trackData, error: trackUpsertError } = await this.supabase
        .from('tracks')
        .upsert({
          spotify_id: track.id,
          album_id: albumUuid,
          name: track.name,
          duration_ms: track.duration_ms,
          popularity: track.popularity,
          spotify_preview_url: track.preview_url,
          metadata: {
            source: 'spotify',
            disc_number: track.disc_number,
            track_number: track.track_number,
            discovery_timestamp: new Date().toISOString()
          }
        })
        .select('id')
        .single();

      if (trackUpsertError) {
        contextLogger.error('Error upserting track', trackUpsertError);
        throw trackUpsertError;
      }
      
      const trackId = trackData.id;
      
      // Next, create the normalized track entry
      contextLogger.debug('Creating normalized track entry', { normalizedName });
      
      const { error: normalizedError } = await withRetry(async () => {
        return this.supabase
          .from('normalized_tracks')
          .upsert({
            normalized_name: normalizedName,
            artist_id: artistUuid,
            representative_track_id: track.id
          });
      }, {
        maxAttempts: 3,
        initialDelayMs: 200
      });

      if (normalizedError) {
        contextLogger.error('Error upserting normalized track', normalizedError);
        throw normalizedError;
      }
      
      return trackId;
    });
  }

  protected async process(msg: TrackDiscoveryMsg): Promise<void> {
    const { albumId, albumName, artistId, offset = 0 } = msg;
    const traceId = generateTraceId();
    const contextLogger = this.workerLogger.child({ 
      operation: 'process',
      albumName,
      albumId,
      offset,
      traceId
    });
    
    contextLogger.info(`Processing track discovery for album ${albumName} (${albumId}) with offset ${offset}`);
    
    try {
      const { data: artistData, error: artistError } = await this.supabase
        .from('artists')
        .select('id')
        .eq('spotify_id', artistId)
        .single();

      if (artistError || !artistData) {
        throw new Error(`Artist ${artistId} not found in database`);
      }

      const artistUuid = artistData.id;
      
      const tracks = await getAlbumTracks(albumId, offset);
      contextLogger.info(`Found ${tracks.items.length} potential tracks in album ${albumName}`);

      const { data: album, error: albumError } = await this.supabase
        .from('albums')
        .select('id')
        .eq('spotify_id', albumId)
        .single();

      if (albumError || !album) {
        throw new Error(`Album ${albumId} not found in database`);
      }
      
      let validTracksCount = 0;
      let filteredTracksCount = 0;
      let duplicateTracksCount = 0;
      
      for (const track of tracks.items) {
        const trackLogger = contextLogger.child({ trackName: track.name });
        
        try {
          const isPrimaryArtist = track.artists && 
                                   track.artists.length > 0 && 
                                   track.artists[0].id === artistId;
          
          if (!isPrimaryArtist) {
            trackLogger.debug(`Skipping track as ${artistId} is not the primary artist`);
            filteredTracksCount++;
            continue;
          }
          
          const normalizedName = this.normalizeTrackName(track.name);
          trackLogger.debug(`Normalized track name: "${normalizedName}"`);
          
          // Check if this track already exists (by normalized name + artist)
          const trackExists = await this.checkTrackExists(normalizedName, artistUuid);
          if (trackExists) {
            trackLogger.debug(`Skipping duplicate track (normalized: ${normalizedName})`);
            duplicateTracksCount++;
            continue;
          }

          // Get more detailed track information
          const trackDetails = await getTrackDetails(track.id);
          
          // Use transaction to ensure both track and normalized track are created
          await this.createTrack(
            { ...track, popularity: trackDetails.popularity, preview_url: trackDetails.preview_url }, 
            normalizedName, 
            album.id, 
            artistUuid
          );
          
          // Enqueue producer identification
          await this.enqueue('producer_identification', {
            trackId: track.id,
            trackName: track.name,
            albumId,
            artistId
          });
          
          trackLogger.info(`Processed track and enqueued producer identification`);
          
          validTracksCount++;
          await wait(200); // Slight throttle to avoid rate limits
        } catch (trackError) {
          trackLogger.error(`Error processing track:`, trackError);
        }
      }
      
      contextLogger.info(`Processed ${tracks.items.length} tracks`, { 
        valid: validTracksCount, 
        filtered: filteredTracksCount, 
        duplicates: duplicateTracksCount 
      });
      
      // If we have more tracks to process, enqueue the next batch
      if (tracks.items.length > 0 && offset + tracks.items.length < tracks.total && validTracksCount > 0) {
        const newOffset = offset + tracks.items.length;
        await this.enqueue('track_discovery', {
          albumId,
          albumName,
          artistId,
          offset: newOffset
        });
        contextLogger.info(`Enqueued next page of tracks`, { newOffset });
      } else {
        contextLogger.info(`Finished processing all tracks for album ${albumName}`);
      }
    } catch (error) {
      contextLogger.error(`Error in track discovery:`, error);
      throw error;
    }
  }
}

// Set up global error handlers
addEventListener("error", (event) => {
  logger.error("Uncaught error:", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error
  });
});

addEventListener("unhandledrejection", (event) => {
  logger.error("Unhandled promise rejection:", {
    reason: event.reason
  });
});

const worker = new TrackDiscoveryWorker();

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    await worker.run();
    
    return new Response(JSON.stringify({ success: true }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  } catch (error) {
    logger.error("Worker execution error:", error);
    
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
