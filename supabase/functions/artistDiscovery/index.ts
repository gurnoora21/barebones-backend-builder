
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getSpotifyArtistId } from "../lib/spotifyClient.ts";

interface ArtistDiscoveryMsg {
  artistId?: string;
  artistName?: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class ArtistDiscoveryWorker extends PageWorker<ArtistDiscoveryMsg> {
  constructor() {
    super('artist_discovery', 60);
  }

  protected async process(msg: ArtistDiscoveryMsg): Promise<void> {
    console.log(`Processing artist discovery message:`, msg);
    
    let artistId = msg.artistId;
    
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

    // Insert or update artist in our database
    const { data: existingArtist } = await this.supabase
      .from('artists')
      .select('id')
      .eq('spotify_id', artistId)
      .single();

    if (!existingArtist) {
      const { error: insertError } = await this.supabase
        .from('artists')
        .insert({
          spotify_id: artistId,
          name: msg.artistName || artistId,
          metadata: { source: 'spotify' }
        });

      if (insertError) {
        console.error('Error inserting artist:', insertError);
        throw insertError;
      }
    }

    // Enqueue album discovery with offset 0
    await this.enqueue('album_discovery', { 
      artistId,
      offset: 0
    });
    
    console.log(`Enqueued album discovery task for artist ${artistId}`);
  }
}

const worker = new ArtistDiscoveryWorker();

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        
        if (body.artistId || body.artistName) {
          await worker.enqueue('artist_discovery', {
            artistId: body.artistId,
            artistName: body.artistName
          });
          
          return new Response(JSON.stringify({ success: true, message: 'Artist discovery task enqueued' }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }
      } catch (e) {
        console.log("No valid JSON body or not adding a manual message");
      }
    }
    
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
