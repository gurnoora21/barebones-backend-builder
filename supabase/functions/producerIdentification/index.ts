
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getTrackDetails, spotifyApi } from "../lib/spotifyClient.ts";
import { createGeniusClient } from "../lib/geniusClient.ts";
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from "../types.ts";
import { logger, generateTraceId } from "../lib/logger.ts";
import { withRetry, withRateLimitedRetry } from "../lib/retry.ts";
import { createDbTransactionHelpers } from "../lib/dbHelpers.ts";

interface ProducerIdentificationMsg {
  trackId: string;
  trackName: string;
  albumId: string;
  artistId: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Producer {
  name: string;
  normalizedName: string;
  source: string; 
  role: string;
  confidence: number;
  external_id?: string;
  image_url?: string;
  metadata?: any;
}

class ProducerIdentificationWorker extends PageWorker<ProducerIdentificationMsg> {
  private geniusClient;
  private workerLogger = logger.child({ worker: 'ProducerIdentificationWorker' });

  constructor() {
    super('producer_identification', 60);
    const geniusToken = Deno.env.get("GENIUS_ACCESS_TOKEN");
    if (!geniusToken) {
      this.workerLogger.warn("GENIUS_ACCESS_TOKEN not set, Genius integration will be skipped");
    } else {
      this.geniusClient = createGeniusClient(geniusToken, this.supabase);
    }
  }

  private normalizeProducerName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9À-ÿ\s]/g, '') // Keep accented characters while removing special chars
      .trim()
      .replace(/\s+/g, ' '); // Normalize whitespace
  }
  
  /**
   * Get or create a producer record
   */
  private async getOrCreateProducer(producer: Producer): Promise<string> {
    const contextLogger = this.workerLogger.child({
      operation: 'getOrCreateProducer',
      producerName: producer.name,
      source: producer.source
    });
    
    const dbHelpers = createDbTransactionHelpers(this.supabase as SupabaseClient<Database>);
    
    return dbHelpers.withDbRetry(async () => {
      // First check if producer exists
      const { data: existingProducer } = await this.supabase
        .from('producers')
        .select('id, metadata, image_url')
        .eq('normalized_name', producer.normalizedName)
        .maybeSingle();
      
      if (existingProducer) {
        contextLogger.debug(`Producer ${producer.name} found in database with id ${existingProducer.id}`);
        
        // Update existing producer metadata with new information if available
        if (producer.role === 'producer' || producer.role === 'writer') {
          const currentMetadata = existingProducer.metadata as any || {};
          
          // Only update image if we don't already have one
          const imageUrl = existingProducer.image_url || producer.image_url;
          
          // Merge metadata carefully
          const updatedMetadata = {
            ...currentMetadata,
            roles: [...new Set([...(currentMetadata.roles || []), producer.role])],
            sources: [...new Set([...(currentMetadata.sources || []), producer.source])],
            ...(producer.metadata || {})
          };
          
          await this.supabase
            .from('producers')
            .update({ 
              metadata: updatedMetadata,
              image_url: imageUrl
            })
            .eq('id', existingProducer.id);
            
          contextLogger.debug(`Updated producer ${producer.name} metadata`);
        }
        
        return existingProducer.id;
      } else {
        // Create new producer
        contextLogger.debug(`Creating new producer record for ${producer.name}`);
        
        const { data: newProducer, error: insertError } = await this.supabase
          .from('producers')
          .insert({
            name: producer.name,
            normalized_name: producer.normalizedName,
            image_url: producer.image_url || null,
            metadata: { 
              source: producer.source,
              roles: [producer.role],
              external_ids: producer.external_id ? [producer.external_id] : [],
              discovery_timestamp: new Date().toISOString(),
              ...(producer.metadata || {})
            }
          })
          .select('id')
          .single();

        if (insertError) {
          contextLogger.error('Error inserting producer:', insertError);
          throw insertError;
        }
        
        contextLogger.info(`Created new producer ${producer.name} with id ${newProducer.id}`);
        return newProducer.id;
      }
    });
  }

  protected async process(msg: ProducerIdentificationMsg): Promise<void> {
    const { trackId, trackName, artistId } = msg;
    const traceId = generateTraceId();
    const contextLogger = this.workerLogger.child({
      operation: 'process',
      trackId,
      trackName,
      traceId
    });
    
    contextLogger.info(`Processing producer identification for track ${trackName} (${trackId})`);
    
    try {
      const track = await getTrackDetails(trackId);
      contextLogger.debug(`Found ${track.artists.length} artists/collaborators for track ${trackName}`);

      // Get track UUID from our database
      const { data: dbTrack } = await this.supabase
        .from('tracks')
        .select('id')
        .eq('spotify_id', trackId)
        .single();

      if (!dbTrack) {
        throw new Error(`Track ${trackId} not found in database`);
      }

      // Process Spotify collaborators
      const spotifyProducers: Producer[] = [];
      
      for (const artist of track.artists) {
        if (artist.id !== artistId) {  // Skip the main artist
          try {
            // Fetch full collaborator details to get images
            const collabDetails = await withRateLimitedRetry(
              () => spotifyApi<any>(`artists/${artist.id}`),
              'spotify-artist-details'
            );
            
            const collabImage = collabDetails.images?.[0]?.url || null;
            const normalizedName = this.normalizeProducerName(artist.name);
            
            spotifyProducers.push({
              name: artist.name,
              normalizedName,
              source: 'spotify',
              confidence: 0.8, // High confidence for Spotify data
              role: 'collaborator',
              image_url: collabImage,
              metadata: {
                images: collabDetails.images || []
              }
            });
            
            contextLogger.debug(`Processed Spotify collaborator: ${artist.name}`);
          } catch (error) {
            contextLogger.error(`Error fetching Spotify artist details for ${artist.name}:`, error);
            
            // Still add the artist with basic info
            spotifyProducers.push({
              name: artist.name,
              normalizedName: this.normalizeProducerName(artist.name),
              source: 'spotify',
              confidence: 0.8,
              role: 'collaborator'
            });
          }
        }
      }
      
      // Get primary artist for Genius search
      const primaryArtist = track.artists.find(a => a.id === artistId)?.name || '';

      // Fetch additional producer/writer information from Genius
      let geniusProducers: Producer[] = [];
      
      if (this.geniusClient) {
        try {
          contextLogger.debug(`Searching for track on Genius: ${trackName} by ${primaryArtist}`);
          
          // Search for the track on Genius
          const geniusSearchResult = await this.geniusClient.search(trackName, primaryArtist);
          const geniusId = geniusSearchResult?.response?.hits?.[0]?.result?.id;
          
          if (geniusId) {
            contextLogger.debug(`Found matching track on Genius with ID: ${geniusId}`);
            
            // Fetch full credits
            const geniusSongResult = await this.geniusClient.getSong(geniusId);
            const song = geniusSongResult?.response?.song;
            
            if (song) {
              // Get fallback image from primary artist if available
              const fallbackImage = song.primary_artist?.image_url || null;
              
              // Extract producer artists
              const producers = (song.producer_artists || []).map((a: any) => ({
                name: a.name,
                normalizedName: this.normalizeProducerName(a.name),
                source: 'genius',
                confidence: 0.9, // Very high confidence for explicit producer credits
                role: 'producer',
                external_id: `genius-${a.id}`,
                image_url: a.image_url || fallbackImage
              }));
              
              // Extract writer artists
              const writers = (song.writer_artists || []).map((a: any) => ({
                name: a.name,
                normalizedName: this.normalizeProducerName(a.name),
                source: 'genius',
                confidence: 0.9, // Very high confidence for explicit writer credits
                role: 'writer',
                external_id: `genius-${a.id}`,
                image_url: a.image_url || fallbackImage
              }));
              
              geniusProducers = [...producers, ...writers];
              contextLogger.info(
                `Found ${producers.length} producers and ${writers.length} writers from Genius for track ${trackName}`
              );
            }
          } else {
            contextLogger.info(`No matching track found on Genius for ${trackName} by ${primaryArtist}`);
          }
        } catch (error) {
          contextLogger.error(`Error fetching data from Genius for track ${trackName}:`, error);
          // Continue with Spotify data if Genius fails
        }
      }

      // Merge and deduplicate producer lists
      const allProducers = [...spotifyProducers, ...geniusProducers];
      const uniqueProducersByName = new Map<string, Producer>();

      // Deduplicate by name, preferring higher confidence sources
      for (const producer of allProducers) {
        const normalizedName = producer.normalizedName;
        
        if (!uniqueProducersByName.has(normalizedName) || 
            producer.confidence > uniqueProducersByName.get(normalizedName)!.confidence) {
          uniqueProducersByName.set(normalizedName, producer);
        }
      }
      
      contextLogger.debug(`Identified ${uniqueProducersByName.size} unique producers for track ${trackName}`);
      
      // Save each unique producer to the database
      for (const producer of uniqueProducersByName.values()) {
        try {
          // Create or get producer record
          const producerId = await this.getOrCreateProducer(producer);
          
          // Create track_producer relationship
          const { error: relationError } = await withRetry(async () => {
            return this.supabase
              .from('track_producers')
              .insert({
                track_id: dbTrack.id,
                producer_id: producerId,
                confidence: producer.confidence,
                source: producer.source
              });
          }, {
            maxAttempts: 3,
            initialDelayMs: 300
          });

          if (relationError) {
            contextLogger.error('Error creating track_producer relationship:', relationError);
            throw relationError;
          }

          await this.enqueue('social_enrichment', { 
            producerName: producer.name 
          });
          
          contextLogger.debug(`Enqueued social enrichment for ${producer.role || 'collaborator'}: ${producer.name}`);
        } catch (producerError) {
          contextLogger.error(`Error processing producer ${producer.name}:`, producerError);
        }
      }
      
      contextLogger.info(`Finished processing collaborators and producers for track ${trackName}`);
    } catch (error) {
      contextLogger.error(`Error processing producer identification for track ${trackId}:`, error);
      throw error;
    }
  }
}

// Set up global error handlers
addEventListener("error", (event) => {
  logger.error("Uncaught error:", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error
  });
});

addEventListener("unhandledrejection", (event) => {
  logger.error("Unhandled promise rejection:", {
    reason: event.reason
  });
});

const worker = new ProducerIdentificationWorker();

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
    logger.error("Worker execution error:", error);
    
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
