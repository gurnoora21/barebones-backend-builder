
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { BaseWorker } from "../lib/baseWorker.ts";

// Define the message type for social enrichment
interface SocialEnrichmentMsg {
  producerName: string;
}

// Define CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class SocialEnrichmentWorker extends BaseWorker<SocialEnrichmentMsg> {
  constructor() {
    // Use 30s visibility timeout and batch size of 5
    super('social_enrichment', 30, 5);
  }

  protected async processMessage(msg: SocialEnrichmentMsg, msgId: number): Promise<void> {
    const { producerName } = msg;
    console.log(`Processing social enrichment for producer ${producerName}`);
    
    // TODO: implement actual lookup (e.g., call a people search API or web scrape)
    console.log(`Enriching social profile for ${producerName}`);
    
    // Simulate found data
    const profile = { 
      twitter: `https://twitter.com/${encodeURIComponent(producerName)}`,
      instagram: `https://instagram.com/${encodeURIComponent(producerName.replace(/\s+/g, ''))}`,
      // Add more social profiles as needed
    };
    
    // Store the enriched data in the metrics table with the details
    await this.supabase.from('queue_metrics').insert({
      queue_name: this.queueName,
      msg_id: msgId,
      status: 'success',
      details: profile
    });
    
    console.log(`Completed social enrichment for ${producerName}`);
  }
}

// Initialize the worker
const worker = new SocialEnrichmentWorker();

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
