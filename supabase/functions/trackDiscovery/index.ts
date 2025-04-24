
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getAlbumTracks, wait } from "../lib/spotifyClient.ts";

// Define the message type for track discovery
interface TrackDiscoveryMsg {
  albumId: string;
  albumName: string;
  artistId: string;
  offset?: number;
}

// Define CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class TrackDiscoveryWorker extends PageWorker<TrackDiscoveryMsg> {
  constructor() {
    // Use 60s visibility timeout
    super('track_discovery', 60);
  }

  protected async process(msg: TrackDiscoveryMsg): Promise<void> {
    const { albumId, albumName, artistId, offset = 0 } = msg;
    console.log(`Processing track discovery for album ${albumName} (${albumId}) with offset ${offset}`);
    
    // Call Spotify API to get all tracks in the album
    const tracks = await getAlbumTracks(albumId, offset);
    console.log(`Found ${tracks.items.length} tracks in album ${albumName}`);
    
    // Process each track (with a small delay between batches to avoid rate limiting)
    for (let i = 0; i < tracks.items.length; i++) {
      const track = tracks.items[i];
      
      await this.enqueue('producer_identification', {
        trackId: track.id,
        trackName: track.name,
        albumId,
        artistId
      });
      
      console.log(`Enqueued producer identification for track: ${track.name} (${track.id})`);
      
      // Add a small delay every 5 tracks to avoid hammering the API
      if (i > 0 && i % 5 === 0) {
        await wait(200);
      }
    }
    
    // Handle pagination if needed
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

// Initialize the worker
const worker = new TrackDiscoveryWorker();

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
