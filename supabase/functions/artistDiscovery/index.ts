
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getSpotifyArtistId } from "../lib/spotifyClient.ts";

// Define the message type for artist discovery
interface ArtistDiscoveryMsg {
  artistId?: string;
  artistName?: string;
}

// Define CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class ArtistDiscoveryWorker extends PageWorker<ArtistDiscoveryMsg> {
  constructor() {
    // Use 60s visibility timeout
    super('artist_discovery', 60);
  }

  protected async process(msg: ArtistDiscoveryMsg): Promise<void> {
    console.log(`Processing artist discovery message:`, msg);
    
    let artistId = msg.artistId;
    
    // If given a name, look up the ID
    if (!artistId && msg.artistName) {
      console.log(`Looking up artist ID for name: ${msg.artistName}`);
      artistId = await getSpotifyArtistId(msg.artistName);
      
      if (!artistId) {
        throw new Error(`Artist not found: ${msg.artistName}`);
      }
      
      console.log(`Found artist ID: ${artistId} for name: ${msg.artistName}`);
    }
    
    if (!artistId) {
      throw new Error('No artistId or artistName provided');
    }

    // Enqueue album discovery with offset 0
    const albumMsg = { artistId, offset: 0 };
    
    await this.enqueue('album_discovery', albumMsg);
    
    console.log(`Enqueued album discovery task for artist ${artistId}`);
  }
}

// Initialize the worker
const worker = new ArtistDiscoveryWorker();

serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Handle manual message creation if POST with body
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        
        if (body.artistId || body.artistName) {
          const message = {
            artistId: body.artistId,
            artistName: body.artistName
          };
          
          await worker.enqueue('artist_discovery', message);
          
          console.log(`Manually enqueued artist discovery task`);
          return new Response(JSON.stringify({ success: true, message: 'Artist discovery task enqueued' }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }
      } catch (e) {
        console.log("No valid JSON body or not adding a manual message");
      }
    }
    
    // Always run the worker to process queued messages
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
