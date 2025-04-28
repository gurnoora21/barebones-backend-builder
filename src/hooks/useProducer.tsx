
import { useQuery } from '@tanstack/react-query';
import { fetchProducer, fetchProducerTracks, QueryResult, Producers } from '@/lib/supabase';

export function useProducer(id: string) {
  return useQuery({
    queryKey: ['producer', id],
    queryFn: () => fetchProducer(id),
    enabled: !!id,
  });
}

export function useProducerTracks(
  producerId: string,
  options?: {
    page?: number;
    pageSize?: number;
    orderBy?: { column: string; ascending?: boolean };
    filters?: {
      year?: number;
      artistId?: string;
      albumId?: string;
    };
  }
) {
  const { page = 1, pageSize = 25, orderBy, filters } = options || {};
  
  return useQuery({
    queryKey: ['producerTracks', producerId, page, pageSize, orderBy, filters],
    queryFn: () => fetchProducerTracks(producerId, { page, pageSize, orderBy, filters }),
    enabled: !!producerId,
    placeholderData: (previousData) => previousData,
  });
}
