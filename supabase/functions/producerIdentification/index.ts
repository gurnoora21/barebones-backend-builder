
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getTrackDetails } from "../lib/spotifyClient.ts";

// Define the message type for producer identification
interface ProducerIdentificationMsg {
  trackId: string;
  trackName: string;
  albumId: string;
  artistId: string;
}

// Define CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class ProducerIdentificationWorker extends PageWorker<ProducerIdentificationMsg> {
  constructor() {
    // Use 60s visibility timeout
    super('producer_identification', 60);
  }

  protected async process(msg: ProducerIdentificationMsg): Promise<void> {
    const { trackId, trackName, albumId, artistId } = msg;
    console.log(`Processing producer identification for track ${trackName} (${trackId})`);
    
    // Fetch track details (including artists and possibly additional credits)
    const track = await getTrackDetails(trackId);
    console.log(`Found ${track.artists.length} artists/collaborators for track ${trackName}`);
    
    // Process each artist/collaborator
    for (const artist of track.artists) {
      if (artist.id !== artistId) {  // Skip the main artist
        await this.enqueue('social_enrichment', { 
          producerName: artist.name 
        });
        
        console.log(`Enqueued social enrichment for producer: ${artist.name}`);
      }
    }
    
    console.log(`Finished processing collaborators for track ${trackName}`);
  }
}

// Initialize the worker
const worker = new ProducerIdentificationWorker();

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
