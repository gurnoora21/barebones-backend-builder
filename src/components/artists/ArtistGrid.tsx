
import { useQuery } from '@tanstack/react-query';
import { fetchList } from '@/lib/supabase';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface Artist {
  id: string;
  name: string;
  followers?: number | null;
  popularity?: number | null;
  metadata?: any;
}

export function ArtistGrid() {
  const [page, setPage] = useState(1);
  const pageSize = 8;
  
  const { data, isLoading } = useQuery({
    queryKey: ['popularArtists', page, pageSize],
    queryFn: () => fetchList<Artist>('artists', {
      page,
      pageSize,
      orderBy: { column: 'followers', ascending: false },
    }),
    placeholderData: (previousData) => previousData,
  });
  
  const artists = data?.data || [];
  
  if (isLoading) {
    return (
      <div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array(pageSize).fill(0).map((_, i) => (
            <ArtistCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }
  
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {artists.map((artist) => (
          <ArtistCard key={artist.id} artist={artist} />
        ))}
      </div>
      
      {artists.length > 0 && (
        <div className="flex justify-center mt-6">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="mr-2"
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => p + 1)}
            disabled={artists.length < pageSize}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function ArtistCard({ artist }: { artist: Artist }) {
  const { id, name, followers, popularity } = artist;
  
  // Extract image from metadata if available
  const imageUrl = artist.metadata?.image_url || null;
  
  return (
    <Link to={`/artist/${id}`}>
      <Card className="h-full hover:shadow-md transition-shadow overflow-hidden group">
        <div className="relative pt-[100%]">
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <UserAvatar 
              name={name} 
              imageUrl={imageUrl} 
              className="w-full h-full object-cover transition-transform group-hover:scale-105" 
            />
          </div>
        </div>
        <CardContent className="pt-4">
          <h3 className="font-semibold truncate">{name}</h3>
        </CardContent>
        <CardFooter className="pt-0 text-sm text-muted-foreground">
          {followers ? `${formatNumber(followers)} followers` : popularity ? `${popularity}% popularity` : ''}
        </CardFooter>
      </Card>
    </Link>
  );
}

function ArtistCardSkeleton() {
  return (
    <Card className="h-full overflow-hidden">
      <div className="pt-[100%] relative">
        <Skeleton className="absolute inset-0" />
      </div>
      <CardContent className="pt-4">
        <Skeleton className="h-6 w-full mb-2" />
        <Skeleton className="h-4 w-2/3" />
      </CardContent>
    </Card>
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
