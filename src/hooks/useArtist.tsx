
import { useQuery } from '@tanstack/react-query';
import { fetchArtist, fetchArtistProducers } from '@/lib/supabase';

export function useArtist(id: string) {
  return useQuery({
    queryKey: ['artist', id],
    queryFn: () => fetchArtist(id),
    enabled: !!id,
  });
}

export function useArtistProducers(
  artistId: string,
  options?: {
    page?: number;
    pageSize?: number;
  }
) {
  const { page = 1, pageSize = 20 } = options || {};
  
  return useQuery({
    queryKey: ['artistProducers', artistId, page, pageSize],
    queryFn: () => fetchArtistProducers(artistId, { page, pageSize }),
    enabled: !!artistId,
    keepPreviousData: true,
  });
}
