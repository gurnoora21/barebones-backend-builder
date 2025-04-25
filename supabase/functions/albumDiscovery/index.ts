
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { getArtistAlbums, getTrackDetails, wait } from "../lib/spotifyClient.ts";

interface AlbumDiscoveryMsg {
  artistId: string;
  offset: number;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class AlbumDiscoveryWorker extends PageWorker<AlbumDiscoveryMsg> {
  constructor() {
    super('album_discovery', 120);
  }

  /**
   * Formats a Spotify release date to a PostgreSQL-compatible date format
   * Handles various formats: YYYY, YYYY-MM, YYYY-MM-DD
   */
  private formatReleaseDate(spotifyReleaseDate: string): string | null {
    if (!spotifyReleaseDate) return null;
    
    // Handle different Spotify release date formats
    if (/^\d{4}$/.test(spotifyReleaseDate)) {
      // Year only: convert to YYYY-01-01 format
      return `${spotifyReleaseDate}-01-01`;
    } else if (/^\d{4}-\d{2}$/.test(spotifyReleaseDate)) {
      // Year-month: convert to YYYY-MM-01 format
      return `${spotifyReleaseDate}-01`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(spotifyReleaseDate)) {
      // Already in YYYY-MM-DD format
      return spotifyReleaseDate;
    }
    
    // If format is unrecognized, log it and return null
    console.log(`Unrecognized release date format: ${spotifyReleaseDate}`);
    return null;
  }

  // Verifies if the album belongs to the specified artist as a primary artist
  private async isArtistPrimaryOnAlbum(album: any, artistId: string): Promise<boolean> {
    // Check if the artist is listed as the first artist
    const primaryArtistId = album.artists && album.artists.length > 0
      ? album.artists[0].id
      : null;
    
    console.log(`Checking album "${album.name}" - Primary artist ID: ${primaryArtistId}, Target artist ID: ${artistId}`);
    
    // If the first artist matches our target artist, this is what we want
    return primaryArtistId === artistId;
  }

  protected async process(msg: AlbumDiscoveryMsg): Promise<void> {
    const { artistId, offset } = msg;
    console.log(`Processing album discovery for artist ${artistId} with offset ${offset}`);
    
    try {
      const albums = await getArtistAlbums(artistId, offset);
      console.log(`Found ${albums.items.length} potential albums for artist ${artistId}`);

      // Get artist UUID from our database
      const { data: artist, error: artistError } = await this.supabase
        .from('artists')
        .select('id')
        .eq('spotify_id', artistId)
        .single();

      if (artistError) {
        console.error(`Error finding artist ${artistId} in database:`, artistError);
        throw artistError;
      }

      if (!artist) {
        const errorMsg = `Artist ${artistId} not found in database`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
      
      let validAlbumsCount = 0;
      let filteredAlbumsCount = 0;
      
      for (let i = 0; i < albums.items.length; i++) {
        const album = albums.items[i];
        
        try {
          // Verify this is a primary artist album - the first artist should be our target
          const isPrimaryArtist = await this.isArtistPrimaryOnAlbum(album, artistId);
          
          if (!isPrimaryArtist) {
            console.log(`Skipping album "${album.name}" as ${artistId} is not the primary artist`);
            filteredAlbumsCount++;
            continue;
          }
          
          // Exclude compilations and appears_on album types
          if (album.album_type === 'compilation' || album.album_group === 'appears_on') {
            console.log(`Skipping album "${album.name}" of type ${album.album_type || album.album_group}`);
            filteredAlbumsCount++;
            continue;
          }
          
          // Format the release date properly
          const formattedReleaseDate = this.formatReleaseDate(album.release_date);
          
          // Check if album already exists
          const { data: existingAlbum, error: selectError } = await this.supabase
            .from('albums')
            .select('id')
            .eq('spotify_id', album.id)
            .single();

          if (selectError && selectError.code !== 'PGRST116') { // Not a "no rows" error
            console.error(`Error checking for existing album ${album.id}:`, selectError);
            throw selectError;
          }

          if (!existingAlbum) {
            // Insert album with formatted release date
            const { error: insertError } = await this.supabase
              .from('albums')
              .insert({
                spotify_id: album.id,
                artist_id: artist.id,
                name: album.name,
                release_date: formattedReleaseDate,
                metadata: {
                  source: 'spotify',
                  type: album.album_type,
                  total_tracks: album.total_tracks,
                  discovery_timestamp: new Date().toISOString()
                }
              });

            if (insertError) {
              console.error(`Error inserting album ${album.name} (${album.id}):`, insertError, 
                'Album data:', { 
                  id: album.id, 
                  name: album.name, 
                  release_date: album.release_date,
                  formatted_release_date: formattedReleaseDate 
                });
              throw insertError;
            }
            
            console.log(`Created new album record: ${album.name} (${album.id}) with release date ${formattedReleaseDate}`);
          } else {
            console.log(`Album ${album.name} (${album.id}) already exists, skipping insert`);
          }
          
          // Queue track discovery for this album
          await this.enqueue('track_discovery', {
            albumId: album.id,
            albumName: album.name,
            artistId
          });
          
          console.log(`Enqueued track discovery for album: ${album.name} (${album.id})`);
          validAlbumsCount++;
          
          // Add a small delay every few albums to avoid rate limiting
          if (i > 0 && i % 5 === 0) {
            await wait(200);
          }
        } catch (albumError) {
          // Don't let a single album error stop the entire batch
          console.error(`Error processing album ${album.name} (${album.id}):`, albumError);
          // Continue with the next album
        }
      }
      
      console.log(`Processed ${albums.items.length} albums, valid: ${validAlbumsCount}, filtered: ${filteredAlbumsCount}`);
      
      // If there are more albums, queue the next page - but only if we found valid albums
      // If we didn't find any valid albums on this page, we might want to stop here to prevent unnecessary API calls
      if (offset + albums.items.length < albums.total && validAlbumsCount > 0) {
        const newOffset = offset + albums.items.length;
        
        await this.enqueue('album_discovery', { artistId, offset: newOffset });
        
        console.log(`Enqueued next page of albums for artist ${artistId} with offset ${newOffset}`);
      } else {
        console.log(`Finished processing all albums for artist ${artistId}`);
      }
    } catch (error) {
      console.error(`Comprehensive error in album discovery for artist ${artistId}:`, error);
      throw error; // Re-throw to allow PageWorker to handle
    }
  }
}

const worker = new AlbumDiscoveryWorker();

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Album Discovery worker received request');
    
    await worker.run();
    
    return new Response(JSON.stringify({ success: true }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  } catch (error) {
    console.error("Worker execution error:", error);
    
    return new Response(JSON.stringify({ 
      error: error.message,
      details: error.stack 
    }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
