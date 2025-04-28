
// This file contains type definitions for our Supabase client
import { Database } from "@/integrations/supabase/types";

// Define specific types for our data models
export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];
export type Artists = Tables<'artists'>;
export type Albums = Tables<'albums'>;
export type Tracks = Tables<'tracks'>;
export type Producers = Tables<'producers'>;
export type TrackProducers = Tables<'track_producers'>;

// Define return types for our queries
export interface QueryResult<T> {
  data: T | null;
  error: Error | null;
}

export interface QueryListResult<T> {
  data: T[] | null;
  error: Error | null;
}
