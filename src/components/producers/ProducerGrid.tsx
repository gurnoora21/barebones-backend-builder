
import { Link } from 'react-router-dom';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/common/UserAvatar';

interface Producer {
  id: string;
  name: string;
  instagram_handle?: string | null;
  metadata?: any;
  trackCount?: number;
}

interface ProducerGridProps {
  producers: Producer[];
  isLoading?: boolean;
}

export function ProducerGrid({ producers, isLoading = false }: ProducerGridProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array(12).fill(0).map((_, i) => (
          <ProducerCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  
  if (!producers.length) {
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
  const { id, name, instagram_handle, trackCount } = producer;
  
  // Extract image from metadata if available
  const imageUrl = producer.metadata?.image_url || null;
  
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
          <h3 className="font-semibold truncate">{name}</h3>
          {instagram_handle && (
            <p className="text-sm text-muted-foreground truncate">
              @{instagram_handle}
            </p>
          )}
        </CardContent>
        {trackCount !== undefined && (
          <CardFooter className="pt-0 text-sm text-muted-foreground">
            {trackCount} tracks produced
          </CardFooter>
        )}
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
