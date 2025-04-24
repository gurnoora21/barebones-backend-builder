
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getArtistAlbums, wait } from "../lib/spotifyClient.ts";

interface AlbumDiscoveryMsg {
  artistId: string;
  offset: number;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class AlbumDiscoveryWorker extends PageWorker<AlbumDiscoveryMsg> {
  constructor() {
    super('album_discovery', 120);
  }

  protected async process(msg: AlbumDiscoveryMsg): Promise<void> {
    const { artistId, offset } = msg;
    console.log(`Processing album discovery for artist ${artistId} with offset ${offset}`);
    
    const albums = await getArtistAlbums(artistId, offset);
    console.log(`Found ${albums.items.length} albums for artist ${artistId}`);

    // Get artist UUID from our database
    const { data: artist } = await this.supabase
      .from('artists')
      .select('id')
      .eq('spotify_id', artistId)
      .single();

    if (!artist) {
      throw new Error(`Artist ${artistId} not found in database`);
    }
    
    for (let i = 0; i < albums.items.length; i++) {
      const album = albums.items[i];
      
      // Insert or update album in our database
      const { data: existingAlbum } = await this.supabase
        .from('albums')
        .select('id')
        .eq('spotify_id', album.id)
        .single();

      if (!existingAlbum) {
        const { error: insertError } = await this.supabase
          .from('albums')
          .insert({
            spotify_id: album.id,
            artist_id: artist.id,
            name: album.name,
            release_date: album.release_date,
            metadata: {
              source: 'spotify',
              type: album.album_type,
              total_tracks: album.total_tracks
            }
          });

        if (insertError) {
          console.error('Error inserting album:', insertError);
          throw insertError;
        }
      }
      
      await this.enqueue('track_discovery', {
        albumId: album.id,
        albumName: album.name,
        artistId
      });
      
      console.log(`Enqueued track discovery for album: ${album.name} (${album.id})`);
      
      if (i > 0 && i % 5 === 0) {
        await wait(200);
      }
    }
    
    if (offset + albums.items.length < albums.total) {
      const newOffset = offset + albums.items.length;
      
      await this.enqueue('album_discovery', { artistId, offset: newOffset });
      
      console.log(`Enqueued next page of albums for artist ${artistId} with offset ${newOffset}`);
    } else {
      console.log(`Finished processing all albums for artist ${artistId}`);
    }
  }
}

const worker = new AlbumDiscoveryWorker();

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
