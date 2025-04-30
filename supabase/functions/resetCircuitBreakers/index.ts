
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { Database } from "../types.ts";
import { logger } from "../lib/logger.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get request body
    const body = await req.json().catch(() => ({}));
    const { circuitName } = body;

    // Validate input
    if (!circuitName) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Circuit name is required" 
        }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supabase = createClient<Database>(supabaseUrl, supabaseKey);
    
    // Reset the circuit breaker in the database
    await supabase
      .from('circuit_breakers')
      .update({
        state: 'closed',
        failure_count: 0,
        success_count: 0,
        last_state_change: new Date().toISOString()
      })
      .eq('name', circuitName);

    // Log the reset event
    await supabase
      .from('circuit_breaker_events')
      .insert({
        circuit_name: circuitName,
        old_state: 'open',
        new_state: 'closed',
        failure_count: 0,
        details: {
          reset_by: 'admin',
          reset_time: new Date().toISOString(),
          reason: 'Manual reset via API'
        }
      });

    logger.info(`Circuit breaker ${circuitName} has been manually reset`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `Circuit breaker ${circuitName} has been reset` 
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  } catch (error) {
    logger.error("Error resetting circuit breaker:", error);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message 
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
