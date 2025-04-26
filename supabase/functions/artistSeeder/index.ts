
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';
import { getSpotifyArtistId } from "../lib/spotifyClient.ts";

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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function initializeJob(supabase: any, config: SeederConfig): Promise<string> {
  const { data, error } = await supabase
    .from('seeding_jobs')
    .insert({
      job_type: 'artist_seeding',
      config,
      status: 'running',
      progress: {
        processed_markets: [],
        processed_genres: [],
        artist_count: 0
      }
    })
    .select()
    .single();

  if (error) throw error;
  return data.id;
}

async function searchArtists(market: string, genre: string, config: SeederConfig) {
  const searchQuery = `genre:${genre}`;
  const data = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(searchQuery)}&type=artist&market=${market}&limit=50`,
    {
      headers: {
        'Authorization': `Bearer ${await ensureToken()}`
      }
    }
  ).then(res => res.json());

  if (!data.artists) return [];

  return data.artists.items.filter((artist: any) => {
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
}

async function processMarketGenreCombination(
  supabase: any,
  jobId: string,
  market: string,
  genre: string,
  config: SeederConfig
) {
  const artists = await searchArtists(market, genre, config);
  
  for (const artist of artists) {
    try {
      // Check if we've already processed this artist
      const { data: existing } = await supabase
        .from('seeding_artists')
        .select('spotify_id')
        .eq('spotify_id', artist.id)
        .eq('job_id', jobId)
        .single();

      if (existing) continue;

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

      // Queue artist for album discovery
      await supabase.functions.invoke('artistDiscovery', {
        body: { artistId: artist.id }
      });

    } catch (error) {
      console.error(`Error processing artist ${artist.id}:`, error);
      await supabase.from('seeding_artists').insert({
        job_id: jobId,
        spotify_id: artist.id,
        success: false,
        details: { error: String(error), market, genre }
      });
    }
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient<Database>(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } }
    );

    // Parse the request body for configuration
    const config: SeederConfig = await req.json();

    // Validate config
    if (!config.markets?.length || !config.genres?.length) {
      throw new Error('Markets and genres arrays are required and must not be empty');
    }

    // Initialize the seeding job
    const jobId = await initializeJob(supabase, config);
    console.log(`Started seeding job ${jobId}`);

    // Process each market-genre combination
    for (const market of config.markets) {
      for (const genre of config.genres) {
        console.log(`Processing market: ${market}, genre: ${genre}`);
        
        await processMarketGenreCombination(supabase, jobId, market, genre, config);

        // Update job progress
        await supabase
          .from('seeding_jobs')
          .update({
            progress: {
              processed_markets: [market],
              processed_genres: [genre],
              last_processed: new Date().toISOString()
            }
          })
          .eq('id', jobId);

        // Check if we've reached the maximum artists
        const { count } = await supabase
          .from('seeding_artists')
          .select('*', { count: 'exact', head: true })
          .eq('job_id', jobId)
          .eq('success', true);

        if (count >= config.maxArtists) {
          console.log(`Reached maximum artists count (${config.maxArtists})`);
          await supabase
            .from('seeding_jobs')
            .update({
              status: 'completed',
              completed_at: new Date().toISOString()
            })
            .eq('id', jobId);

          return new Response(
            JSON.stringify({ 
              success: true, 
              message: 'Seeding completed successfully',
              jobId 
            }), 
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }
    }

    // Mark job as completed
    await supabase
      .from('seeding_jobs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString()
      })
      .eq('id', jobId);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Seeding completed successfully',
        jobId 
      }), 
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in artist seeder:', error);
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
