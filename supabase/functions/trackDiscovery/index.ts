
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { BaseWorker } from "../lib/baseWorker.ts";
import { getAlbumTracks, wait } from "../lib/spotifyClient.ts";

// Define the message type for track discovery
interface TrackDiscoveryMsg {
  albumId: string;
  albumName: string;
  artistId: string;
}

// Define CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class TrackDiscoveryWorker extends BaseWorker<TrackDiscoveryMsg> {
  constructor() {
    // Use 60s visibility timeout and batch size of 10
    super('track_discovery', 60, 10);
  }

  protected async processMessage(msg: TrackDiscoveryMsg, msgId: number): Promise<void> {
    const { albumId, albumName, artistId } = msg;
    console.log(`Processing track discovery for album ${albumName} (${albumId})`);
    
    // Call Spotify API to get all tracks in the album
    const tracks = await getAlbumTracks(albumId);
    console.log(`Found ${tracks.length} tracks in album ${albumName}`);
    
    // Process each track (with a small delay between batches to avoid rate limiting)
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      
      await this.supabase.rpc('pgmq_send', {
        queue_name: 'producer_identification',
        msg: {
          trackId: track.id,
          trackName: track.name,
          albumId,
          artistId
        }
      });
      
      console.log(`Enqueued producer identification for track: ${track.name} (${track.id})`);
      
      // Add a small delay every 5 tracks to avoid hammering the API
      if (i > 0 && i % 5 === 0) {
        await wait(200);
      }
    }
    
    console.log(`Finished processing all tracks for album ${albumName}`);
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
