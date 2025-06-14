
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getArtistAlbums, spotifyApi, wait } from "../lib/spotifyClient.ts";
import { logger } from "../lib/logger.ts";
import { validate as uuidValidate } from "https://deno.land/std@0.178.0/uuid/mod.ts";

interface AlbumDiscoveryMsg {
  artistId: string;
  offset: number;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class AlbumDiscoveryWorker extends PageWorker<AlbumDiscoveryMsg> {
  private workerLogger = logger.child({ worker: 'AlbumDiscoveryWorker' });
  private processedAlbums = new Set<string>(); // Track albums we've processed in this run
  
  constructor() {
    super('album_discovery', 120);
    // Reduce batch size from default to 2
    this.batchProcessor.batchSize = 2;
  }

  /**
   * Validates if the string is a valid UUID
   */
  private isValidUuid(id: string): boolean {
    return uuidValidate(id);
  }

  private formatReleaseDate(spotifyReleaseDate: string): string | null {
    if (!spotifyReleaseDate) return null;
    
    if (/^\d{4}$/.test(spotifyReleaseDate)) {
      return `${spotifyReleaseDate}-01-01`;
    } else if (/^\d{4}-\d{2}$/.test(spotifyReleaseDate)) {
      return `${spotifyReleaseDate}-01`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(spotifyReleaseDate)) {
      return spotifyReleaseDate;
    }
    
    this.workerLogger.warn(`Unrecognized release date format: ${spotifyReleaseDate}`);
    return null;
  }

  /**
   * Check if an album has already been processed in the current run
   * This provides in-memory deduplication to prevent processing the same album multiple times
   */
  private isDuplicate(albumId: string): boolean {
    if (this.processedAlbums.has(albumId)) {
      this.workerLogger.debug(`Skipping duplicate album ${albumId} (already processed in this run)`);
      return true;
    }
    this.processedAlbums.add(albumId);
    return false;
  }

  /**
   * Check if an album already exists in the database
   */
  private async albumExists(spotifyId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('albums')
      .select('id')
      .eq('spotify_id', spotifyId)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      this.workerLogger.error(`Error checking album existence for ${spotifyId}:`, error);
      return false; // Assume it doesn't exist on error
    }
    
    return !!data;
  }

  /**
   * Safely retrieves an album ID given a Spotify ID, handling potential conflicts
   * @param spotifyId The Spotify album ID
   * @param albumName Album name for logging
   * @returns The database UUID of the album (existing or newly inserted)
   */
  private async getOrUpsertAlbum(album: any, artist: { id: string }, coverUrl: string | null, formattedReleaseDate: string | null): Promise<string | null> {
    try {
      // Use upsert with onConflict to handle duplicate spotify_id values
      const { data: insertedAlbum, error: upsertError } = await this.supabase
        .from('albums')
        .upsert({
          spotify_id: album.id,
          artist_id: artist.id,
          name: album.name,
          release_date: formattedReleaseDate,
          cover_url: coverUrl, // Store the cover URL
          metadata: {
            source: 'spotify',
            type: album.album_type,
            total_tracks: album.total_tracks,
            images: album.images, // Store all images in metadata
            discovery_timestamp: new Date().toISOString()
          }
        }, {
          onConflict: 'spotify_id', // Add onConflict option to handle duplicates
          ignoreDuplicates: false // Update existing records
        })
        .select('id, spotify_id')
        .single();

      if (upsertError) {
        // Check if this is a unique constraint violation (code 23505)
        if (upsertError.code === '23505') {
          this.workerLogger.info(`Conflict on album ${album.name}, fetching existing ID`);
          
          // Fetch the existing album record instead of failing
          const { data: existingAlbum, error: fetchError } = await this.supabase
            .from('albums')
            .select('id')
            .eq('spotify_id', album.id)
            .single();
            
          if (fetchError) {
            this.workerLogger.error(`Error fetching existing album ${album.name} after conflict:`, fetchError);
            return null;
          }
          
          if (!existingAlbum || !this.isValidUuid(existingAlbum.id)) {
            this.workerLogger.warn(`Invalid or missing album UUID for ${album.name} after conflict resolution`);
            return null;
          }
          
          this.workerLogger.info(`Resolved duplicate album ${album.name} (${album.id}), using UUID ${existingAlbum.id}`);
          return existingAlbum.id;
        } else {
          // For other types of errors, log and return null
          this.workerLogger.error(`Error upserting album ${album.name}:`, upsertError);
          return null;
        }
      }
      
      this.workerLogger.info(`Upserted album record: ${album.name} (${album.id}) with UUID ${insertedAlbum.id}`);
      
      if (!insertedAlbum || !this.isValidUuid(insertedAlbum.id)) {
        this.workerLogger.warn(`Invalid or missing album UUID for ${album.name}, skipping track discovery`);
        return null;
      }
      
      return insertedAlbum.id;
    } catch (error) {
      this.workerLogger.error(`Unexpected error processing album ${album.name}:`, error);
      return null;
    }
  }

  protected async process(msg: AlbumDiscoveryMsg): Promise<void> {
    const { artistId, offset } = msg;
    this.workerLogger.info(`Processing album discovery for artist ${artistId} with offset ${offset}`);
    
    try {
      const albums = await getArtistAlbums(artistId, offset);
      this.workerLogger.info(`Found ${albums.items.length} albums for artist ${artistId} after primary artist filtering`);

      const { data: artist, error: artistError } = await this.supabase
        .from('artists')
        .select('id')
        .eq('spotify_id', artistId)
        .single();

      if (artistError) {
        this.workerLogger.error(`Error finding artist ${artistId} in database:`, artistError);
        throw artistError;
      }

      if (!artist) {
        throw new Error(`Artist ${artistId} not found in database`);
      }
      
      if (!this.isValidUuid(artist.id)) {
        throw new Error(`Invalid artist UUID format: ${artist.id}`);
      }
      
      let validAlbumsCount = 0;
      
      // Process albums with increased delays between each album
      for (const album of albums.items) {
        try {
          // Skip if we've already processed this album in the current run
          if (this.isDuplicate(album.id)) {
            continue;
          }

          // Add a delay between each album processing to reduce API pressure
          await wait(750); // Increased from 500ms to 750ms
          
          // Fetch full album details to get high-quality images
          const fullAlbumDetails = await spotifyApi<any>(`albums/${album.id}`, { timeout: 20000 });
          const coverUrl = fullAlbumDetails.images?.[0]?.url || null;
          
          const formattedReleaseDate = this.formatReleaseDate(album.release_date);
          
          // Use our new robust method to get or create the album
          const albumUuid = await this.getOrUpsertAlbum(
            { ...album, images: fullAlbumDetails.images },
            artist,
            coverUrl,
            formattedReleaseDate
          );
          
          if (!albumUuid) {
            this.workerLogger.warn(`Could not get or create album ${album.name}, skipping track discovery`);
            continue;
          }
          
          // Delay before queueing track discovery
          await wait(750); // Increased delay before queueing track discovery
          
          await this.enqueue('track_discovery', {
            albumId: album.id,
            albumUuid: albumUuid, // Send the database UUID along with the message
            albumName: album.name,
            artistId
          });
          
          this.workerLogger.info(`Enqueued track discovery for album: ${album.name}`);
          validAlbumsCount++;
          
          // Additional wait to respect rate limits
          await wait(1250); // Increased from 1000ms to 1250ms
        } catch (albumError) {
          this.workerLogger.error(`Error processing album ${album.name}:`, albumError);
        }
      }
      
      this.workerLogger.info(`Processed ${albums.items.length} albums, valid: ${validAlbumsCount}`);
      
      if (albums.items.length > 0 && offset + albums.items.length < albums.total) {
        const newOffset = offset + albums.items.length;
        // Add a longer delay before enqueueing the next page to reduce overall throughput
        await wait(3000); // Increased from 2000ms to 3000ms
        await this.enqueue('album_discovery', { artistId, offset: newOffset });
        this.workerLogger.info(`Enqueued next page of albums for artist ${artistId} with offset ${newOffset}`);
      } else {
        this.workerLogger.info(`Finished processing all albums for artist ${artistId}`);
      }
    } catch (error) {
      this.workerLogger.error(`Error in album discovery for artist ${artistId}:`, error);
      throw error;
    }
  }

  async resetQueue(): Promise<void> {
    try {
      this.workerLogger.info("Resetting album_discovery queue...");
      
      await this.supabase.rpc("pgmq_drop_and_recreate_queue", { queue_name: "album_discovery" });
      
      this.workerLogger.info("Successfully reset album_discovery queue");
      return;
    } catch (error) {
      this.workerLogger.error("Error resetting album_discovery queue:", error);
      throw error;
    }
  }
  
  /**
   * Implement health check endpoint
   */
  async getHealthStatus(): Promise<object> {
    try {
      // Get queue statistics
      const { data: queueStats, error } = await this.supabase.rpc(
        'pgmq_read', 
        { 
          queue_name: 'album_discovery', 
          visibility_timeout: 0,
          batch_size: 1
        }
      );
      
      // Count pending messages
      const pendingMessagesCount = queueStats?.length || 0;
      
      return {
        status: 'healthy',
        queue: 'album_discovery',
        pendingMessages: pendingMessagesCount,
        workerTimeout: 120,
        deduplicationEnabled: true,
        processedAlbumsCount: this.processedAlbums.size
      };
    } catch (e) {
      return {
        status: 'unhealthy',
        error: e.message
      };
    }
  }
}

const worker = new AlbumDiscoveryWorker();

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logger.info('Album Discovery worker received request');
    
    // Handle health check endpoint
    const url = new URL(req.url);
    
    if (url.pathname.endsWith('/health')) {
      const healthStatus = await worker.getHealthStatus();
      
      return new Response(JSON.stringify(healthStatus), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
    
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      
      if (body?.action === 'reset') {
        await worker.resetQueue();
        return new Response(JSON.stringify({ success: true, message: 'Queue reset successfully' }), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }
    }
    
    await worker.run();
    
    return new Response(JSON.stringify({ success: true }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  } catch (error) {
    logger.error("Worker execution error:", error);
    
    return new Response(JSON.stringify({ 
      error: error.message,
      details: error.stack 
    }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
