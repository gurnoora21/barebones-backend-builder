
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { Database } from "../types.ts";

// Define types for validation
interface ValidationResult {
  test: string;
  description: string;
  status: 'passed' | 'failed' | 'warning' | 'info';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  details: any;
  recommendations?: string[];
}

interface ValidationSummary {
  total_tests: number;
  passed: number;
  warnings: number;
  failures: number;
  critical_failures: number;
  timestamp: string;
}

// Configure CORS headers
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
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://nsxxzhhbcwzatvlulfyp.supabase.co";
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") ?? 
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zeHh6aGhiY3d6YXR2bHVsZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ4NDQ4NDYsImV4cCI6MjA2MDQyMDg0Nn0.CR3TFPYipFCs6sL_51rJ3kOKR3iQGr8tJgZJ2GLlrDk";
    
    const supabase = createClient<Database>(supabaseUrl, supabaseKey);
    const results: ValidationResult[] = [];
    
    console.log("Starting data validation run...");
    const startTime = new Date().getTime();

    // Get total counts for summary metrics
    const { data: countData, error: countError } = await supabase
      .rpc('get_pipeline_counts');
    
    if (countError) {
      console.error("Error fetching pipeline counts:", countError);
      throw countError;
    }
    
    const counts = countData?.[0] || {
      artists_count: 0,
      albums_count: 0,
      tracks_count: 0,
      producers_count: 0
    };
    
    console.log("Pipeline counts:", counts);
    
    // Test 1: Artists without albums
    const { data: artistsWithoutAlbums, error: artistError } = await supabase
      .from('artists')
      .select('id, name, spotify_id')
      .not('spotify_id', 'is', null)
      .not('id', 'in', supabase.from('albums').select('artist_id'));
    
    if (artistError) {
      console.error("Error in artists without albums test:", artistError);
      throw artistError;
    }
    
    const artistsWithoutAlbumsCount = artistsWithoutAlbums?.length || 0;
    const artistsWithoutAlbumsPercentage = counts.artists_count > 0 
      ? (artistsWithoutAlbumsCount / counts.artists_count) * 100 
      : 0;
    
    results.push({
      test: 'artists_without_albums',
      description: 'Check artists that have no albums',
      status: artistsWithoutAlbumsCount === 0 ? 'passed' : 
              artistsWithoutAlbumsPercentage > 50 ? 'failed' : 'warning',
      severity: artistsWithoutAlbumsPercentage > 50 ? 'high' : 'medium',
      details: { 
        count: artistsWithoutAlbumsCount,
        percentage: artistsWithoutAlbumsPercentage.toFixed(2),
        total_artists: counts.artists_count,
        examples: artistsWithoutAlbums?.slice(0, 5) || []
      },
      recommendations: [
        'Review artist discovery criteria',
        'Check for rate limiting or API errors in album discovery',
        'Manually trigger album discovery for specific artists'
      ]
    });
    
    // Test 2: Tracks without producers
    const { data: tracksWithoutProducers, error: producerError } = await supabase
      .rpc('get_tracks_without_producers');
    
    if (producerError) {
      console.error("Error in tracks without producers test:", producerError);
      throw producerError;
    }
    
    const tracksWithoutProducersCount = tracksWithoutProducers?.length || 0;
    const tracksWithoutProducersPercentage = counts.tracks_count > 0 
      ? (tracksWithoutProducersCount / counts.tracks_count) * 100 
      : 0;
    
    results.push({
      test: 'tracks_without_producers',
      description: 'Tracks missing producer attribution',
      status: tracksWithoutProducersPercentage < 10 ? 'passed' : 
              tracksWithoutProducersPercentage > 50 ? 'failed' : 'warning',
      severity: tracksWithoutProducersPercentage > 50 ? 'high' : 'medium',
      details: {
        count: tracksWithoutProducersCount,
        percentage: tracksWithoutProducersPercentage.toFixed(2),
        total_tracks: counts.tracks_count,
        examples: tracksWithoutProducers?.slice(0, 5) || []
      },
      recommendations: [
        'Investigate producer identification worker issues',
        'Check if Genius API is returning producer data as expected',
        'Consider alternative sources for producer data'
      ]
    });
    
    // Test 3: Orphaned tracks (tracks without valid albums)
    const { data: orphanedTracks, error: orphanedTracksError } = await supabase
      .rpc('get_orphaned_tracks');
    
    if (orphanedTracksError) {
      console.error("Error in orphaned tracks test:", orphanedTracksError);
      throw orphanedTracksError;
    }
    
    const orphanedTracksCount = orphanedTracks?.length || 0;
    
    results.push({
      test: 'orphaned_tracks',
      description: 'Tracks without valid album references',
      status: orphanedTracksCount === 0 ? 'passed' : 'failed',
      severity: 'critical',
      details: {
        count: orphanedTracksCount,
        examples: orphanedTracks?.slice(0, 5) || []
      },
      recommendations: [
        'Fix database integrity by removing orphaned tracks',
        'Ensure album IDs are valid before inserting tracks',
        'Check for race conditions in track creation'
      ]
    });
    
    // Test 4: Orphaned albums (albums without valid artists)
    const { data: orphanedAlbums, error: orphanedAlbumsError } = await supabase
      .rpc('get_orphaned_albums');
    
    if (orphanedAlbumsError) {
      console.error("Error in orphaned albums test:", orphanedAlbumsError);
      throw orphanedAlbumsError;
    }
    
    const orphanedAlbumsCount = orphanedAlbums?.length || 0;
    
    results.push({
      test: 'orphaned_albums',
      description: 'Albums without valid artist references',
      status: orphanedAlbumsCount === 0 ? 'passed' : 'failed',
      severity: 'critical',
      details: {
        count: orphanedAlbumsCount,
        examples: orphanedAlbums?.slice(0, 5) || []
      },
      recommendations: [
        'Fix database integrity by removing orphaned albums',
        'Ensure artist IDs are valid before inserting albums',
        'Check for race conditions in album creation'
      ]
    });
    
    // Test 5: Duplicate tracks
    const { data: duplicateTracks, error: duplicateTracksError } = await supabase
      .rpc('get_duplicate_tracks');
    
    if (duplicateTracksError) {
      console.error("Error in duplicate tracks test:", duplicateTracksError);
      throw duplicateTracksError;
    }
    
    const duplicateTracksCount = duplicateTracks?.length || 0;
    
    results.push({
      test: 'duplicate_tracks',
      description: 'Duplicate tracks in the same album',
      status: duplicateTracksCount === 0 ? 'passed' : 'warning',
      severity: 'medium',
      details: {
        count: duplicateTracksCount,
        examples: duplicateTracks?.slice(0, 5) || []
      },
      recommendations: [
        'Deduplicate tracks with the same name in albums',
        'Improve track name normalization',
        'Consider additional metadata to distinguish tracks'
      ]
    });
    
    // Test 6: Producer attribution completeness
    const { data: producerAttribution, error: producerAttributionError } = await supabase
      .rpc('get_producer_attribution_by_artist');
    
    if (producerAttributionError) {
      console.error("Error in producer attribution test:", producerAttributionError);
      throw producerAttributionError;
    }
    
    // Calculate average producer attribution across all artists
    const totalArtists = producerAttribution?.length || 0;
    const sumPercentage = producerAttribution?.reduce((sum, item) => sum + Number(item.percentage), 0) || 0;
    const avgProducerAttribution = totalArtists > 0 ? sumPercentage / totalArtists : 0;
    
    // Find artists with low producer attribution
    const lowAttributionArtists = producerAttribution
      ?.filter(item => Number(item.percentage) < 30 && Number(item.total_tracks) > 5)
      .sort((a, b) => Number(b.total_tracks) - Number(a.total_tracks))
      .slice(0, 5) || [];
    
    results.push({
      test: 'producer_attribution_completeness',
      description: 'Producer attribution completeness by artist',
      status: avgProducerAttribution > 70 ? 'passed' : 
              avgProducerAttribution < 30 ? 'failed' : 'warning',
      severity: avgProducerAttribution < 30 ? 'high' : 'medium',
      details: {
        average_attribution_percentage: avgProducerAttribution.toFixed(2),
        total_artists_analyzed: totalArtists,
        low_attribution_examples: lowAttributionArtists
      },
      recommendations: [
        'Focus on improving producer identification for artists with low attribution',
        'Check if certain genres have systematically lower attribution',
        'Consider alternative data sources for producer information'
      ]
    });
    
    // Test 7: Producer social enrichment completeness
    const { data: producerEnrichmentStats, error: enrichmentError } = await supabase
      .from('producers')
      .select('enriched_at, enrichment_failed')
      .not('id', 'is', null);
    
    if (enrichmentError) {
      console.error("Error in producer enrichment test:", enrichmentError);
      throw enrichmentError;
    }
    
    const totalProducers = producerEnrichmentStats?.length || 0;
    const enrichedCount = producerEnrichmentStats?.filter(p => p.enriched_at !== null).length || 0;
    const failedCount = producerEnrichmentStats?.filter(p => p.enrichment_failed === true).length || 0;
    const pendingCount = totalProducers - enrichedCount - failedCount;
    const enrichedPercentage = totalProducers > 0 ? (enrichedCount / totalProducers) * 100 : 0;
    
    results.push({
      test: 'producer_social_enrichment',
      description: 'Producer social data enrichment completeness',
      status: enrichedPercentage > 60 ? 'passed' : 
              enrichedPercentage < 20 ? 'failed' : 'warning',
      severity: enrichedPercentage < 20 ? 'medium' : 'low',
      details: {
        total_producers: totalProducers,
        enriched_count: enrichedCount,
        failed_count: failedCount,
        pending_count: pendingCount,
        enriched_percentage: enrichedPercentage.toFixed(2)
      },
      recommendations: [
        'Investigate high failure rate in social enrichment',
        'Consider alternate social platforms for producer data',
        'Check API rate limits for social enrichment services'
      ]
    });
    
    // Test 8: Queue health and performance
    const { data: queueMetrics, error: queueError } = await supabase
      .rpc('get_queue_metrics');
    
    if (queueError) {
      console.error("Error in queue metrics test:", queueError);
      throw queueError;
    }
    
    const longRunningQueues = queueMetrics
      ?.filter(q => q.pending_messages > 100 || (q.oldest_message_age && q.oldest_message_age > '24 hours'))
      .map(q => ({
        queue_name: q.queue_name,
        pending_messages: q.pending_messages,
        oldest_message_age: q.oldest_message_age,
        max_retries: q.max_retries
      })) || [];
    
    const isQueueHealthy = longRunningQueues.length === 0;
    
    results.push({
      test: 'queue_health',
      description: 'Pipeline queue health and performance',
      status: isQueueHealthy ? 'passed' : 'warning',
      severity: isQueueHealthy ? 'info' : 'high',
      details: {
        queue_metrics: queueMetrics,
        problematic_queues: longRunningQueues
      },
      recommendations: longRunningQueues.length > 0 ? [
        'Check workers processing problematic queues',
        'Consider scaling up worker frequency',
        'Investigate potential bottlenecks in processing logic'
      ] : []
    });
    
    // Calculate overall summary
    const summary: ValidationSummary = {
      total_tests: results.length,
      passed: results.filter(r => r.status === 'passed').length,
      warnings: results.filter(r => r.status === 'warning').length,
      failures: results.filter(r => r.status === 'failed').length,
      critical_failures: results.filter(r => r.status === 'failed' && r.severity === 'critical').length,
      timestamp: new Date().toISOString()
    };
    
    // Store validation report in database
    const { data: reportData, error: reportError } = await supabase
      .from('validation_reports')
      .insert({
        results: results,
        summary: summary
      })
      .select('id')
      .single();
    
    if (reportError) {
      console.error("Error storing validation report:", reportError);
      throw reportError;
    }
    
    const elapsedTimeMs = new Date().getTime() - startTime;
    console.log(`Data validation completed in ${elapsedTimeMs}ms. Report ID: ${reportData?.id}`);
    
    // Return validation results
    return new Response(JSON.stringify({
      report_id: reportData?.id,
      summary,
      results,
      elapsed_ms: elapsedTimeMs
    }), { 
      status: 200,
      headers: { 
        ...corsHeaders,
        'Content-Type': 'application/json' 
      } 
    });
  } catch (error) {
    console.error("Error performing data validation:", error);
    
    return new Response(JSON.stringify({ 
      error: error.message || "Unknown error during data validation" 
    }), { 
      status: 500,
      headers: { 
        ...corsHeaders,
        'Content-Type': 'application/json' 
      } 
    });
  }
});
