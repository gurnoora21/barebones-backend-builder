
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getArtistAlbums, spotifyApi, wait } from "../lib/spotifyClient.ts";

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

  private formatReleaseDate(spotifyReleaseDate: string): string | null {
    if (!spotifyReleaseDate) return null;
    
    if (/^\d{4}$/.test(spotifyReleaseDate)) {
      return `${spotifyReleaseDate}-01-01`;
    } else if (/^\d{4}-\d{2}$/.test(spotifyReleaseDate)) {
      return `${spotifyReleaseDate}-01`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(spotifyReleaseDate)) {
      return spotifyReleaseDate;
    }
    
    console.log(`Unrecognized release date format: ${spotifyReleaseDate}`);
    return null;
  }

  protected async process(msg: AlbumDiscoveryMsg): Promise<void> {
    const { artistId, offset } = msg;
    console.log(`Processing album discovery for artist ${artistId} with offset ${offset}`);
    
    try {
      const albums = await getArtistAlbums(artistId, offset);
      console.log(`Found ${albums.items.length} albums for artist ${artistId} after primary artist filtering`);

      const { data: artist, error: artistError } = await this.supabase
        .from('artists')
        .select('id')
        .eq('spotify_id', artistId)
        .single();

      if (artistError) {
        console.error(`Error finding artist ${artistId} in database:`, artistError);
        throw artistError;
      }

      if (!artist) {
        throw new Error(`Artist ${artistId} not found in database`);
      }
      
      let validAlbumsCount = 0;
      
      for (const album of albums.items) {
        try {
          // Fetch full album details to get high-quality images
          const fullAlbumDetails = await spotifyApi<any>(`albums/${album.id}`);
          const coverUrl = fullAlbumDetails.images?.[0]?.url || null;
          
          const formattedReleaseDate = this.formatReleaseDate(album.release_date);
          
          const { data: existingAlbum, error: selectError } = await this.supabase
            .from('albums')
            .select('id')
            .eq('spotify_id', album.id)
            .single();

          if (selectError && selectError.code !== 'PGRST116') {
            console.error(`Error checking for existing album ${album.id}:`, selectError);
            throw selectError;
          }

          const { error: upsertError } = await this.supabase
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
                images: fullAlbumDetails.images, // Store all images in metadata
                discovery_timestamp: new Date().toISOString()
              }
            });

          if (upsertError) {
            console.error(`Error upserting album ${album.name}:`, upsertError);
            throw upsertError;
          }
          
          console.log(`Upserted album record: ${album.name} (${album.id})`);
          
          await this.enqueue('track_discovery', {
            albumId: album.id,
            albumName: album.name,
            artistId
          });
          
          console.log(`Enqueued track discovery for album: ${album.name}`);
          validAlbumsCount++;
          
          await wait(200);
        } catch (albumError) {
          console.error(`Error processing album ${album.name}:`, albumError);
        }
      }
      
      console.log(`Processed ${albums.items.length} albums, valid: ${validAlbumsCount}`);
      
      if (albums.items.length > 0 && offset + albums.items.length < albums.total) {
        const newOffset = offset + albums.items.length;
        await this.enqueue('album_discovery', { artistId, offset: newOffset });
        console.log(`Enqueued next page of albums for artist ${artistId} with offset ${newOffset}`);
      } else {
        console.log(`Finished processing all albums for artist ${artistId}`);
      }
    } catch (error) {
      console.error(`Error in album discovery for artist ${artistId}:`, error);
      throw error;
    }
  }

  async resetQueue(): Promise<void> {
    try {
      console.log("Resetting album_discovery queue...");
      
      await this.supabase.rpc("pgmq_drop_and_recreate_queue", { queue_name: "album_discovery" });
      
      console.log("Successfully reset album_discovery queue");
      return;
    } catch (error) {
      console.error("Error resetting album_discovery queue:", error);
      throw error;
    }
  }
}

const worker = new AlbumDiscoveryWorker();

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Album Discovery worker received request');
    
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
    console.error("Worker execution error:", error);
    
    return new Response(JSON.stringify({ 
      error: error.message,
      details: error.stack 
    }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
