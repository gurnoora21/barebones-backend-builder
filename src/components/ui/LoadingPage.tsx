
import { Skeleton } from '@/components/ui/skeleton';

export default function LoadingPage() {
  return (
    <div className="container mx-auto px-4 py-8">
      <div className="space-y-12">
        <div className="text-center">
          <Skeleton className="h-12 w-3/4 mx-auto mb-4" />
          <Skeleton className="h-6 w-2/4 mx-auto" />
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {Array(3).fill(0).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
        
        <div>
          <Skeleton className="h-8 w-48 mb-6" />
          <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array(8).fill(0).map((_, i) => (
              <div key={i} className="space-y-3">
                <Skeleton className="h-48 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-3 w-3/6" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
