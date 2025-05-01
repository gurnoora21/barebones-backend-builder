
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getTrackDetails, spotifyApi } from "../lib/spotifyClient.ts";
import { createGeniusClient } from "../lib/geniusClient.ts";
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from "../types.ts";
import { logger, generateTraceId } from "../lib/logger.ts";
import { withRetry, withRateLimitedRetry } from "../lib/retry.ts";
import { createDbTransactionHelpers } from "../lib/dbHelpers.ts";
import { validate as uuidValidate } from "https://deno.land/std@0.178.0/uuid/mod.ts";

interface ProducerIdentificationMsg {
  trackId: string;    // Spotify Track ID
  trackUuid?: string; // Database UUID - optional for backward compatibility
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

interface ProducerRecord {
  id?: string;
  name: string;
  normalized_name: string;
  image_url: string | null;
  metadata: {
    source: string;
    roles: string[];
    external_ids?: string[];
    discovery_timestamp: string;
    [key: string]: any;
  };
}

interface TrackProducerRelation {
  track_id: string;     // Must be a valid UUID
  producer_id: string;  // Must be a valid UUID
  confidence: number;
  source: string;
}

class ProducerIdentificationWorker extends PageWorker<ProducerIdentificationMsg> {
  private geniusClient;
  private workerLogger = logger.child({ worker: 'ProducerIdentificationWorker' });
  private MAX_BATCH_SIZE = 25; // Maximum producers to process in one batch
  private processingChunkSize = 5; // Number of producers to process in one database operation

  constructor() {
    super('producer_identification', 180); // Increased timeout from 60 to 180 seconds
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
   * Validates if the string is a valid UUID
   */
  private isValidUuid(id: string): boolean {
    return uuidValidate(id);
  }
  
  /**
   * Process producers in smaller batches to avoid timeout issues
   */
  private async processProducerBatch(producers: Producer[]): Promise<Map<string, string>> {
    if (producers.length === 0) {
      return new Map();
    }
    
    // Process producers in smaller chunks to avoid timeouts
    const chunks = [];
    for (let i = 0; i < producers.length; i += this.processingChunkSize) {
      chunks.push(producers.slice(i, i + this.processingChunkSize));
    }
    
    const producerIdMap = new Map<string, string>();
    
    for (const chunk of chunks) {
      const chunkMap = await this.getOrCreateProducers(chunk);
      
      // Merge the chunk map into the main map
      for (const [key, value] of chunkMap.entries()) {
        producerIdMap.set(key, value);
      }
      
      // Add a small delay between chunks to reduce database contention
      if (chunks.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    return producerIdMap;
  }
  
  /**
   * Get or create producers in batch
   */
  private async getOrCreateProducers(producers: Producer[]): Promise<Map<string, string>> {
    if (producers.length === 0) {
      return new Map();
    }
    
    const contextLogger = this.workerLogger.child({
      operation: 'getOrCreateProducers',
      count: producers.length
    });
    
    const dbHelpers = createDbTransactionHelpers(this.supabase as SupabaseClient<Database>);
    const normalizedNameToProducer = new Map<string, Producer>();
    const normalizedNames: string[] = [];
    
    // Deduplicate by normalized name
    for (const producer of producers) {
      normalizedNameToProducer.set(producer.normalizedName, producer);
      normalizedNames.push(producer.normalizedName);
    }
    
    try {
      return await dbHelpers.withDbRetry(async () => {
        // First check which producers already exist
        const { data: existingProducers, error } = await this.supabase
          .from('producers')
          .select('id, name, normalized_name, metadata, image_url')
          .in('normalized_name', normalizedNames);
          
        if (error) {
          contextLogger.error('Error fetching existing producers:', error);
          throw error;
        }
        
        // Map of normalized name to producer id
        const producerIdMap = new Map<string, string>();
        
        // Track which producers need to be updated
        const producersToUpdate: { id: string; metadata: any; image_url: string | null }[] = [];
        
        // Add existing producers to the map and prepare updates
        for (const existingProducer of (existingProducers || [])) {
          if (!this.isValidUuid(existingProducer.id)) {
            contextLogger.warn(`Found producer with invalid UUID: ${existingProducer.id}, skipping`);
            continue;
          }
          
          producerIdMap.set(existingProducer.normalized_name, existingProducer.id);
          
          // Get the producer from our input set
          const producer = normalizedNameToProducer.get(existingProducer.normalized_name);
          if (producer && (producer.role === 'producer' || producer.role === 'writer')) {
            // Update metadata with new information
            const currentMetadata = existingProducer.metadata || {};
            
            // Only update image if we don't already have one
            const imageUrl = existingProducer.image_url || producer.image_url;
            
            // Merge metadata carefully
            const roles = [...new Set([...(currentMetadata.roles || []), producer.role])];
            const sources = [...new Set([...(currentMetadata.sources || []), producer.source])];
            const externalIds = [...new Set([
              ...(currentMetadata.external_ids || []),
              ...(producer.external_id ? [producer.external_id] : [])
            ])];
            
            producersToUpdate.push({
              id: existingProducer.id,
              metadata: {
                ...currentMetadata,
                roles,
                sources,
                external_ids: externalIds,
                ...(producer.metadata || {})
              },
              image_url: imageUrl
            });
          }
          
          // Remove from the map of producers to create
          normalizedNameToProducer.delete(existingProducer.normalized_name);
        }
        
        // Update existing producers in batch if needed
        if (producersToUpdate.length > 0) {
          const { error: updateError } = await this.supabase
            .from('producers')
            .upsert(producersToUpdate);
            
          if (updateError) {
            contextLogger.error('Error updating producers:', updateError);
          } else {
            contextLogger.debug(`Updated ${producersToUpdate.length} existing producers`);
          }
        }
        
        // Prepare new producers to be created
        const newProducers: ProducerRecord[] = Array.from(normalizedNameToProducer.values()).map(p => ({
          name: p.name,
          normalized_name: p.normalizedName,
          image_url: p.image_url || null,
          metadata: { 
            source: p.source,
            roles: [p.role],
            external_ids: p.external_id ? [p.external_id] : [],
            discovery_timestamp: new Date().toISOString(),
            ...(p.metadata || {})
          }
        }));
        
        // Create new producers
        if (newProducers.length > 0) {
          const { data: createdProducers, error: insertError } = await this.supabase
            .from('producers')
            .insert(newProducers)
            .select('id, normalized_name');

          if (insertError) {
            contextLogger.error('Error inserting producers:', insertError);
            throw insertError;
          }
          
          // Add new producers to the id map
          for (const created of (createdProducers || [])) {
            if (this.isValidUuid(created.id)) {
              producerIdMap.set(created.normalized_name, created.id);
            } else {
              contextLogger.warn(`Created producer with invalid UUID: ${created.id}, skipping`);
            }
          }
          
          contextLogger.info(`Created ${newProducers.length} new producers`);
        }
        
        return producerIdMap;
      });
    } catch (error) {
      contextLogger.error(`Failed to get or create producers:`, error);
      return new Map();
    }
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

      // Get track UUID from our database or use provided trackUuid
      let dbTrackId = msg.trackUuid;
      
      if (!dbTrackId) {
        contextLogger.debug(`No trackUuid provided in message, looking up from database`);
        const { data: dbTrack } = await this.supabase
          .from('tracks')
          .select('id')
          .eq('spotify_id', trackId)
          .single();

        if (!dbTrack) {
          throw new Error(`Track ${trackId} not found in database`);
        }
        
        dbTrackId = dbTrack.id;
      }

      // Validate UUID format
      if (!this.isValidUuid(dbTrackId)) {
        throw new Error(`Invalid track UUID format: ${dbTrackId}`);
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
      
      // Convert to array and limit batch size
      let uniqueProducers = Array.from(uniqueProducersByName.values());
      
      // Limit batch size to avoid timeouts
      if (uniqueProducers.length > this.MAX_BATCH_SIZE) {
        contextLogger.warn(`Large number of producers (${uniqueProducers.length}) found for track ${trackName}, limiting to ${this.MAX_BATCH_SIZE}`);
        uniqueProducers = uniqueProducers.slice(0, this.MAX_BATCH_SIZE);
      }
      
      contextLogger.debug(`Identified ${uniqueProducers.length} unique producers for track ${trackName}`);
      
      if (uniqueProducers.length === 0) {
        contextLogger.info(`No producers identified for track ${trackName}`);
        return;
      }
      
      // Get or create all producers in batch
      const producerIdMap = await this.processProducerBatch(uniqueProducers);
      
      if (producerIdMap.size === 0) {
        contextLogger.warn(`Failed to get producer IDs for track ${trackName}`);
        return;
      }
      
      // Create track_producer relationships in batch
      const trackProducerRelations: TrackProducerRelation[] = [];
      const socialEnrichmentQueue: { producerId: string, producerName: string }[] = [];
      
      for (const producer of uniqueProducers) {
        const producerId = producerIdMap.get(producer.normalizedName);
        if (!producerId) {
          contextLogger.warn(`No producer ID found for ${producer.name}`);
          continue;
        }
        
        if (!this.isValidUuid(producerId)) {
          contextLogger.warn(`Invalid producer UUID format: ${producerId} for producer ${producer.name}`);
          continue;
        }
        
        trackProducerRelations.push({
          track_id: dbTrackId,
          producer_id: producerId,
          confidence: producer.confidence,
          source: producer.source
        });
        
        socialEnrichmentQueue.push({
          producerId,
          producerName: producer.name
        });
      }
      
      // Insert all track-producer relationships at once
      if (trackProducerRelations.length > 0) {
        const { error: relationError } = await withRetry(async () => {
          return this.supabase
            .from('track_producers')
            .upsert(trackProducerRelations);
        }, {
          maxAttempts: 3,
          initialDelayMs: 300
        });

        if (relationError) {
          contextLogger.error('Error creating track_producer relationships:', relationError);
          throw relationError;
        }
        
        contextLogger.info(`Created ${trackProducerRelations.length} track-producer relationships`);
      }
      
      // Enqueue social enrichment tasks in batch, with a limit to avoid overwhelming the queue
      const MAX_ENRICHMENT_QUEUE = 10;
      const enrichmentBatch = socialEnrichmentQueue.slice(0, MAX_ENRICHMENT_QUEUE);
      
      for (const producer of enrichmentBatch) {
        await this.enqueue('social_enrichment', { 
          producerId: producer.producerId,
          producerName: producer.producerName
        });
        
        contextLogger.debug(`Enqueued social enrichment for ${producer.producerName}`);
      }
      
      if (socialEnrichmentQueue.length > MAX_ENRICHMENT_QUEUE) {
        contextLogger.info(`Limited social enrichment queue to ${MAX_ENRICHMENT_QUEUE} out of ${socialEnrichmentQueue.length} producers`);
      }
      
      contextLogger.info(`Finished processing collaborators and producers for track ${trackName}`);
    } catch (error) {
      contextLogger.error(`Error processing producer identification for track ${trackId}:`, error);
      throw error;
    }
  }
  
  /**
   * Implement health check endpoint
   */
  async getHealthStatus(): Promise<object> {
    try {
      // Get queue statistics
      const { data: queueStats, error } = await this.supabase.rpc(
        'pgmq_read', 
        { 
          queue_name: 'producer_identification', 
          visibility_timeout: 0,
          batch_size: 1
        }
      );
      
      // Count pending messages
      const pendingMessagesCount = queueStats?.length || 0;
      
      return {
        status: 'healthy',
        queue: 'producer_identification',
        pendingMessages: pendingMessagesCount,
        workerTimeout: 180
      };
    } catch (e) {
      return {
        status: 'unhealthy',
        error: e.message
      };
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
    // Handle health check endpoint
    const url = new URL(req.url);
    
    if (url.pathname.endsWith('/health')) {
      const healthStatus = await worker.getHealthStatus();
      
      return new Response(JSON.stringify(healthStatus), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
    
    // Standard worker processing
    await worker.run();
    
    return new Response(JSON.stringify({ success: true }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  } catch (error) {
    logger.error("Worker execution error:", error);
    
    return new Response(JSON.stringify({ 
      error: error.message,
      details: error.stack 
    }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
