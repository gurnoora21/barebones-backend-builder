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

  private async isArtistPrimaryOnTrack(track: any, artistId: string): Promise<boolean> {
    if (track.artists && track.artists.length > 0) {
      const primaryArtistId = track.artists[0].id;
      return primaryArtistId === artistId;
    }
    
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
      console.log(`Found ${tracks.items.length} potential tracks in album ${albumName}`);

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
          const trackDetails = await getTrackDetails(track.id);
          
          const isPrimaryArtist = track.artists && 
                                   track.artists.length > 0 && 
                                   track.artists[0].id === artistId;
          
          if (!isPrimaryArtist) {
            console.log(`Skipping track "${track.name}" as ${artistId} is not the primary artist`);
            filteredTracksCount++;
            continue;
          }
          
          const normalizedName = this.normalizeTrackName(track.name);
          
          const { error: trackUpsertError } = await this.supabase
            .from('tracks')
            .upsert({
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
            });

          if (trackUpsertError) {
            console.error('Error upserting track:', trackUpsertError);
            throw trackUpsertError;
          }
          
          try {
            const { data: existingNormalized, error: normalizedSelectError } = await this.supabase
              .from('normalized_tracks')
              .select('id, representative_track_id')
              .eq('normalized_name', normalizedName)
              .eq('artist_id', artistUuid)
              .single();

            if (normalizedSelectError && normalizedSelectError.code !== 'PGRST116') {
              console.error(`Error checking for normalized track ${normalizedName}:`, normalizedSelectError);
              throw normalizedSelectError;
            }

            if (!existingNormalized) {
              const { error: normalizedError } = await this.supabase
                .from('normalized_tracks')
                .upsert({
                  normalized_name: normalizedName,
                  artist_id: artistUuid,
                  representative_track_id: track.id
                });

              if (normalizedError) {
                console.error('Error upserting normalized track:', normalizedError);
                throw normalizedError;
              }
              
              console.log(`Created new normalized track entry: ${normalizedName}`);
            } else {
              console.log(`Found existing normalized track: ${normalizedName}`);
            }
          } catch (normalizedError) {
            console.error(`Error handling normalized track ${normalizedName}:`, normalizedError);
          }
          
          await this.enqueue('producer_identification', {
            trackId: track.id,
            trackName: track.name,
            albumId,
            artistId
          });
          
          console.log(`Enqueued producer identification for track: ${track.name} (${track.id})`);
          
          validTracksCount++;
          await wait(200);
        } catch (trackError) {
          console.error(`Error processing track ${track.name}:`, trackError);
        }
      }
      
      console.log(`Processed ${tracks.items.length} tracks, valid: ${validTracksCount}, filtered: ${filteredTracksCount}`);
      
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
