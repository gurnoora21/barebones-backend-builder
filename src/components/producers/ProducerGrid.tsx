
import { Link } from 'react-router-dom';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useEffect } from 'react';

interface Producer {
  id: string;
  name: string;
  instagram_handle?: string | null;
  metadata?: any;
  image_url?: string | null;
  trackCount?: number;
  popularity?: number;
}

interface ProducerGridProps {
  producers: Producer[];
  isLoading?: boolean;
}

export function ProducerGrid({ producers, isLoading = false }: ProducerGridProps) {
  // Debug producers
  useEffect(() => {
    console.log('ProducerGrid received producers:', producers);
    if (producers.length > 0) {
      console.log('Sample producer:', producers[0]);
    }
  }, [producers]);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array(12).fill(0).map((_, i) => (
          <ProducerCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  
  if (!producers || !producers.length) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">No producers found</p>
      </div>
    );
  }
  
  return (
    <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {producers.map((producer) => (
        <ProducerCard key={producer.id} producer={producer} />
      ))}
    </div>
  );
}

function ProducerCard({ producer }: { producer: Producer }) {
  const { id, name, instagram_handle } = producer;
  
  // Use direct image_url if available, fall back to metadata
  const imageUrl = producer.image_url || producer.metadata?.image_url || null;
  
  // Debug individual producer
  useEffect(() => {
    console.log('Rendering producer card:', { id, name, imageUrl, instagram_handle });
  }, [id, name, imageUrl, instagram_handle]);
  
  return (
    <Link to={`/producer/${id}`}>
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
          <h3 className="font-semibold truncate">{name || 'Unknown Producer'}</h3>
          {instagram_handle && (
            <p className="text-sm text-muted-foreground truncate">
              @{instagram_handle}
            </p>
          )}
          {producer.trackCount !== undefined && (
            <p className="text-xs text-muted-foreground mt-1">
              {producer.trackCount} tracks produced
            </p>
          )}
        </CardContent>
        <CardFooter className="pt-0 text-sm text-muted-foreground">
          {producer.metadata?.genres?.length ? (
            <span>{producer.metadata.genres.slice(0, 3).join(', ')}</span>
          ) : instagram_handle ? (
            <span>@{instagram_handle}</span>
          ) : (
            <span>Producer</span>
          )}
        </CardFooter>
      </Card>
    </Link>
  );
}

function ProducerCardSkeleton() {
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
