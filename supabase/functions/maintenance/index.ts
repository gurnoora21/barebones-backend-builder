
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from "../types.ts";

// Define CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function performMaintenance(supabase: SupabaseClient<Database>): Promise<{ [key: string]: any }> {
  const results: { [key: string]: any } = {};
  
  try {
    // 1. Clean up expired rate limits
    const { data: rateResults, error: rateError } = await supabase
      .from('rate_limits')
      .delete()
      .lt('window_end', Date.now())
      .select('key');
    
    if (rateError) throw rateError;
    results.rate_limits_cleaned = rateResults?.length || 0;
    
    // 2. Check for stalled messages (messages whose VT has expired but they weren't acked)
    // This isn't needed with PGMQ as it automatically makes messages visible again after VT
    // but we can log metrics about stalled messages for monitoring
    const now = Math.floor(Date.now() / 1000);
    const { data: stalledResults, error: stalledError } = await supabase.rpc('pgmq_get_stalled_messages', {
      max_stalled_minutes: 30 // Consider messages stalled if VT expired >30min ago
    });
    
    if (stalledError) throw stalledError;
    results.stalled_messages = stalledResults?.length || 0;
    
    // 3. Log maintenance run
    const { error: logError } = await supabase
      .from('maintenance_logs')
      .insert({
        results: results
      });
    
    if (logError) throw logError;
    
    return results;
  } catch (error) {
    console.error("Maintenance error:", error);
    results.error = String(error);
    return results;
  }
}

serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log("Running maintenance tasks");
    
    // Initialize Supabase client with service role key
    const supabase = createClient<Database>(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );
    
    const results = await performMaintenance(supabase);
    
    return new Response(JSON.stringify({ 
      success: true,
      results,
      timestamp: new Date().toISOString() 
    }), { 
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
