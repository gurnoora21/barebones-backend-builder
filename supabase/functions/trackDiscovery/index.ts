
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
    
    const tracks = await getAlbumTracks(albumId, offset);
    console.log(`Found ${tracks.items.length} tracks in album ${albumName}`);

    // Get album UUID from our database
    const { data: album } = await this.supabase
      .from('albums')
      .select('id')
      .eq('spotify_id', albumId)
      .single();

    if (!album) {
      throw new Error(`Album ${albumId} not found in database`);
    }
    
    for (let i = 0; i < tracks.items.length; i++) {
      const track = tracks.items[i];
      const normalizedName = this.normalizeTrackName(track.name);
      
      // Insert or update track in our database
      const { data: existingTrack } = await this.supabase
        .from('tracks')
        .select('id')
        .eq('spotify_id', track.id)
        .single();

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
        console.log(`Created new track record: ${track.name}`);
      } else {
        trackId = existingTrack.id;
      }
      
      // Handle normalized track entry
      const { data: existingNormalized } = await this.supabase
        .from('normalized_tracks')
        .select('id, representative_track_id')
        .eq('normalized_name', normalizedName)
        .eq('artist_id', artistId)
        .single();

      if (!existingNormalized) {
        const { error: normalizedError } = await this.supabase
          .from('normalized_tracks')
          .insert({
            normalized_name: normalizedName,
            artist_id: artistId,
            representative_track_id: trackId
          });

        if (normalizedError) {
          console.error('Error inserting normalized track:', normalizedError);
          throw normalizedError;
        }
        
        console.log(`Created new normalized track entry: ${normalizedName}`);
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
