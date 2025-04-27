
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';
import { getSpotifyArtistId, spotifyApi } from "../lib/spotifyClient.ts";
import { CircuitBreakerRegistry } from "../lib/circuitBreaker.ts";
import { globalCache } from "../lib/cache.ts";

interface SeederConfig {
  markets: string[];          // e.g., ['US', 'GB', 'FR']
  genres: string[];          // e.g., ['hip hop', 'r&b', 'pop']
  minPopularity: number;     // e.g., 20
  maxArtists: number;        // e.g., 50
  yearRange?: {
    start: number;
    end: number;
  };
  excludeArtists?: string[];
}

interface JobProgress {
  processed_markets: string[];
  processed_genres: string[];
  artist_count: number;
  last_processed?: string;
  errors?: {
    count: number;
    last_error?: string;
  };
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Initialize a Supabase client
function initSupabaseClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Missing Supabase environment variables');
  }
  
  return createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false }
  });
}

/**
 * Initialize a new seeding job and return its ID
 */
async function initializeJob(supabase: any, config: SeederConfig): Promise<string> {
  try {
    const { data, error } = await supabase
      .from('seeding_jobs')
      .insert({
        job_type: 'artist_seeding',
        config,
        status: 'running',
        progress: {
          processed_markets: [],
          processed_genres: [],
          artist_count: 0,
          started_at: new Date().toISOString(),
          errors: {
            count: 0
          }
        }
      })
      .select()
      .single();

    if (error) {
      console.error('Error initializing seeding job:', error);
      throw error;
    }
    
    console.log(`Initialized seeding job ${data.id} with config:`, config);
    return data.id;
  } catch (err) {
    console.error(`Failed to initialize seeding job: ${err}`);
    throw err;
  }
}

/**
 * Search for artists matching the given criteria
 */
async function searchArtists(market: string, genre: string, config: SeederConfig): Promise<any[]> {
  // Create circuit breaker for Spotify API calls
  const circuit = CircuitBreakerRegistry.getOrCreate({
    name: `spotify-search-${market}-${genre}`,
    failureThreshold: 3,
    resetTimeoutMs: 60000 // 1 minute
  });
  
  return await circuit.fire(async () => {
    const searchQuery = `genre:${genre}`;
    
    // Use cache to avoid repeated identical searches
    const cacheKey = `artist-search:${market}:${genre}:${config.minPopularity}`;
    
    return await globalCache.getOrFetch(cacheKey, async () => {
      console.log(`Searching for artists in market ${market} with genre ${genre}`);
      
      try {
        const data = await spotifyApi(`search?q=${encodeURIComponent(searchQuery)}&type=artist&market=${market}&limit=50`);
        
        if (!data.artists || !data.artists.items) {
          console.log(`No artists found for market ${market} and genre ${genre}`);
          return [];
        }
        
        // Filter artists according to criteria
        const filteredArtists = data.artists.items.filter((artist: any) => {
          // Filter by popularity
          if (artist.popularity < config.minPopularity) return false;

          // Filter by excluded artists
          if (config.excludeArtists?.includes(artist.id)) return false;

          // Ensure artist has at least one matching genre
          return artist.genres.some((g: string) => 
            config.genres.some(configGenre => 
              g.toLowerCase().includes(configGenre.toLowerCase())
            )
          );
        });
        
        console.log(`Found ${filteredArtists.length} matching artists for ${market}/${genre}`);
        return filteredArtists;
      } catch (error) {
        console.error(`Error searching artists: ${error}`);
        throw error;
      }
    }, 3600000); // Cache for 1 hour
  });
}

/**
 * Process a specific market-genre combination
 */
async function processMarketGenreCombination(
  supabase: any,
  jobId: string,
  market: string,
  genre: string,
  config: SeederConfig,
  jobProgress: JobProgress
): Promise<number> {
  let processedCount = 0;
  
  try {
    console.log(`Processing market: ${market}, genre: ${genre}`);
    const artists = await searchArtists(market, genre, config);
    
    for (const artist of artists) {
      try {
        if (jobProgress.artist_count >= config.maxArtists) {
          console.log(`Reached maximum artists count (${config.maxArtists})`);
          return processedCount;
        }
        
        // Check if we've already processed this artist
        const { data: existing } = await supabase
          .from('seeding_artists')
          .select('spotify_id')
          .eq('spotify_id', artist.id)
          .eq('job_id', jobId)
          .single();

        if (existing) {
          console.log(`Skipping already processed artist: ${artist.name} (${artist.id})`);
          continue;
        }

        // Throttle requests to avoid overwhelming the database
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Insert into artists table
        await supabase.from('artists').upsert({
          name: artist.name,
          spotify_id: artist.id,
          popularity: artist.popularity,
          market,
          genres: artist.genres,
          metadata: {
            followers: artist.followers?.total,
            images: artist.images,
            external_urls: artist.external_urls
          }
        });

        // Record the successful processing
        await supabase.from('seeding_artists').insert({
          job_id: jobId,
          spotify_id: artist.id,
          success: true,
          details: { market, genre }
        });

        // Queue artist for album discovery with exponential backoff
        const retryCount = 3;
        for (let attempt = 0; attempt < retryCount; attempt++) {
          try {
            await supabase.functions.invoke('artistDiscovery', {
              body: { artistId: artist.id }
            });
            break;
          } catch (invokeError) {
            console.error(`Error invoking artistDiscovery (attempt ${attempt + 1}/${retryCount}):`, invokeError);
            if (attempt === retryCount - 1) throw invokeError;
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
          }
        }
        
        processedCount++;
        jobProgress.artist_count++;
        
        console.log(`Processed artist: ${artist.name} (${artist.id}), total count: ${jobProgress.artist_count}`);
        
        // Update job progress every 5 artists
        if (processedCount % 5 === 0) {
          await updateJobProgress(supabase, jobId, jobProgress);
        }

      } catch (error) {
        console.error(`Error processing artist ${artist.id}:`, error);
        
        // Track error in job progress
        jobProgress.errors = jobProgress.errors || { count: 0 };
        jobProgress.errors.count = (jobProgress.errors.count || 0) + 1;
        jobProgress.errors.last_error = String(error);
        
        await supabase.from('seeding_artists').insert({
          job_id: jobId,
          spotify_id: artist.id,
          success: false,
          details: { error: String(error), market, genre }
        });
      }
    }
    
    return processedCount;
  } catch (error) {
    console.error(`Error processing market-genre combination ${market}/${genre}:`, error);
    jobProgress.errors = jobProgress.errors || { count: 0 };
    jobProgress.errors.count = (jobProgress.errors.count || 0) + 1;
    jobProgress.errors.last_error = String(error);
    
    await updateJobProgress(supabase, jobId, jobProgress);
    return processedCount;
  }
}

/**
 * Update the job progress in the database
 */
async function updateJobProgress(supabase: any, jobId: string, progress: JobProgress): Promise<void> {
  try {
    progress.last_processed = new Date().toISOString();
    
    const { error } = await supabase
      .from('seeding_jobs')
      .update({
        progress
      })
      .eq('id', jobId);
      
    if (error) {
      console.error(`Error updating job progress for ${jobId}:`, error);
    }
  } catch (err) {
    console.error(`Failed to update job progress: ${err}`);
  }
}

/**
 * Mark a job as completed
 */
async function completeJob(supabase: any, jobId: string, jobProgress: JobProgress): Promise<void> {
  try {
    jobProgress.last_processed = new Date().toISOString();
    
    const { error } = await supabase
      .from('seeding_jobs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        progress: jobProgress,
        results: {
          total_artists_processed: jobProgress.artist_count,
          errors: jobProgress.errors?.count || 0,
          duration_ms: Date.now() - new Date(jobProgress.last_processed).getTime()
        }
      })
      .eq('id', jobId);
      
    if (error) {
      console.error(`Error completing job ${jobId}:`, error);
    } else {
      console.log(`Job ${jobId} completed successfully with ${jobProgress.artist_count} artists processed`);
    }
  } catch (err) {
    console.error(`Failed to mark job as completed: ${err}`);
  }
}

/**
 * Main handler for the edge function
 */
serve(async (req) => {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const startTime = Date.now();
    const supabase = initSupabaseClient();
    
    // Parse the request body for configuration
    const config: SeederConfig = await req.json();
    
    // Basic validation
    if (!config.markets?.length || !config.genres?.length) {
      throw new Error('Markets and genres arrays are required and must not be empty');
    }
    
    if (!config.minPopularity || !config.maxArtists) {
      throw new Error('minPopularity and maxArtists are required');
    }
    
    // Apply sensible defaults
    config.excludeArtists = config.excludeArtists || [];
    
    // Initialize the seeding job
    const jobId = await initializeJob(supabase, config);
    console.log(`Started seeding job ${jobId}`);
    
    // Initialize progress tracking
    const jobProgress: JobProgress = {
      processed_markets: [],
      processed_genres: [],
      artist_count: 0
    };
    
    // Process each market-genre combination
    for (const market of config.markets) {
      // Track market progress
      if (!jobProgress.processed_markets.includes(market)) {
        jobProgress.processed_markets.push(market);
      }
      
      for (const genre of config.genres) {
        // Track genre progress
        if (!jobProgress.processed_genres.includes(genre)) {
          jobProgress.processed_genres.push(genre);
        }
        
        // Process this combination
        await processMarketGenreCombination(
          supabase, 
          jobId, 
          market, 
          genre, 
          config,
          jobProgress
        );
        
        // Update job progress
        await updateJobProgress(supabase, jobId, jobProgress);
        
        // Check if we've reached the maximum artists
        if (jobProgress.artist_count >= config.maxArtists) {
          console.log(`Reached maximum artists count (${config.maxArtists})`);
          await completeJob(supabase, jobId, jobProgress);
          
          return new Response(
            JSON.stringify({ 
              success: true, 
              message: 'Seeding completed successfully',
              jobId,
              stats: {
                artists_processed: jobProgress.artist_count,
                duration_ms: Date.now() - startTime
              }
            }), 
            { 
              headers: { 
                ...corsHeaders, 
                'Content-Type': 'application/json' 
              } 
            }
          );
        }
      }
    }
    
    // Mark job as completed
    await completeJob(supabase, jobId, jobProgress);
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Seeding completed successfully',
        jobId,
        stats: {
          artists_processed: jobProgress.artist_count,
          markets_processed: jobProgress.processed_markets.length,
          genres_processed: jobProgress.processed_genres.length,
          duration_ms: Date.now() - startTime
        }
      }), 
      { 
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json' 
        } 
      }
    );

  } catch (error) {
    console.error('Error in artist seeder:', error);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message,
        stack: error.stack
      }), 
      { 
        status: 500, 
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json' 
        } 
      }
    );
  }
});
