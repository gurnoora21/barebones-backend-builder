
import { useParams } from 'react-router-dom';
import { useArtist, useArtistProducers } from '@/hooks/useArtist';
import { useQuery } from '@tanstack/react-query';
import { fetchList, Albums, Tracks } from '@/lib/supabase';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Instagram, Twitter, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useState } from 'react';
import { ProducerGrid } from '@/components/producers/ProducerGrid';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export default function ArtistPage() {
  const { id } = useParams<{ id: string }>();
  const [currentTab, setCurrentTab] = useState('producers');
  
  const { data: artistData, isLoading: isLoadingArtist, error: artistError } = useArtist(id || '');
  const { data: producersData, isLoading: isLoadingProducers } = useArtistProducers(id || '');
  
  // Fetch albums for the artist
  const { data: albumsData, isLoading: isLoadingAlbums } = useQuery({
    queryKey: ['artistAlbums', id],
    queryFn: () => fetchList<Albums>('albums', {
      filters: { artist_id: id },
      orderBy: { column: 'release_date', ascending: false }
    }),
    enabled: !!id,
  });

  // Fetch tracks for each album
  const { data: tracksData, isLoading: isLoadingTracks } = useQuery({
    queryKey: ['artistTracks', albumsData?.data],
    queryFn: async () => {
      if (!albumsData?.data?.length) return [];
      
      const albumIds = albumsData.data.map(album => album.id);
      const trackResults = await Promise.all(
        albumIds.map(async (albumId) => {
          const { data, error } = await fetchList<Tracks>('tracks', {
            filters: { album_id: albumId },
            orderBy: { column: 'name', ascending: true }
          });
          
          return { albumId, tracks: data || [], error };
        })
      );
      
      return trackResults;
    },
    enabled: !!albumsData?.data?.length,
  });
  
  // Fetch producers for each track
  const { data: trackProducerData } = useQuery({
    queryKey: ['trackProducers', tracksData],
    queryFn: async () => {
      if (!tracksData?.length) return {};
      
      const trackIds = tracksData
        .flatMap(item => item.tracks)
        .map((track: any) => track.id);
      
      if (trackIds.length === 0) return {};
      
      // Need to implement a batch query here for performance
      const results = await fetchList('track_producers', {
        // In a real implementation, we'd need to handle the case where
        // there are too many track IDs to fit in a single query
      });
      
      const trackProducerMap: Record<string, any[]> = {};
      if (results.data) {
        results.data.forEach((tp: any) => {
          if (!trackProducerMap[tp.track_id]) {
            trackProducerMap[tp.track_id] = [];
          }
          trackProducerMap[tp.track_id].push(tp);
        });
      }
      
      return trackProducerMap;
    },
    enabled: !!tracksData?.length,
  });
  
  const artist = artistData?.data;
  const albums = albumsData?.data || [];
  const producers = producersData?.data || [];
  
  // Organize tracks by album
  const tracksByAlbum: Record<string, any[]> = {};
  if (tracksData) {
    tracksData.forEach(({ albumId, tracks }) => {
      if (albumId) {
        tracksByAlbum[albumId] = tracks;
      }
    });
  }
  
  if (artistError) {
    return (
      <div className="text-center py-12">
        <h2 className="text-2xl font-bold">Error Loading Artist</h2>
        <p className="text-muted-foreground mt-2">
          {(artistError as any).message || 'Failed to load artist details'}
        </p>
      </div>
    );
  }
  
  return (
    <div className="space-y-8 pb-8">
      {/* Artist Header */}
      <section>
        {isLoadingArtist ? (
          <ArtistHeaderSkeleton />
        ) : artist ? (
          <div className="flex flex-col md:flex-row items-center md:items-center gap-6">
            <UserAvatar 
              name={artist.name} 
              imageUrl={artist.metadata && typeof artist.metadata === 'object' ? (artist.metadata as any).image_url : undefined} 
              size="lg"
              className="h-24 w-24"
            />
            
            <div className="flex-1 text-center md:text-left">
              <h1 className="text-3xl font-bold">{artist.name}</h1>
              
              <div className="flex gap-4 mt-4 justify-center md:justify-start">
                {artist.twitter_handle && (
                  <Button variant="outline" size="sm" asChild>
                    <a 
                      href={`https://twitter.com/${artist.twitter_handle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Twitter className="h-4 w-4 mr-2" /> Twitter
                    </a>
                  </Button>
                )}
                
                {artist.instagram_handle && (
                  <Button variant="outline" size="sm" asChild>
                    <a 
                      href={`https://instagram.com/${artist.instagram_handle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Instagram className="h-4 w-4 mr-2" /> Instagram
                    </a>
                  </Button>
                )}
                
                {artist.spotify_id && (
                  <Button variant="outline" size="sm" asChild>
                    <a 
                      href={`https://open.spotify.com/artist/${artist.spotify_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-4 w-4 mr-2" /> Spotify
                    </a>
                  </Button>
                )}
              </div>
            </div>
            
            {artist.followers !== null && (
              <div className="p-4 bg-muted rounded-lg text-center min-w-[140px]">
                <p className="text-sm text-muted-foreground">Followers</p>
                <p className="text-2xl font-bold">
                  {formatNumber(artist.followers || 0)}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-12">
            <h2 className="text-2xl font-bold">Artist Not Found</h2>
          </div>
        )}
      </section>
      
      {/* Tab Navigation */}
      {artist && (
        <section>
          <Tabs value={currentTab} onValueChange={setCurrentTab} className="w-full">
            <TabsList>
              <TabsTrigger value="producers">Producers</TabsTrigger>
              <TabsTrigger value="discography">Discography</TabsTrigger>
            </TabsList>
            
            <TabsContent value="producers" className="mt-6">
              <div className="mb-4">
                <h2 className="text-xl font-semibold">Producers</h2>
                <p className="text-muted-foreground">
                  Producers {artist.name} has worked with
                </p>
              </div>
              
              {isLoadingProducers ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {Array(5).fill(0).map((_, i) => (
                    <div key={i} className="bg-muted h-48 rounded-lg animate-pulse" />
                  ))}
                </div>
              ) : producers.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No producer connections found</p>
                </div>
              ) : (
                <ProducerGrid producers={producers} />
              )}
            </TabsContent>
            
            <TabsContent value="discography" className="mt-6">
              <div className="mb-4">
                <h2 className="text-xl font-semibold">Discography</h2>
                <p className="text-muted-foreground">
                  Albums and tracks by {artist.name}
                </p>
              </div>
              
              {isLoadingAlbums ? (
                <div className="space-y-4">
                  {Array(3).fill(0).map((_, i) => (
                    <div key={i} className="border rounded-lg p-4">
                      <Skeleton className="h-6 w-48 mb-4" />
                      <div className="space-y-2">
                        {Array(4).fill(0).map((_, j) => (
                          <Skeleton key={j} className="h-5 w-full" />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : albums.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No albums found</p>
                </div>
              ) : (
                <Accordion type="multiple" className="space-y-4">
                  {albums.map((album) => {
                    const releaseYear = album.release_date ? 
                      new Date(album.release_date).getFullYear() : 'Unknown';
                    const albumTracks = tracksByAlbum[album.id] || [];
                    
                    return (
                      <AccordionItem 
                        key={album.id} 
                        value={album.id}
                        className="border rounded-lg"
                      >
                        <AccordionTrigger className="px-4 py-2 hover:bg-muted/50">
                          <div className="flex items-center">
                            <div className="h-12 w-12 bg-muted rounded flex-shrink-0 mr-3">
                              {/* Album artwork would go here */}
                            </div>
                            <div className="text-left">
                              <h3 className="font-medium">{album.name}</h3>
                              <p className="text-sm text-muted-foreground">
                                {releaseYear} • {albumTracks.length} tracks
                              </p>
                            </div>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent className="px-4 pb-4">
                          {isLoadingTracks ? (
                            <div className="space-y-2 pt-2">
                              {Array(5).fill(0).map((_, i) => (
                                <Skeleton key={i} className="h-8 w-full" />
                              ))}
                            </div>
                          ) : (
                            <div className="space-y-2 pt-2">
                              <ul>
                                {albumTracks.map((track: Tracks) => (
                                  <li key={track.id} className="py-2 flex justify-between border-b last:border-b-0">
                                    <div>
                                      <p>{track.name}</p>
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </AccordionContent>
                      </AccordionItem>
                    );
                  })}
                </Accordion>
              )}
            </TabsContent>
          </Tabs>
        </section>
      )}
    </div>
  );
}

function ArtistHeaderSkeleton() {
  return (
    <div className="flex flex-col md:flex-row items-center md:items-center gap-6">
      <Skeleton className="h-24 w-24 rounded-full" />
      
      <div className="flex-1 text-center md:text-left">
        <Skeleton className="h-8 w-48 mx-auto md:mx-0" />
        
        <div className="flex gap-4 mt-4 justify-center md:justify-start">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      
      <Skeleton className="h-24 w-32" />
    </div>
  );
}

function formatNumber(num: number) {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1) + 'M';
  } else if (num >= 1_000) {
    return (num / 1_000).toFixed(1) + 'K';
  }
  return num.toString();
}
