
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getTrackDetails, spotifyApi } from "../lib/spotifyClient.ts";
import { createGeniusClient } from "../lib/geniusClient.ts";
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from "../types.ts";

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

class ProducerIdentificationWorker extends PageWorker<ProducerIdentificationMsg> {
  private geniusClient;

  constructor() {
    super('producer_identification', 60);
    const geniusToken = Deno.env.get("GENIUS_ACCESS_TOKEN");
    if (!geniusToken) {
      console.warn("GENIUS_ACCESS_TOKEN not set, Genius integration will be skipped");
    } else {
      this.geniusClient = createGeniusClient(geniusToken, this.supabase);
    }
  }

  private normalizeProducerName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^\w\s]/g, '') // Remove special characters
      .trim()
      .replace(/\s+/g, ' '); // Normalize whitespace
  }

  protected async process(msg: ProducerIdentificationMsg): Promise<void> {
    const { trackId, trackName, artistId } = msg;
    console.log(`Processing producer identification for track ${trackName} (${trackId})`);
    
    try {
      const track = await getTrackDetails(trackId);
      console.log(`Found ${track.artists.length} artists/collaborators for track ${trackName}`);

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
      const spotifyProducers = [];
      
      for (const artist of track.artists) {
        if (artist.id !== artistId) {  // Skip the main artist
          try {
            // Fetch full collaborator details to get images
            const collabDetails = await spotifyApi<any>(`artists/${artist.id}`);
            const collabImage = collabDetails.images?.[0]?.url || null;
            
            spotifyProducers.push({
              source: 'spotify',
              name: artist.name,
              confidence: 0.8, // High confidence for Spotify data
              role: 'collaborator',
              image_url: collabImage, // Store collaborator image URL
              metadata: {
                images: collabDetails.images || []
              }
            });
          } catch (error) {
            console.error(`Error fetching Spotify artist details for ${artist.name}:`, error);
            spotifyProducers.push({
              source: 'spotify',
              name: artist.name,
              confidence: 0.8,
              role: 'collaborator'
            });
          }
        }
      }
      
      // Get primary artist for Genius search
      const primaryArtist = track.artists.find(a => a.id === artistId)?.name || '';

      // Fetch additional producer/writer information from Genius
      let geniusProducers = [];
      
      if (this.geniusClient) {
        try {
          // Search for the track on Genius
          const geniusSearchResult = await this.geniusClient.search(trackName, primaryArtist);
          const geniusId = geniusSearchResult?.response?.hits?.[0]?.result?.id;
          
          if (geniusId) {
            // Fetch full credits
            const geniusSongResult = await this.geniusClient.getSong(geniusId);
            const song = geniusSongResult?.response?.song;
            
            if (song) {
              // Get fallback image from primary artist if available
              const fallbackImage = song.primary_artist?.image_url || null;
              
              // Extract producer artists
              const producers = (song.producer_artists || []).map((a: any) => ({
                source: 'genius',
                name: a.name,
                confidence: 0.9, // Very high confidence for explicit producer credits
                role: 'producer',
                external_id: `genius-${a.id}`,
                image_url: a.image_url || fallbackImage // Use artist image or fallback
              }));
              
              // Extract writer artists
              const writers = (song.writer_artists || []).map((a: any) => ({
                source: 'genius',
                name: a.name,
                confidence: 0.9, // Very high confidence for explicit writer credits
                role: 'writer',
                external_id: `genius-${a.id}`,
                image_url: a.image_url || fallbackImage // Use artist image or fallback
              }));
              
              geniusProducers = [...producers, ...writers];
              console.log(`Found ${producers.length} producers and ${writers.length} writers from Genius for track ${trackName}`);
            }
          } else {
            console.log(`No matching track found on Genius for ${trackName} by ${primaryArtist}`);
          }
        } catch (error) {
          console.error(`Error fetching data from Genius for track ${trackName}:`, error);
          // Continue with Spotify data if Genius fails
        }
      }

      // Merge and deduplicate producer lists
      const allProducers = [...spotifyProducers, ...geniusProducers];
      const uniqueProducersByName = new Map();

      // Deduplicate by name, preferring higher confidence sources
      for (const producer of allProducers) {
        const normalizedName = this.normalizeProducerName(producer.name);
        
        if (!uniqueProducersByName.has(normalizedName) || 
            producer.confidence > uniqueProducersByName.get(normalizedName).confidence) {
          uniqueProducersByName.set(normalizedName, producer);
        }
      }
      
      // Save each unique producer to the database
      for (const [normalizedName, producer] of uniqueProducersByName.entries()) {
        // Create or get producer
        const { data: existingProducer } = await this.supabase
          .from('producers')
          .select('id')
          .eq('normalized_name', normalizedName)
          .single();

        let producerId;
        if (existingProducer) {
          producerId = existingProducer.id;
          
          // Update existing producer metadata with new information if available
          if (producer.role === 'producer' || producer.role === 'writer') {
            const { data: currentProducer } = await this.supabase
              .from('producers')
              .select('metadata, image_url')
              .eq('id', producerId)
              .single();
            
            if (currentProducer) {
              // Only update image if we don't already have one
              const imageUrl = currentProducer.image_url || producer.image_url;
              
              const updatedMetadata = {
                ...currentProducer.metadata,
                roles: [...new Set([...(currentProducer.metadata?.roles || []), producer.role])],
                sources: [...new Set([...(currentProducer.metadata?.sources || []), producer.source])],
                ...(producer.metadata || {})
              };
              
              await this.supabase
                .from('producers')
                .update({ 
                  metadata: updatedMetadata,
                  image_url: imageUrl
                })
                .eq('id', producerId);
            }
          }
        } else {
          // Create new producer
          const { data: newProducer, error: insertError } = await this.supabase
            .from('producers')
            .insert({
              name: producer.name,
              normalized_name: normalizedName,
              image_url: producer.image_url || null, // Store the image URL
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
            console.error('Error inserting producer:', insertError);
            throw insertError;
          }
          producerId = newProducer.id;
        }

        // Create track_producer relationship
        const { error: relationError } = await this.supabase
          .from('track_producers')
          .insert({
            track_id: dbTrack.id,
            producer_id: producerId,
            confidence: producer.confidence,
            source: producer.source
          });

        if (relationError) {
          console.error('Error creating track_producer relationship:', relationError);
          throw relationError;
        }

        await this.enqueue('social_enrichment', { 
          producerName: producer.name 
        });
        
        console.log(`Enqueued social enrichment for ${producer.role || 'collaborator'}: ${producer.name} (source: ${producer.source})`);
      }
      
      console.log(`Finished processing collaborators and producers for track ${trackName}`);
    } catch (error) {
      console.error(`Error processing producer identification for track ${trackId}:`, error);
      throw error;
    }
  }
}

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
    console.error("Worker execution error:", error);
    
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
