
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from "../types.ts";
import { CircuitBreakerRegistry } from "../lib/circuitBreaker.ts";

// Define CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Define interfaces for maintenance tasks
interface MaintenanceTask {
  name: string;
  description: string;
  run: (supabase: SupabaseClient<Database>) => Promise<any>;
}

// Define queue monitoring thresholds
const QUEUE_DEPTH_WARNING_THRESHOLD = 100; // Warn if more than 100 messages in queue
const STALLED_MESSAGES_WARNING_THRESHOLD = 10; // Warn if more than 10 stalled messages
const DLQ_THRESHOLD = 5; // Warn if DLQ has grown by 5+ messages since last check

async function performMaintenance(supabase: SupabaseClient<Database>): Promise<{ [key: string]: any }> {
  const results: { [key: string]: any } = {};
  const warnings: string[] = [];
  
  // Initialize circuit breaker registry with supabase client
  CircuitBreakerRegistry.setSupabaseClient(supabase);
  await CircuitBreakerRegistry.loadFromStorage();
  
  // Define maintenance tasks
  const tasks: MaintenanceTask[] = [
    {
      name: 'clean_rate_limits',
      description: 'Clean up expired rate limits',
      run: async (client) => {
        const { data, error } = await client
          .from('rate_limits')
          .delete()
          .lt('window_end', Date.now())
          .select('key');
        
        if (error) throw error;
        return { cleaned: data?.length || 0 };
      }
    },
    {
      name: 'monitor_queue_depth',
      description: 'Check all queues for excessive depth',
      run: async (client) => {
        // Get queue names
        const { data: queues, error: queueError } = await client.rpc('pgmq_list_queues');
        if (queueError) throw queueError;
        
        const queueStats: Record<string, any> = {};
        let totalMessages = 0;
        
        // For each queue, get stats
        for (const queue of queues || []) {
          const { data: queueInfo, error: infoError } = await client.rpc('pgmq_info', {
            queue_name: queue.name
          });
          
          if (infoError) {
            console.error(`Error getting info for queue ${queue.name}:`, infoError);
            continue;
          }
          
          if (queueInfo) {
            queueStats[queue.name] = queueInfo;
            totalMessages += queueInfo.approx_message_count || 0;
            
            // Log queue stats to database
            await client.from('queue_depth_metrics').insert({
              queue_name: queue.name,
              message_count: queueInfo.approx_message_count || 0,
              visible_count: queueInfo.approx_visible_messages || 0,
              details: queueInfo
            });
            
            // Check if queue depth exceeds threshold
            if ((queueInfo.approx_message_count || 0) > QUEUE_DEPTH_WARNING_THRESHOLD) {
              warnings.push(`Queue ${queue.name} has ${queueInfo.approx_message_count} messages, exceeding threshold of ${QUEUE_DEPTH_WARNING_THRESHOLD}`);
            }
          }
        }
        
        return { 
          queues: queueStats,
          total_messages: totalMessages
        };
      }
    },
    {
      name: 'check_stalled_messages',
      description: 'Check for stalled messages (messages whose VT has expired)',
      run: async (client) => {
        const { data: stalled, error: stalledError } = await client.rpc('pgmq_get_stalled_messages', {
          max_stalled_minutes: 30
        });
        
        if (stalledError) throw stalledError;
        
        // Group stalled messages by queue
        const stalledByQueue: Record<string, any[]> = {};
        for (const msg of stalled || []) {
          if (!stalledByQueue[msg.queue_name]) {
            stalledByQueue[msg.queue_name] = [];
          }
          stalledByQueue[msg.queue_name].push(msg);
        }
        
        // Check if any queue has too many stalled messages
        for (const [queue, messages] of Object.entries(stalledByQueue)) {
          if (messages.length > STALLED_MESSAGES_WARNING_THRESHOLD) {
            warnings.push(`Queue ${queue} has ${messages.length} stalled messages, exceeding threshold of ${STALLED_MESSAGES_WARNING_THRESHOLD}`);
          }
        }
        
        return {
          stalled_count: stalled?.length || 0,
          stalled_by_queue: stalledByQueue
        };
      }
    },
    {
      name: 'monitor_dead_letter_queue',
      description: 'Check for new dead letter messages and analyze issues',
      run: async (client) => {
        const { data: lastRun, error: lastRunError } = await client
          .from('maintenance_logs')
          .select('results')
          .order('timestamp', { ascending: false })
          .limit(1)
          .single();
          
        let previousDlqCount = 0;
        if (lastRun && !lastRunError) {
          previousDlqCount = lastRun.results?.dlq_stats?.total_count || 0;
        }
        
        // Get current DLQ counts
        const { data: dlqStats, error: dlqError } = await client
          .from('pgmq_dead_letter_items')
          .select('queue_name, count(*)')
          .group('queue_name');
          
        if (dlqError) throw dlqError;
        
        const dlqByQueue: Record<string, number> = {};
        let totalCount = 0;
        
        for (const stat of dlqStats || []) {
          dlqByQueue[stat.queue_name] = parseInt(stat.count);
          totalCount += parseInt(stat.count);
        }
        
        // Check if DLQ has grown significantly
        if (totalCount - previousDlqCount >= DLQ_THRESHOLD) {
          warnings.push(`Dead letter queue has grown by ${totalCount - previousDlqCount} messages since last check`);
        }
        
        // Get analysis of error categories
        const { data: errorAnalysis, error: analysisError } = await client
          .from('dead_letter_analysis')
          .select('*')
          .order('error_count', { ascending: false });
          
        if (analysisError) console.error('Error getting DLQ analysis:', analysisError);
        
        return {
          total_count: totalCount,
          previous_count: previousDlqCount,
          growth: totalCount - previousDlqCount,
          by_queue: dlqByQueue,
          error_analysis: errorAnalysis || []
        };
      }
    },
    {
      name: 'check_circuit_breakers',
      description: 'Check circuit breaker status and log alerts',
      run: async (client) => {
        // Get statuses from in-memory registry
        const cbStatuses = await CircuitBreakerRegistry.getAllStatuses();
        
        // Log open circuits
        const openCircuits = cbStatuses.filter(cb => cb.state === 'open');
        if (openCircuits.length > 0) {
          for (const circuit of openCircuits) {
            warnings.push(`Circuit breaker ${circuit.name} is in OPEN state since ${circuit.lastStateChange}`);
          }
        }
        
        return {
          total: cbStatuses.length,
          open: openCircuits.length,
          half_open: cbStatuses.filter(cb => cb.state === 'half-open').length,
          closed: cbStatuses.filter(cb => cb.state === 'closed').length,
          statuses: cbStatuses
        };
      }
    },
    {
      name: 'analyze_processing_rates',
      description: 'Analyze processing rates and times by queue',
      run: async (client) => {
        const { data: stats, error: statsError } = await client
          .from('queue_stats')
          .select('*')
          .order('hour', { ascending: false })
          .limit(48); // Last 48 hours
          
        if (statsError) throw statsError;
        
        const queueAnalysis: Record<string, any> = {};
        let totalProcessed = 0;
        let totalErrors = 0;
        
        // Group by queue
        for (const stat of stats || []) {
          if (!queueAnalysis[stat.queue_name]) {
            queueAnalysis[stat.queue_name] = {
              processed: 0,
              errors: 0,
              avg_processing_ms: 0,
              max_processing_ms: 0,
              hourly: []
            };
          }
          
          queueAnalysis[stat.queue_name].processed += stat.messages_processed;
          queueAnalysis[stat.queue_name].errors += stat.error_count;
          queueAnalysis[stat.queue_name].hourly.push({
            hour: stat.hour,
            processed: stat.messages_processed,
            errors: stat.error_count,
            avg_ms: stat.avg_processing_ms
          });
          
          totalProcessed += stat.messages_processed;
          totalErrors += stat.error_count;
        }
        
        return {
          total_processed: totalProcessed,
          total_errors: totalErrors,
          error_rate: totalProcessed > 0 ? totalErrors / totalProcessed : 0,
          by_queue: queueAnalysis
        };
      }
    },
    {
      name: 'check_trace_health',
      description: 'Check trace health and log statistics',
      run: async (client) => {
        const { data: traceSummary, error: traceError } = await client
          .from('trace_summary')
          .select('*')
          .order('start_time', { ascending: false })
          .limit(100);
          
        if (traceError) throw traceError;
        
        // Analyze trace data
        const services = new Set<string>();
        const operations = new Set<string>();
        let totalSpans = 0;
        let avgDuration = 0;
        
        for (const trace of traceSummary || []) {
          totalSpans += trace.span_count || 0;
          
          if (trace.services) {
            trace.services.forEach((svc: string) => services.add(svc));
          }
          
          if (trace.operations) {
            trace.operations.forEach((op: string) => operations.add(op));
          }
        }
        
        return {
          trace_count: traceSummary?.length || 0,
          total_spans: totalSpans,
          unique_services: Array.from(services),
          unique_operations: Array.from(operations)
        };
      }
    }
  ];
  
  // Run all maintenance tasks
  try {
    for (const task of tasks) {
      console.log(`Running maintenance task: ${task.name}`);
      try {
        results[task.name] = await task.run(supabase);
        console.log(`Completed task ${task.name}`);
      } catch (error) {
        console.error(`Error in maintenance task ${task.name}:`, error);
        results[task.name] = { error: String(error) };
      }
    }
    
    // Log maintenance run
    const { error: logError } = await supabase
      .from('maintenance_logs')
      .insert({
        results,
        warnings: warnings.length > 0 ? warnings : null
      });
    
    if (logError) throw logError;
    
    // If there are warnings, log them to a dedicated warnings table 
    if (warnings.length > 0) {
      const { error: warningsError } = await supabase
        .from('maintenance_warnings')
        .insert({
          warnings,
          details: results
        });
        
      if (warningsError) {
        console.error('Error logging warnings:', warningsError);
      }
    }
    
    return { 
      results,
      warnings,
      timestamp: new Date().toISOString()
    };
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
      timestamp: new Date().toISOString(),
      warnings: results.warnings || []
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
