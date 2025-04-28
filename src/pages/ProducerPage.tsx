
import { useParams } from 'react-router-dom';
import { useProducer, useProducerTracks } from '@/hooks/useProducer';
import { useState } from 'react';
import { UserAvatar } from '@/components/common/UserAvatar';
import { ExternalLink, Mail, Instagram } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TrackTable } from '@/components/tracks/TrackTable';
import { ArtistConnectionsGrid } from '@/components/artists/ArtistConnectionsGrid';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';

export default function ProducerPage() {
  const { id } = useParams<{ id: string }>();
  const [currentTab, setCurrentTab] = useState('tracks');
  const [page, setPage] = useState(1);
  const pageSize = 25;
  
  const [trackFilters, setTrackFilters] = useState<{
    year?: number;
    artistId?: string;
    albumId?: string;
  }>({});
  
  const [trackOrderBy, setTrackOrderBy] = useState<{ 
    column: string; 
    ascending: boolean 
  }>({ 
    column: 'tracks.albums.release_date',
    ascending: false
  });
  
  const { data: producerData, isLoading: isLoadingProducer, error: producerError } = useProducer(id || '');
  
  const { 
    data: tracksData,
    isLoading: isLoadingTracks,
    error: tracksError
  } = useProducerTracks(id || '', {
    page,
    pageSize,
    orderBy: trackOrderBy,
    filters: trackFilters,
  });
  
  const producer = producerData?.data;
  const tracks = tracksData?.data || [];
  
  // Extract unique artists from tracks
  const artistsMap = new Map();
  tracks.forEach((trackProducer: any) => {
    const track = trackProducer.tracks;
    if (track?.albums?.artists) {
      const artist = track.albums.artists;
      if (!artistsMap.has(artist.id)) {
        artistsMap.set(artist.id, {
          ...artist,
          trackCount: 1
        });
      } else {
        artistsMap.get(artist.id).trackCount += 1;
      }
    }
  });
  
  const artists = Array.from(artistsMap.values())
    .sort((a, b) => b.trackCount - a.trackCount);
  
  if (producerError) {
    return (
      <div className="text-center py-12">
        <h2 className="text-2xl font-bold">Error Loading Producer</h2>
        <p className="text-muted-foreground mt-2">
          {(producerError as any).message || 'Failed to load producer details'}
        </p>
      </div>
    );
  }
  
  return (
    <div className="space-y-8 pb-8">
      {/* Producer Header */}
      <section>
        {isLoadingProducer ? (
          <ProducerHeaderSkeleton />
        ) : producer ? (
          <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
            <UserAvatar 
              name={producer.name} 
              imageUrl={producer.metadata && typeof producer.metadata === 'object' ? (producer.metadata as any).image_url : undefined} 
              size="lg"
              className="h-24 w-24"
            />
            
            <div className="flex-1">
              <h1 className="text-3xl font-bold">{producer.name}</h1>
              {producer.instagram_handle && (
                <p className="text-muted-foreground">@{producer.instagram_handle}</p>
              )}
              
              <div className="flex gap-3 mt-4">
                {producer.instagram_handle && (
                  <Button variant="outline" size="sm" asChild>
                    <a 
                      href={`https://instagram.com/${producer.instagram_handle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Instagram className="h-4 w-4 mr-2" /> Instagram
                    </a>
                  </Button>
                )}
                
                {producer.email && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={`mailto:${producer.email}`}>
                      <Mail className="h-4 w-4 mr-2" /> Contact
                    </a>
                  </Button>
                )}
              </div>
            </div>
            
            <Card className="w-full md:w-auto">
              <CardContent className="p-4 flex flex-row md:flex-col gap-4">
                <div className="text-center flex-1">
                  <p className="text-sm text-muted-foreground">Tracks</p>
                  <p className="text-2xl font-bold">{tracks.length}</p>
                </div>
                <Separator orientation="vertical" className="hidden md:block h-auto" />
                <Separator className="md:hidden" />
                <div className="text-center flex-1">
                  <p className="text-sm text-muted-foreground">Artists</p>
                  <p className="text-2xl font-bold">{artists.length}</p>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="text-center py-12">
            <h2 className="text-2xl font-bold">Producer Not Found</h2>
          </div>
        )}
      </section>
      
      {/* Tab Navigation */}
      {producer && (
        <section>
          <Tabs value={currentTab} onValueChange={setCurrentTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="tracks">Tracks</TabsTrigger>
              <TabsTrigger value="artists">Artists Worked With</TabsTrigger>
            </TabsList>
            
            <TabsContent value="tracks" className="mt-6">
              <TrackTable 
                tracks={tracks}
                isLoading={isLoadingTracks}
                error={tracksError}
                page={page}
                setPage={setPage}
                pageSize={pageSize}
                orderBy={trackOrderBy}
                setOrderBy={setTrackOrderBy}
                filters={trackFilters}
                setFilters={setTrackFilters}
              />
            </TabsContent>
            
            <TabsContent value="artists" className="mt-6">
              <ArtistConnectionsGrid artists={artists} />
            </TabsContent>
          </Tabs>
        </section>
      )}
    </div>
  );
}

function ProducerHeaderSkeleton() {
  return (
    <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
      <Skeleton className="h-24 w-24 rounded-full" />
      
      <div className="flex-1">
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-32" />
        
        <div className="flex gap-3 mt-4">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      
      <Skeleton className="w-full md:w-[180px] h-[100px]" />
    </div>
  );
}
