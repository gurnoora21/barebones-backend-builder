import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getAlbumTracks, getTrackDetails, wait } from "../lib/spotifyClient.ts";

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

  // Check if the artist is the primary artist on this track
  private async isArtistPrimaryOnTrack(track: any, artistId: string): Promise<boolean> {
    if (track.artists && track.artists.length > 0) {
      const primaryArtistId = track.artists[0].id;
      return primaryArtistId === artistId;
    }
    
    // If we need more details that aren't in the basic track info
    try {
      const details = await getTrackDetails(track.id);
      return details.artists && details.artists.length > 0 && details.artists[0].id === artistId;
    } catch (error) {
      console.error(`Error fetching track details for ${track.id}:`, error);
      return false;
    }
  }

  protected async process(msg: TrackDiscoveryMsg): Promise<void> {
    const { albumId, albumName, artistId, offset = 0 } = msg;
    console.log(`Processing track discovery for album ${albumName} (${albumId}) with offset ${offset}`);
    
    try {
      // Get artist record from database
      const { data: artistData, error: artistError } = await this.supabase
        .from('artists')
        .select('id')
        .eq('spotify_id', artistId)
        .single();

      if (artistError || !artistData) {
        throw new Error(`Artist ${artistId} not found in database`);
      }

      // Use the artist UUID from the database for all further operations
      const artistUuid = artistData.id;

      const tracks = await getAlbumTracks(albumId, offset);
      console.log(`Found ${tracks.items.length} potential tracks in album ${albumName}`);

      // Get album UUID from database
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
      
      for (const track of tracks.items) {
        try {
          // Fetch detailed track information from Spotify
          const trackDetails = await getTrackDetails(track.id);
          
          // Verify this is a track where our artist is primary
          const isPrimaryArtist = track.artists && 
                                   track.artists.length > 0 && 
                                   track.artists[0].id === artistId;
          
          if (!isPrimaryArtist) {
            console.log(`Skipping track "${track.name}" as ${artistId} is not the primary artist`);
            filteredTracksCount++;
            continue;
          }
          
          const normalizedName = this.normalizeTrackName(track.name);
          
          // Prepare track update data
          const trackUpdateData = {
            spotify_id: track.id,
            album_id: album.id,
            name: track.name,
            duration_ms: track.duration_ms,
            popularity: trackDetails.popularity,
            spotify_preview_url: trackDetails.preview_url,
            metadata: {
              source: 'spotify',
              disc_number: track.disc_number,
              track_number: track.track_number,
              discovery_timestamp: new Date().toISOString()
            }
          };

          // Insert or update track
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
              .insert(trackUpdateData)
              .select('id')
              .single();

            if (insertError) {
              console.error('Error inserting track:', insertError);
              throw insertError;
            }
            
            trackId = newTrack.id;
            console.log(`Created new track record: ${track.name} (${track.id})`);
          } else {
            const { error: updateError } = await this.supabase
              .from('tracks')
              .update(trackUpdateData)
              .eq('id', existingTrack.id);

            if (updateError) {
              console.error('Error updating track:', updateError);
              throw updateError;
            }

            trackId = existingTrack.id;
            console.log(`Updated existing track: ${track.name} (${track.id})`);
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
          
          validTracksCount++;
          await wait(200); // Rate limiting protection
        } catch (trackError) {
          console.error(`Error processing track ${track.name}:`, trackError);
        }
      }
      
      console.log(`Processed ${tracks.items.length} tracks, valid: ${validTracksCount}, filtered: ${filteredTracksCount}`);
      
      // Queue next page if there are more tracks and we found valid ones
      if (tracks.items.length > 0 && offset + tracks.items.length < tracks.total && validTracksCount > 0) {
        const newOffset = offset + tracks.items.length;
        await this.enqueue('track_discovery', {
          albumId,
          albumName,
          artistId,
          offset: newOffset
        });
        console.log(`Enqueued next page of tracks for album ${albumName}`);
      } else {
        console.log(`Finished processing all tracks for album ${albumName}`);
      }
    } catch (error) {
      console.error(`Error in track discovery for album ${albumName}:`, error);
      throw error;
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
