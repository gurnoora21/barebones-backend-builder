
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getTrackDetails } from "../lib/spotifyClient.ts";

interface ProducerIdentificationMsg {
  trackId: string;
  trackName: string;
  albumId: string;
  artistId: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class ProducerIdentificationWorker extends PageWorker<ProducerIdentificationMsg> {
  constructor() {
    super('producer_identification', 60);
  }

  protected async process(msg: ProducerIdentificationMsg): Promise<void> {
    const { trackId, trackName } = msg;
    console.log(`Processing producer identification for track ${trackName} (${trackId})`);
    
    const track = await getTrackDetails(trackId);
    console.log(`Found ${track.artists.length} artists/collaborators for track ${trackName}`);

    // Get track UUID from our database
    const { data: dbTrack } = await this.supabase
      .from('tracks')
      .select('id')
      .eq('spotify_id', trackId)
      .single();

    if (!dbTrack) {
      throw new Error(`Track ${trackId} not found in database`);
    }
    
    for (const artist of track.artists) {
      if (artist.id !== msg.artistId) {  // Skip the main artist
        // Create or get producer
        const normalizedName = artist.name.toLowerCase().trim();
        
        const { data: existingProducer } = await this.supabase
          .from('producers')
          .select('id')
          .eq('normalized_name', normalizedName)
          .single();

        let producerId;
        if (existingProducer) {
          producerId = existingProducer.id;
        } else {
          const { data: newProducer, error: insertError } = await this.supabase
            .from('producers')
            .insert({
              name: artist.name,
              normalized_name: normalizedName,
              metadata: { source: 'spotify' }
            })
            .select('id')
            .single();

          if (insertError) {
            console.error('Error inserting producer:', insertError);
            throw insertError;
          }
          producerId = newProducer.id;
        }

        // Create track_producer relationship
        const { error: relationError } = await this.supabase
          .from('track_producers')
          .insert({
            track_id: dbTrack.id,
            producer_id: producerId,
            confidence: 0.8, // High confidence for Spotify data
            source: 'spotify'
          });

        if (relationError) {
          console.error('Error creating track_producer relationship:', relationError);
          throw relationError;
        }

        await this.enqueue('social_enrichment', { 
          producerName: artist.name 
        });
        
        console.log(`Enqueued social enrichment for producer: ${artist.name}`);
      }
    }
    
    console.log(`Finished processing collaborators for track ${trackName}`);
  }
}

const worker = new ProducerIdentificationWorker();

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
