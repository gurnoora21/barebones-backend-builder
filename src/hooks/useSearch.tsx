
import { useQuery } from '@tanstack/react-query';
import { searchByName, searchAcross } from '@/lib/supabase';
import { useState, useCallback } from 'react';
import { useDebounce } from '@/hooks/useDebounce';

export function useSearch(
  initialQuery: string = '',
  options?: {
    type?: 'artists' | 'producers' | 'tracks';
    debounceMs?: number;
    limit?: number;
  }
) {
  const { type, debounceMs = 300, limit = 10 } = options || {};
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const debouncedQuery = useDebounce(searchQuery, debounceMs);
  
  const { data, isLoading, error } = useQuery({
    queryKey: ['search', debouncedQuery, type, limit],
    queryFn: () => searchByName(debouncedQuery, { type, limit }),
    enabled: debouncedQuery.length > 1,
  });
  
  return {
    searchQuery,
    setSearchQuery,
    data,
    isLoading,
    error,
  };
}

export function useTypeaheadSearch(
  options?: {
    debounceMs?: number;
    limit?: number;
  }
) {
  const { debounceMs = 300, limit = 5 } = options || {};
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedQuery = useDebounce(searchQuery, debounceMs);
  
  const { data, isLoading, error } = useQuery({
    queryKey: ['typeahead', debouncedQuery, limit],
    queryFn: () => searchAcross(debouncedQuery, { limit }),
    enabled: debouncedQuery.length > 1,
  });
  
  // Save recent searches to localStorage
  const saveRecentSearch = useCallback((query: string) => {
    if (!query.trim()) return;
    
    try {
      const recentSearches = JSON.parse(localStorage.getItem('recentSearches') || '[]');
      const newSearches = [
        query,
        ...recentSearches.filter((q: string) => q !== query)
      ].slice(0, 5);
      
      localStorage.setItem('recentSearches', JSON.stringify(newSearches));
    } catch (e) {
      console.error('Failed to save recent search', e);
    }
  }, []);
  
  // Get recent searches from localStorage
  const getRecentSearches = useCallback(() => {
    try {
      return JSON.parse(localStorage.getItem('recentSearches') || '[]');
    } catch (e) {
      console.error('Failed to get recent searches', e);
      return [];
    }
  }, []);
  
  return {
    searchQuery,
    setSearchQuery,
    data,
    isLoading,
    error,
    saveRecentSearch,
    getRecentSearches,
  };
}
