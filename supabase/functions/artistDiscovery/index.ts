
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
    
    // Enhanced logging for input validation
    if (!msg.artistId && !msg.artistName) {
      const errorMsg = 'No artist ID or name provided';
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    
    let artistId = msg.artistId;
    
    // Detailed logging for artist ID resolution
    if (!artistId && msg.artistName) {
      console.log(`Looking up artist ID for name: ${msg.artistName}`);
      try {
        artistId = await getSpotifyArtistId(msg.artistName);
      } catch (error) {
        console.error(`Failed to resolve artist ID for name ${msg.artistName}:`, error);
        throw error;
      }
      
      if (!artistId) {
        const errorMsg = `Artist not found: ${msg.artistName}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
      
      console.log(`Found artist ID: ${artistId} for name: ${msg.artistName}`);
    }
    
    if (!artistId) {
      const errorMsg = 'No artistId or artistName provided';
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    // Additional error handling for database operations
    try {
      // Check if artist already exists
      const { data: existingArtist, error: selectError } = await this.supabase
        .from('artists')
        .select('id')
        .eq('spotify_id', artistId)
        .single();

      if (selectError && selectError.code !== 'PGRST116') {  // Not a "no rows" error
        console.error('Database select error:', selectError);
        throw selectError;
      }

      if (!existingArtist) {
        // Insert new artist with expanded error handling
        const { error: insertError } = await this.supabase
          .from('artists')
          .insert({
            spotify_id: artistId,
            name: msg.artistName || artistId,
            metadata: { 
              source: 'spotify',
              discovery_timestamp: new Date().toISOString()
            }
          });

        if (insertError) {
          console.error('Error inserting artist:', insertError, 
            'Artist Data:', { 
              spotify_id: artistId, 
              name: msg.artistName || artistId 
            });
          throw insertError;
        }
        
        console.log(`Created new artist record for: ${msg.artistName || artistId}`);
      }

      // Queue album discovery with offset 0
      await this.enqueue('album_discovery', { 
        artistId,
        offset: 0
      });
      
      console.log(`Enqueued album discovery task for artist ${artistId}`);
    } catch (error) {
      console.error(`Comprehensive error in artist discovery:`, error);
      throw error;  // Re-throw to allow PageWorker to handle
    }
  }
}

const worker = new ArtistDiscoveryWorker();

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Enhanced logging for function entry
    console.log('Artist Discovery worker received request');

    if (req.method === 'POST') {
      try {
        const body = await req.json();
        
        if (body.artistId || body.artistName) {
          await worker.enqueue('artist_discovery', {
            artistId: body.artistId,
            artistName: body.artistName
          });
          
          return new Response(JSON.stringify({ 
            success: true, 
            message: 'Artist discovery task enqueued' 
          }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }
      } catch (e) {
        console.log("No valid JSON body or not adding a manual message", e);
      }
    }
    
    await worker.run();
    
    return new Response(JSON.stringify({ success: true }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  } catch (error) {
    console.error("Comprehensive worker execution error:", error);
    
    return new Response(JSON.stringify({ 
      error: error.message,
      details: error.stack 
    }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
