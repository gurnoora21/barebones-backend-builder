
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

    // Extract roles from metadata for specialized social profile searches
    const roles = producer.metadata?.roles || ['producer'];
    const isPrimaryProducer = roles.includes('producer');
    const isWriter = roles.includes('writer');
    
    console.log(`Enriching social profile for ${producerName} (roles: ${roles.join(', ')})`);
    
    // Build social profile search strategy based on role
    const socialProfiles: Record<string, string> = {};
    
    // Basic social profiles for all
    socialProfiles.twitter = `https://twitter.com/${encodeURIComponent(producerName)}`;
    socialProfiles.instagram = `https://instagram.com/${encodeURIComponent(producerName.replace(/\s+/g, ''))}`;
    
    // Add specialized profiles based on role
    if (isPrimaryProducer) {
      socialProfiles.soundcloud = `https://soundcloud.com/${encodeURIComponent(producerName.replace(/\s+/g, '-').toLowerCase())}`;
      socialProfiles.beatstars = `https://beatstars.com/${encodeURIComponent(producerName.replace(/\s+/g, '').toLowerCase())}`;
    }
    
    if (isWriter) {
      socialProfiles.genius = `https://genius.com/artists/${encodeURIComponent(producerName.replace(/\s+/g, '-'))}`;
      socialProfiles.ascap = `https://www.ascap.com/repertory#ace/search/writer/${encodeURIComponent(producerName)}`;
    }

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
