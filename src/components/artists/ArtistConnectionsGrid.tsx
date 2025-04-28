
import { Link } from 'react-router-dom';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { UserAvatar } from '@/components/common/UserAvatar';

interface Artist {
  id: string;
  name: string;
  trackCount?: number;
  metadata?: any;
}

interface ArtistConnectionsGridProps {
  artists: Artist[];
  isLoading?: boolean;
}

export function ArtistConnectionsGrid({ artists, isLoading = false }: ArtistConnectionsGridProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {Array(10).fill(0).map((_, i) => (
          <Card key={i} className="h-full">
            <div className="pt-[100%] relative bg-muted animate-pulse"></div>
            <CardContent className="pt-4">
              <div className="h-5 bg-muted animate-pulse rounded"></div>
            </CardContent>
            <CardFooter className="pt-0">
              <div className="h-4 w-24 bg-muted animate-pulse rounded"></div>
            </CardFooter>
          </Card>
        ))}
      </div>
    );
  }
  
  if (!artists.length) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No artist connections found</p>
      </div>
    );
  }
  
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
      {artists.map((artist) => (
        <Link to={`/artist/${artist.id}`} key={artist.id}>
          <Card className="h-full hover:shadow-md transition-shadow">
            <div className="pt-[100%] relative">
              <div className="absolute inset-0 flex items-center justify-center bg-muted">
                <UserAvatar 
                  name={artist.name} 
                  imageUrl={artist.metadata?.image_url}
                  className="w-full h-full object-cover"
                />
              </div>
            </div>
            <CardContent className="pt-4">
              <h3 className="font-medium truncate">{artist.name}</h3>
            </CardContent>
            <CardFooter className="pt-0">
              <p className="text-sm text-muted-foreground">
                {artist.trackCount === 1 
                  ? '1 track' 
                  : `${artist.trackCount} tracks`}
              </p>
            </CardFooter>
          </Card>
        </Link>
      ))}
    </div>
  );
}
