
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { BaseWorker } from "../lib/baseWorker.ts";
import { getArtistAlbums, wait } from "../lib/spotifyClient.ts";

// Define the message type for album discovery
interface AlbumDiscoveryMsg {
  artistId: string;
  offset: number;
}

// Define CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class AlbumDiscoveryWorker extends BaseWorker<AlbumDiscoveryMsg> {
  constructor() {
    // Use 120s visibility timeout due to potential API latency and batch size of 5
    super('album_discovery', 120, 5);
  }

  protected async processMessage(msg: AlbumDiscoveryMsg, msgId: number): Promise<void> {
    const { artistId, offset } = msg;
    console.log(`Processing album discovery for artist ${artistId} with offset ${offset}`);
    
    // Call Spotify API to get up to 50 albums from offset
    const albums = await getArtistAlbums(artistId, offset);
    console.log(`Found ${albums.items.length} albums for artist ${artistId}`);
    
    // Process each album (with a small delay between batches to avoid rate limiting)
    for (let i = 0; i < albums.items.length; i++) {
      const album = albums.items[i];
      
      // Enqueue track discovery for this album
      await this.supabase.rpc('pgmq_send', {
        queue_name: 'track_discovery',
        msg: {
          albumId: album.id,
          albumName: album.name,
          artistId
        }
      });
      
      console.log(`Enqueued track discovery for album: ${album.name} (${album.id})`);
      
      // Add a small delay every 5 albums to avoid hammering the API
      if (i > 0 && i % 5 === 0) {
        await wait(200);
      }
    }
    
    // If Spotify indicates more albums (offset + limit < total), requeue for next page
    if (offset + albums.items.length < albums.total) {
      const newOffset = offset + albums.items.length;
      
      await this.supabase.rpc('pgmq_send', {
        queue_name: 'album_discovery',
        msg: { artistId, offset: newOffset }
      });
      
      console.log(`Enqueued next page of albums for artist ${artistId} with offset ${newOffset}`);
    } else {
      console.log(`Finished processing all albums for artist ${artistId}`);
    }
  }
}

// Initialize the worker
const worker = new AlbumDiscoveryWorker();

serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Run the worker
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
