
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { Database } from "../types.ts";

/**
 * Helper function to requeue problematic items for reprocessing
 */
export async function requeueItems(
  supabase: ReturnType<typeof createClient<Database>>,
  testName: string,
  items: any[]
): Promise<{ queued: number; errors: any[] }> {
  const results = {
    queued: 0,
    errors: [] as any[]
  };

  try {
    switch (testName) {
      case 'artists_without_albums':
        for (const item of items) {
          try {
            await supabase.rpc('pgmq_send', {
              queue_name: 'album_discovery',
              msg: { artistId: item.spotify_id }
            });
            results.queued++;
          } catch (error) {
            results.errors.push({ item, error: error.message });
          }
        }
        break;
        
      case 'tracks_without_producers':
        for (const item of items) {
          try {
            // Get track details first
            const { data: track } = await supabase
              .from('tracks')
              .select('spotify_id, name, album_id')
              .eq('id', item.track_id)
              .single();
              
            if (track) {
              // Get album to get artist_id
              const { data: album } = await supabase
                .from('albums')
                .select('spotify_id, artist_id')
                .eq('id', track.album_id)
                .single();
                
              if (album) {
                await supabase.rpc('pgmq_send', {
                  queue_name: 'producer_identification',
                  msg: { 
                    trackId: track.spotify_id,
                    trackName: track.name,
                    albumId: album.spotify_id,
                    artistId: album.artist_id
                  }
                });
                results.queued++;
              }
            }
          } catch (error) {
            results.errors.push({ item, error: error.message });
          }
        }
        break;
        
      default:
        throw new Error(`No requeue logic defined for test: ${testName}`);
    }
    
    return results;
  } catch (error) {
    console.error(`Error requeuing items for ${testName}:`, error);
    throw error;
  }
}

/**
 * Generate recommendations based on validation results
 */
export function generateRecommendations(results: any[]): string[] {
  const recommendations: string[] = [];
  
  // Count issues by type
  const issues = {
    dataIntegrity: 0,
    producerAttribution: 0,
    queuePerformance: 0
  };
  
  // Check for specific issues
  const hasOrphanedRecords = results.some(r => 
    (r.test.includes('orphaned') && r.status !== 'passed'));
  
  const hasProducerAttributionIssues = results.some(r => 
    (r.test.includes('producer') && r.status !== 'passed'));
    
  const hasQueueIssues = results.some(r => 
    (r.test === 'queue_health' && r.status !== 'passed'));
    
  // Generate recommendations based on issues
  if (hasOrphanedRecords) {
    recommendations.push(
      'Run the maintenance worker to clean up orphaned records',
      'Implement stronger foreign key constraints in the database'
    );
  }
  
  if (hasProducerAttributionIssues) {
    recommendations.push(
      'Improve producer identification algorithms',
      'Consider additional data sources for producer information',
      'Manually fill in producer data for high-priority artists'
    );
  }
  
  if (hasQueueIssues) {
    recommendations.push(
      'Increase worker frequency for backed-up queues',
      'Review worker logs for potential performance issues',
      'Consider optimization of database queries in workers'
    );
  }
  
  return recommendations;
}
