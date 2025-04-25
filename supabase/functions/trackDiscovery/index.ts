
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getAlbumTracks, wait } from "../lib/spotifyClient.ts";

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
  constructor() {
    super('track_discovery', 60);
  }

  private normalizeTrackName(name: string): string {
    return name
      .toLowerCase()
      .replace(/\(.*?\)/g, '') // Remove parentheses and their contents
      .replace(/\[.*?\]/g, '') // Remove square brackets and their contents
      .replace(/feat\.|ft\./g, '') // Remove feat. or ft.
      .replace(/[^\w\s]/g, '') // Remove special characters
      .trim()
      .replace(/\s+/g, ' '); // Normalize whitespace
  }

  protected async process(msg: TrackDiscoveryMsg): Promise<void> {
    const { albumId, albumName, artistId, offset = 0 } = msg;
    console.log(`Processing track discovery for album ${albumName} (${albumId}) with offset ${offset}`);
    
    try {
      // Get artist record from database using Spotify ID
      const { data: artistData, error: artistError } = await this.supabase
        .from('artists')
        .select('id')
        .eq('spotify_id', artistId)
        .single();

      if (artistError) {
        console.error(`Error finding artist with Spotify ID ${artistId}:`, artistError);
        throw this.categorizeError({
          category: "MISSING_RECORD",
          message: `Artist with Spotify ID ${artistId} not found in database`,
          retryable: false
        });
      }

      if (!artistData) {
        throw this.categorizeError({
          category: "MISSING_RECORD",
          message: `Artist with Spotify ID ${artistId} not found in database`,
          retryable: false
        });
      }

      const artistUuid = artistData.id;
      console.log(`Found artist UUID ${artistUuid} for Spotify ID ${artistId}`);
      
      const tracks = await getAlbumTracks(albumId, offset);
      console.log(`Found ${tracks.items.length} tracks in album ${albumName}`);

      // Get album UUID from our database
      const { data: album, error: albumError } = await this.supabase
        .from('albums')
        .select('id')
        .eq('spotify_id', albumId)
        .single();

      if (albumError) {
        console.error(`Error finding album ${albumId} in database:`, albumError);
        throw this.categorizeError({
          category: "MISSING_RECORD",
          message: `Album with Spotify ID ${albumId} not found in database`,
          retryable: false
        });
      }

      if (!album) {
        throw this.categorizeError({
          category: "MISSING_RECORD",
          message: `Album with Spotify ID ${albumId} not found in database`,
          retryable: false
        });
      }
      
      for (let i = 0; i < tracks.items.length; i++) {
        const track = tracks.items[i];
        const normalizedName = this.normalizeTrackName(track.name);
        
        try {
          // Insert or update track in our database
          const { data: existingTrack, error: selectError } = await this.supabase
            .from('tracks')
            .select('id')
            .eq('spotify_id', track.id)
            .single();

          if (selectError && selectError.code !== 'PGRST116') { // Not a "no rows" error
            console.error(`Error checking for existing track ${track.id}:`, selectError);
            throw selectError;
          }

          let trackId: string;
          if (!existingTrack) {
            const { data: newTrack, error: insertError } = await this.supabase
              .from('tracks')
              .insert({
                spotify_id: track.id,
                album_id: album.id,
                name: track.name,
                duration_ms: track.duration_ms,
                metadata: {
                  source: 'spotify',
                  disc_number: track.disc_number,
                  track_number: track.track_number,
                  discovery_timestamp: new Date().toISOString()
                }
              })
              .select('id')
              .single();

            if (insertError) {
              console.error('Error inserting track:', insertError);
              throw insertError;
            }
            
            trackId = newTrack.id;
            console.log(`Created new track record: ${track.name} (${track.id})`);
          } else {
            trackId = existingTrack.id;
            console.log(`Found existing track: ${track.name} (${track.id})`);
          }
          
          // Handle normalized track entry - use the artist UUID from our database, not the Spotify ID
          try {
            const { data: existingNormalized, error: normalizedSelectError } = await this.supabase
              .from('normalized_tracks')
              .select('id, representative_track_id')
              .eq('normalized_name', normalizedName)
              .eq('artist_id', artistUuid) // Use artist UUID, not Spotify ID
              .single();

            if (normalizedSelectError && normalizedSelectError.code !== 'PGRST116') { // Not a "no rows" error
              console.error(`Error checking for normalized track ${normalizedName}:`, normalizedSelectError);
              throw normalizedSelectError;
            }

            if (!existingNormalized) {
              const { error: normalizedError } = await this.supabase
                .from('normalized_tracks')
                .insert({
                  normalized_name: normalizedName,
                  artist_id: artistUuid, // Use artist UUID, not Spotify ID
                  representative_track_id: trackId
                });

              if (normalizedError) {
                console.error('Error inserting normalized track:', normalizedError);
                throw normalizedError;
              }
              
              console.log(`Created new normalized track entry: ${normalizedName}`);
            } else {
              console.log(`Found existing normalized track: ${normalizedName}`);
            }
          } catch (normalizedError) {
            console.error(`Error handling normalized track ${normalizedName}:`, normalizedError);
            // Continue processing other tracks even if normalized track fails
          }
          
          // Queue producer identification
          await this.enqueue('producer_identification', {
            trackId: track.id,
            trackName: track.name,
            albumId,
            artistId
          });
          
          console.log(`Enqueued producer identification for track: ${track.name} (${track.id})`);
          
          if (i > 0 && i % 5 === 0) {
            await wait(200);
          }
        } catch (trackError) {
          console.error(`Error processing track ${track.name} (${track.id}):`, trackError);
          // Continue with next track even if one fails
        }
      }
      
      if (offset + tracks.items.length < tracks.total) {
        const newOffset = offset + tracks.items.length;
        
        await this.enqueue('track_discovery', {
          albumId,
          albumName,
          artistId,
          offset: newOffset
        });
        
        console.log(`Enqueued next page of tracks for album ${albumName} with offset ${newOffset}`);
      } else {
        console.log(`Finished processing all tracks for album ${albumName}`);
      }
    } catch (error) {
      console.error(`Comprehensive error in track discovery for album ${albumName} (${albumId}):`, error);
      throw error; // Re-throw to allow PageWorker to handle
    }
  }
}

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
    console.error("Worker execution error:", error);
    
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
