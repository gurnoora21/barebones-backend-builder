
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";

interface SocialEnrichmentMsg {
  producerName: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class SocialEnrichmentWorker extends PageWorker<SocialEnrichmentMsg> {
  constructor() {
    super('social_enrichment', 30);
  }

  protected async process(msg: SocialEnrichmentMsg): Promise<void> {
    const { producerName } = msg;
    console.log(`Processing social enrichment for producer ${producerName}`);
    
    // Get producer from database
    const { data: producer } = await this.supabase
      .from('producers')
      .select('id, metadata')
      .eq('normalized_name', producerName.toLowerCase().trim())
      .single();

    if (!producer) {
      throw new Error(`Producer ${producerName} not found in database`);
    }

    // TODO: implement actual lookup (e.g., call a people search API or web scrape)
    console.log(`Enriching social profile for ${producerName}`);
    
    const socialProfiles = { 
      twitter: `https://twitter.com/${encodeURIComponent(producerName)}`,
      instagram: `https://instagram.com/${encodeURIComponent(producerName.replace(/\s+/g, ''))}`,
    };

    // Update producer metadata with social profiles
    const { error: updateError } = await this.supabase
      .from('producers')
      .update({
        metadata: {
          ...producer.metadata,
          social_profiles: socialProfiles,
          last_enriched: new Date().toISOString()
        }
      })
      .eq('id', producer.id);

    if (updateError) {
      console.error('Error updating producer metadata:', updateError);
      throw updateError;
    }
    
    console.log(`Completed social enrichment for ${producerName}`);
  }
}

const worker = new SocialEnrichmentWorker();

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
