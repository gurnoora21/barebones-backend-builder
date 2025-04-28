
import { useQuery } from '@tanstack/react-query';
import { fetchDatabaseStats } from '@/lib/supabase';

export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: fetchDatabaseStats,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
