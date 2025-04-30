
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getSpotifyArtistId, spotifyApi } from "../lib/spotifyClient.ts";

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
    // Increase visibility timeout from 60 to 120 seconds
    super('artist_discovery', 120);
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

    try {
      // Fetch additional artist details from Spotify with shorter timeout
      const artistDetails = await spotifyApi<any>(`artists/${artistId}`, { timeout: 25000 });
      
      // Extract image URL from artist details
      const imageUrl = artistDetails.images?.[0]?.url || null;
      
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

      // Extract followers count properly, ensuring it's a number
      let followersCount = null;
      if (artistDetails.followers) {
        if (typeof artistDetails.followers === 'number') {
          followersCount = artistDetails.followers;
        } else if (typeof artistDetails.followers === 'object' && artistDetails.followers !== null) {
          followersCount = artistDetails.followers.total || null;
        }
      }

      // Prepare artist update data
      const artistUpdateData = {
        spotify_id: artistId,
        name: msg.artistName || artistDetails.name,
        followers: followersCount, // Use the extracted followers count
        popularity: artistDetails.popularity,
        image_url: imageUrl, // Store the image URL
        metadata: { 
          ...existingArtist?.metadata,
          source: 'spotify',
          images: artistDetails.images, // Store all images in metadata
          discovery_timestamp: new Date().toISOString()
        }
      };

      let insertOrUpdateResult;
      if (!existingArtist) {
        // Insert new artist
        insertOrUpdateResult = await this.supabase
          .from('artists')
          .insert(artistUpdateData)
          .select('id')
          .single();
      } else {
        // Update existing artist
        insertOrUpdateResult = await this.supabase
          .from('artists')
          .update(artistUpdateData)
          .eq('spotify_id', artistId)
          .select('id')
          .single();
      }

      if (insertOrUpdateResult.error) {
        console.error('Error inserting/updating artist:', insertOrUpdateResult.error);
        throw insertOrUpdateResult.error;
      }
      
      console.log(`Created/Updated artist record: ${msg.artistName || artistDetails.name}`);

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
