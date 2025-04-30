
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

interface Track {
  id: string;
  name: string;
  duration_ms: number;
  popularity: number;
  preview_url: string | null;
  disc_number: number;
  track_number: number;
  artists: Array<{ id: string; name: string }>;
}

interface TrackWithDetails extends Track {
  normalizedName: string;
}

interface TrackInsertData {
  spotify_id: string;
  album_id: string;
  name: string;
  duration_ms: number;
  popularity: number;
  spotify_preview_url: string | null;
  metadata: {
    source: string;
    disc_number: number;
    track_number: number;
    discovery_timestamp: string;
  };
}

interface NormalizedTrackData {
  normalized_name: string;
  artist_id: string;
  representative_track_id: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class TrackDiscoveryWorker extends PageWorker<TrackDiscoveryMsg> {
  private workerLogger = logger.child({ worker: 'TrackDiscoveryWorker' });
  private batchSize = 3; // Reduced from 10 to 3 to reduce concurrency
  
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

  private async isArtistPrimaryOnTrack(track: Track, artistId: string): Promise<boolean> {
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

  private async checkExistingTracks(normalizedNames: string[], artistUuid: string): Promise<Set<string>> {
    if (normalizedNames.length === 0) return new Set<string>();
    
    const dbHelpers = createDbTransactionHelpers(this.supabase as SupabaseClient<Database>);
    
    try {
      return await dbHelpers.withDbRetry(async () => {
        const { data, error } = await this.supabase
          .from('normalized_tracks')
          .select('normalized_name')
          .eq('artist_id', artistUuid)
          .in('normalized_name', normalizedNames);

        if (error) {
          this.workerLogger.error(`Error checking for existing tracks:`, error);
          throw error;
        }
        
        return new Set((data || []).map(row => row.normalized_name));
      });
    } catch (error) {
      this.workerLogger.error(`Failed to check existing tracks:`, error);
      return new Set<string>();
    }
  }
  
  /**
   * Create or update tracks in batches with proper transaction handling
   */
  private async createTracks(
    tracksWithDetails: TrackWithDetails[], 
    albumUuid: string, 
    artistUuid: string
  ): Promise<Map<string, string>> {
    if (tracksWithDetails.length === 0) return new Map();
    
    const traceId = generateTraceId();
    const contextLogger = this.workerLogger.child({ 
      operation: 'createTracks',
      batchSize: tracksWithDetails.length,
      traceId
    });
    
    const dbHelpers = createDbTransactionHelpers(this.supabase as SupabaseClient<Database>);
    
    try {
      return await dbHelpers.withTransaction(async (tx) => {
        const trackIdMap = new Map<string, string>();
        contextLogger.debug(`Processing batch of ${tracksWithDetails.length} tracks`);
        
        // 1. Prepare track data for insertion
        const tracksToInsert: TrackInsertData[] = tracksWithDetails.map(track => ({
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
        }));
        
        // 2. Insert tracks in a batch
        const { data: trackData, error: trackInsertError } = await this.supabase
          .from('tracks')
          .upsert(tracksToInsert)
          .select('id, spotify_id');

        if (trackInsertError) {
          contextLogger.error('Error upserting tracks batch:', trackInsertError);
          throw trackInsertError;
        }
        
        // Map spotify_id to UUID for later use
        (trackData || []).forEach(track => {
          trackIdMap.set(track.spotify_id, track.id);
        });
        
        // 3. Prepare normalized track data for insertion
        const normalizedTracksToInsert: NormalizedTrackData[] = tracksWithDetails.map(track => ({
          normalized_name: track.normalizedName,
          artist_id: artistUuid,
          representative_track_id: track.id
        }));
        
        // 4. Insert normalized tracks in a batch
        const { error: normalizedError } = await withRetry(async () => {
          return this.supabase
            .from('normalized_tracks')
            .upsert(normalizedTracksToInsert);
        }, {
          maxAttempts: 3,
          initialDelayMs: 200
        });

        if (normalizedError) {
          contextLogger.error('Error upserting normalized tracks batch:', normalizedError);
          throw normalizedError;
        }
        
        return trackIdMap;
      });
    } catch (error) {
      contextLogger.error(`Error in batch track creation:`, error);
      return new Map();
    }
  }
  
  /**
   * Process tracks sequentially rather than in parallel batches
   */
  private async processTracks(
    tracks: Track[],
    artistId: string,
    artistUuid: string,
    albumUuid: string,
    albumId: string
  ): Promise<{ validCount: number; filteredCount: number; duplicateCount: number }> {
    const stats = {
      validCount: 0,
      filteredCount: 0,
      duplicateCount: 0
    };
    
    if (tracks.length === 0) return stats;
    
    const detailedTracks: TrackWithDetails[] = [];
    const normalizedNames: string[] = [];
    
    // First prepare all tracks
    for (const track of tracks) {
      try {
        const isPrimaryArtist = await this.isArtistPrimaryOnTrack(track, artistId);
        
        if (!isPrimaryArtist) {
          this.workerLogger.debug(`Skipping track "${track.name}" as ${artistId} is not the primary artist`);
          stats.filteredCount++;
          continue;
        }
        
        const normalizedName = this.normalizeTrackName(track.name);
        normalizedNames.push(normalizedName);
        
        // Add to detailed tracks
        detailedTracks.push({
          ...track,
          normalizedName
        });
      } catch (error) {
        this.workerLogger.error(`Error processing track ${track.name}:`, error);
      }
    }
    
    if (detailedTracks.length === 0) return stats;
    
    // Get existing tracks to filter out duplicates
    const existingTracks = await this.checkExistingTracks(normalizedNames, artistUuid);
    
    // Filter out already existing tracks
    const newTracks = detailedTracks.filter(track => {
      const exists = existingTracks.has(track.normalizedName);
      if (exists) stats.duplicateCount++;
      return !exists;
    });
    
    if (newTracks.length === 0) {
      return stats;
    }
    
    // Process tracks in smaller batches
    for (let i = 0; i < newTracks.length; i += this.batchSize) {
      const batch = newTracks.slice(i, i + this.batchSize);
      
      // Process tracks sequentially instead of using Promise.all
      const batchDetailedTracks: TrackWithDetails[] = [];
      for (const track of batch) {
        try {
          // Add delay between each track detail request
          await wait(800); // Added delay between API calls
          
          const trackDetails = await getTrackDetails(track.id);
          batchDetailedTracks.push({
            ...track,
            popularity: trackDetails.popularity,
            preview_url: trackDetails.preview_url
          });
          
          this.workerLogger.debug(`Fetched details for track: ${track.name}`);
        } catch (error) {
          this.workerLogger.error(`Error fetching details for track ${track.id}:`, error);
          // Return original track if can't get details
          batchDetailedTracks.push(track);
        }
      }
      
      // Create tracks and process results
      const trackUuids = await this.createTracks(batchDetailedTracks, albumUuid, artistUuid);
      
      // Enqueue producer identification for successfully created tracks
      for (const track of batchDetailedTracks) {
        if (trackUuids.has(track.id)) {
          await this.enqueue('producer_identification', {
            trackId: track.id,
            trackName: track.name,
            albumId,
            artistId
          });
          
          this.workerLogger.debug(`Enqueued producer identification for track "${track.name}"`);
          stats.validCount++;
        }
      }
      
      // Add a significant delay between batches to avoid rate limits
      if (i + this.batchSize < newTracks.length) {
        await wait(2000); // Increased from 1000ms to 2000ms
      }
    }
    
    return stats;
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
      
      // Add delay before fetching tracks
      await wait(500); // New delay before fetching album tracks
      
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
      
      // Process tracks in batches
      const stats = await this.processTracks(
        tracks.items, 
        artistId, 
        artistUuid, 
        album.id,
        albumId
      );
      
      contextLogger.info(`Processed ${tracks.items.length} tracks`, { 
        valid: stats.validCount, 
        filtered: stats.filteredCount, 
        duplicates: stats.duplicateCount 
      });
      
      // If we have more tracks to process, enqueue the next batch
      if (tracks.items.length > 0 && offset + tracks.items.length < tracks.total && stats.validCount > 0) {
        // Add more delay between pagination
        await wait(2000); // Increased from default delay
        
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
