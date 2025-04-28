
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { PostgrestError } from "@supabase/supabase-js";

// Define specific types for our data models
export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];
export type Artists = Tables<'artists'>;
export type Albums = Tables<'albums'>;
export type Tracks = Tables<'tracks'>;
export type Producers = Tables<'producers'>;
export type TrackProducers = Tables<'track_producers'>;

// Define return types for our queries
export type QueryResult<T> = {
  data: T | null;
  error: PostgrestError | null;
};

export type QueryListResult<T> = {
  data: T[] | null;
  error: PostgrestError | null;
};

// Generic fetch function for single items
export async function fetchOne<T>(
  table: keyof Database['public']['Tables'],
  id: string
): Promise<QueryResult<T>> {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('id', id)
    .single();

  return { data: data as T, error };
}

// Generic fetch function for lists
export async function fetchList<T>(
  table: keyof Database['public']['Tables'],
  options?: {
    page?: number;
    pageSize?: number;
    filters?: Record<string, any>;
    orderBy?: { column: string; ascending?: boolean };
  }
): Promise<QueryListResult<T>> {
  const { page = 1, pageSize = 20, filters, orderBy } = options || {};
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;

  let query = supabase.from(table).select('*');

  // Apply filters
  if (filters) {
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        query = query.eq(key, value);
      }
    });
  }

  // Apply ordering
  if (orderBy) {
    query = query.order(orderBy.column, { 
      ascending: orderBy.ascending ?? false 
    });
  }

  // Apply pagination
  query = query.range(start, end);

  const { data, error } = await query;
  return { data: data as T[], error };
}

// Search across tables
export async function searchAcross(
  query: string,
  options?: {
    tables?: string[];
    limit?: number;
  }
): Promise<Record<string, any[]>> {
  const { tables = ['artists', 'producers'], limit = 5 } = options || {};
  const results: Record<string, any[]> = {};

  // Execute searches in parallel
  const promises = tables.map(async (table) => {
    const { data, error } = await supabase
      .from(table as keyof Database['public']['Tables'])
      .select('*')
      .ilike('name', `%${query}%`)
      .limit(limit);

    if (!error && data) {
      results[table] = data;
    } else {
      results[table] = [];
    }
  });
  
  await Promise.all(promises);

  return results;
}

// Producer-specific functions
export async function fetchProducer(id: string): Promise<QueryResult<Producers>> {
  return fetchOne<Producers>('producers', id);
}

export async function fetchProducerTracks(
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
): Promise<QueryListResult<any>> {
  const { page = 1, pageSize = 25, orderBy, filters } = options || {};
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;

  let query = supabase
    .from('track_producers')
    .select(`
      *,
      tracks:track_id (
        *,
        albums:album_id (
          *,
          artists:artist_id (*)
        )
      )
    `)
    .eq('producer_id', producerId);

  // Apply filters
  if (filters) {
    if (filters.year) {
      // Filter by release year - requires a join to tracks and albums
      query = query.gte('tracks.albums.release_date', `${filters.year}-01-01`)
        .lt('tracks.albums.release_date', `${filters.year + 1}-01-01`);
    }

    if (filters.artistId) {
      query = query.eq('tracks.albums.artist_id', filters.artistId);
    }

    if (filters.albumId) {
      query = query.eq('tracks.album_id', filters.albumId);
    }
  }

  // Apply ordering
  if (orderBy) {
    if (orderBy.column.includes('.')) {
      // Handle ordering on nested fields
      const [table, column] = orderBy.column.split('.');
      query = query.order(`${table}:${column}`, { 
        ascending: orderBy.ascending ?? false,
        foreignTable: table
      });
    } else {
      query = query.order(orderBy.column, { 
        ascending: orderBy.ascending ?? false 
      });
    }
  } else {
    // Default order by release date
    query = query.order('tracks.albums.release_date', { 
      ascending: false,
      foreignTable: 'tracks.albums'
    });
  }

  // Apply pagination
  query = query.range(start, end);

  const { data, error } = await query;
  return { data, error };
}

// Artist-specific functions
export async function fetchArtist(id: string): Promise<QueryResult<Artists>> {
  return fetchOne<Artists>('artists', id);
}

export async function fetchArtistProducers(
  artistId: string,
  options?: {
    page?: number;
    pageSize?: number;
  }
): Promise<QueryListResult<any>> {
  const { page = 1, pageSize = 20 } = options || {};
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;

  const { data, error } = await supabase
    .from('albums')
    .select(`
      tracks:id (
        track_producers:id (
          *,
          producers:producer_id (*)
        )
      )
    `)
    .eq('artist_id', artistId)
    .range(start, end);
  
  // Process data to extract producers with track counts
  const producerMap = new Map();
  
  if (data) {
    data.forEach((album: any) => {
      if (album.tracks) {
        album.tracks.forEach((track: any) => {
          if (track.track_producers) {
            track.track_producers.forEach((tp: any) => {
              if (tp.producers) {
                const producer = tp.producers;
                if (producerMap.has(producer.id)) {
                  producerMap.get(producer.id).trackCount += 1;
                } else {
                  producerMap.set(producer.id, {
                    ...producer,
                    trackCount: 1
                  });
                }
              }
            });
          }
        });
      }
    });
  }

  return { 
    data: Array.from(producerMap.values()).sort((a, b) => b.trackCount - a.trackCount),
    error 
  };
}

// Stats functions
export async function fetchDatabaseStats(): Promise<{
  producers: number;
  artists: number;
  tracks: number;
}> {
  const [producersRes, artistsRes, tracksRes] = await Promise.all([
    supabase.from('producers').select('id', { count: 'exact', head: true }),
    supabase.from('artists').select('id', { count: 'exact', head: true }),
    supabase.from('tracks').select('id', { count: 'exact', head: true })
  ]);

  return {
    producers: producersRes.count || 0,
    artists: artistsRes.count || 0,
    tracks: tracksRes.count || 0
  };
}

export async function searchByName(
  query: string,
  options?: {
    type?: 'artists' | 'producers' | 'tracks';
    limit?: number;
  }
): Promise<QueryListResult<any>> {
  const { type = 'producers', limit = 10 } = options || {};
  
  const { data, error } = await supabase
    .from(type)
    .select('*')
    .ilike('name', `%${query}%`)
    .limit(limit);

  return { data, error };
}
