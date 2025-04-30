
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { CircuitBreakerRegistry } from "../lib/circuitBreaker.ts";
import { logger } from "../lib/logger.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  try {
    // Get request body
    let params = {};
    try {
      params = await req.json();
    } catch (error) {
      params = {};
    }

    const { circuitName } = params;
    
    // Create Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Set up circuit breaker registry with supabase client
    CircuitBreakerRegistry.setSupabaseClient(supabase);
    
    // Load existing circuit breakers from storage
    await CircuitBreakerRegistry.loadFromStorage();
    
    // Initialize logger
    const resetLogger = logger.child({ 
      operation: 'resetCircuitBreakers',
      circuitName
    });
    
    let result;
    
    if (circuitName) {
      // Reset specific circuit
      await CircuitBreakerRegistry.reset(circuitName);
      result = { 
        success: true, 
        message: `Circuit ${circuitName} reset successfully`
      };
      resetLogger.info(`Circuit ${circuitName} manually reset`);
    } else {
      // Get all circuit statuses
      const statuses = await CircuitBreakerRegistry.getAllStatuses();
      
      // Reset spotify related circuits if they've been open for more than 4 hours
      const now = Date.now();
      const MAX_OPEN_DURATION = 4 * 60 * 60 * 1000; // 4 hours
      
      const resetCircuits = [];
      
      for (const status of statuses) {
        if (
          status.name.startsWith('spotify') && 
          status.state === 'open' &&
          (now - status.lastStateChange) > MAX_OPEN_DURATION
        ) {
          await CircuitBreakerRegistry.reset(status.name);
          resetCircuits.push(status.name);
          resetLogger.info(`Auto-reset long-open circuit: ${status.name}`);
        }
      }
      
      // Get updated statuses after resets
      const updatedStatuses = await CircuitBreakerRegistry.getAllStatuses();
      
      result = {
        success: true,
        resetCircuits,
        statuses: updatedStatuses
      };
    }
    
    // Also update the database to record this operation
    await supabase
      .from('worker_issues')
      .insert({
        worker_name: 'circuit_breaker_monitor',
        issue_type: 'circuit_breaker_reset',
        details: {
          ...result,
          triggered_by: 'manual_reset',
          timestamp: new Date().toISOString()
        }
      });
    
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    const errorResponse = {
      error: error.message,
      details: error.stack
    };
    
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
