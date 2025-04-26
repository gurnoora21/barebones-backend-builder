export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      albums: {
        Row: {
          artist_id: string
          created_at: string | null
          id: string
          metadata: Json | null
          name: string
          release_date: string | null
          spotify_id: string | null
          updated_at: string | null
        }
        Insert: {
          artist_id: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          name: string
          release_date?: string | null
          spotify_id?: string | null
          updated_at?: string | null
        }
        Update: {
          artist_id?: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          name?: string
          release_date?: string | null
          spotify_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "albums_artist_id_fkey"
            columns: ["artist_id"]
            isOneToOne: false
            referencedRelation: "artists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_albums_artist"
            columns: ["artist_id"]
            isOneToOne: false
            referencedRelation: "artists"
            referencedColumns: ["id"]
          },
        ]
      }
      artists: {
        Row: {
          created_at: string | null
          genres: string[] | null
          id: string
          market: string | null
          metadata: Json | null
          name: string
          popularity: number | null
          spotify_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          genres?: string[] | null
          id?: string
          market?: string | null
          metadata?: Json | null
          name: string
          popularity?: number | null
          spotify_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          genres?: string[] | null
          id?: string
          market?: string | null
          metadata?: Json | null
          name?: string
          popularity?: number | null
          spotify_id?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      maintenance_logs: {
        Row: {
          id: string
          results: Json | null
          timestamp: string | null
        }
        Insert: {
          id?: string
          results?: Json | null
          timestamp?: string | null
        }
        Update: {
          id?: string
          results?: Json | null
          timestamp?: string | null
        }
        Relationships: []
      }
      normalized_tracks: {
        Row: {
          artist_id: string
          created_at: string | null
          id: string
          normalized_name: string
          representative_track_id: string | null
          updated_at: string | null
        }
        Insert: {
          artist_id: string
          created_at?: string | null
          id?: string
          normalized_name: string
          representative_track_id?: string | null
          updated_at?: string | null
        }
        Update: {
          artist_id?: string
          created_at?: string | null
          id?: string
          normalized_name?: string
          representative_track_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_normalized_tracks_artist"
            columns: ["artist_id"]
            isOneToOne: false
            referencedRelation: "artists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_normalized_tracks_track"
            columns: ["representative_track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "normalized_tracks_artist_id_fkey"
            columns: ["artist_id"]
            isOneToOne: false
            referencedRelation: "artists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "normalized_tracks_representative_track_id_fkey"
            columns: ["representative_track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      pgmq_dead_letter_items: {
        Row: {
          details: Json | null
          fail_count: number
          failed_at: string
          id: number
          msg: Json
          queue_name: string
        }
        Insert: {
          details?: Json | null
          fail_count: number
          failed_at?: string
          id?: number
          msg: Json
          queue_name: string
        }
        Update: {
          details?: Json | null
          fail_count?: number
          failed_at?: string
          id?: number
          msg?: Json
          queue_name?: string
        }
        Relationships: []
      }
      producers: {
        Row: {
          created_at: string | null
          id: string
          metadata: Json | null
          name: string
          normalized_name: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          metadata?: Json | null
          name: string
          normalized_name: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          metadata?: Json | null
          name?: string
          normalized_name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      queue_health_logs: {
        Row: {
          checked_at: string | null
          id: string
          results: Json
        }
        Insert: {
          checked_at?: string | null
          id?: string
          results: Json
        }
        Update: {
          checked_at?: string | null
          id?: string
          results?: Json
        }
        Relationships: []
      }
      queue_metrics: {
        Row: {
          details: Json | null
          id: string
          msg_id: number
          processed_at: string
          queue_name: string
          status: string
        }
        Insert: {
          details?: Json | null
          id?: string
          msg_id: number
          processed_at?: string
          queue_name: string
          status: string
        }
        Update: {
          details?: Json | null
          id?: string
          msg_id?: number
          processed_at?: string
          queue_name?: string
          status?: string
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          count: number
          created_at: string | null
          key: string
          updated_at: string | null
          window_end: number
        }
        Insert: {
          count?: number
          created_at?: string | null
          key: string
          updated_at?: string | null
          window_end: number
        }
        Update: {
          count?: number
          created_at?: string | null
          key?: string
          updated_at?: string | null
          window_end?: number
        }
        Relationships: []
      }
      seeding_artists: {
        Row: {
          details: Json | null
          job_id: string
          processed_at: string | null
          spotify_id: string
          success: boolean | null
        }
        Insert: {
          details?: Json | null
          job_id: string
          processed_at?: string | null
          spotify_id: string
          success?: boolean | null
        }
        Update: {
          details?: Json | null
          job_id?: string
          processed_at?: string | null
          spotify_id?: string
          success?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "seeding_artists_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "seeding_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      seeding_jobs: {
        Row: {
          completed_at: string | null
          config: Json
          id: string
          job_type: string
          progress: Json | null
          results: Json | null
          started_at: string | null
          status: string
        }
        Insert: {
          completed_at?: string | null
          config: Json
          id?: string
          job_type: string
          progress?: Json | null
          results?: Json | null
          started_at?: string | null
          status?: string
        }
        Update: {
          completed_at?: string | null
          config?: Json
          id?: string
          job_type?: string
          progress?: Json | null
          results?: Json | null
          started_at?: string | null
          status?: string
        }
        Relationships: []
      }
      traces: {
        Row: {
          attributes: Json | null
          created_at: string
          details: Json | null
          id: string
          operation: string
          parent_id: string | null
          service: string
          span_id: string
          timestamp: string
          trace_id: string
        }
        Insert: {
          attributes?: Json | null
          created_at?: string
          details?: Json | null
          id?: string
          operation: string
          parent_id?: string | null
          service: string
          span_id: string
          timestamp: string
          trace_id: string
        }
        Update: {
          attributes?: Json | null
          created_at?: string
          details?: Json | null
          id?: string
          operation?: string
          parent_id?: string | null
          service?: string
          span_id?: string
          timestamp?: string
          trace_id?: string
        }
        Relationships: []
      }
      track_producers: {
        Row: {
          confidence: number
          created_at: string | null
          id: string
          producer_id: string
          source: string
          track_id: string
        }
        Insert: {
          confidence: number
          created_at?: string | null
          id?: string
          producer_id: string
          source: string
          track_id: string
        }
        Update: {
          confidence?: number
          created_at?: string | null
          id?: string
          producer_id?: string
          source?: string
          track_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_track_producers_producer"
            columns: ["producer_id"]
            isOneToOne: false
            referencedRelation: "producers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_track_producers_track"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "track_producers_producer_id_fkey"
            columns: ["producer_id"]
            isOneToOne: false
            referencedRelation: "producers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "track_producers_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      tracks: {
        Row: {
          album_id: string
          created_at: string | null
          duration_ms: number | null
          id: string
          metadata: Json | null
          name: string
          spotify_id: string | null
          updated_at: string | null
        }
        Insert: {
          album_id: string
          created_at?: string | null
          duration_ms?: number | null
          id?: string
          metadata?: Json | null
          name: string
          spotify_id?: string | null
          updated_at?: string | null
        }
        Update: {
          album_id?: string
          created_at?: string | null
          duration_ms?: number | null
          id?: string
          metadata?: Json | null
          name?: string
          spotify_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_tracks_album"
            columns: ["album_id"]
            isOneToOne: false
            referencedRelation: "albums"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tracks_album_id_fkey"
            columns: ["album_id"]
            isOneToOne: false
            referencedRelation: "albums"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_issues: {
        Row: {
          created_at: string
          details: Json | null
          id: string
          issue_type: string
          worker_name: string
        }
        Insert: {
          created_at?: string
          details?: Json | null
          id?: string
          issue_type: string
          worker_name: string
        }
        Update: {
          created_at?: string
          details?: Json | null
          id?: string
          issue_type?: string
          worker_name?: string
        }
        Relationships: []
      }
    }
    Views: {
      dead_letter_analysis: {
        Row: {
          error_category: string | null
          error_count: number | null
          first_occurrence: string | null
          last_occurrence: string | null
          queue_name: string | null
        }
        Relationships: []
      }
      dead_letter_details: {
        Row: {
          details: Json | null
          fail_count: number | null
          failed_at: string | null
          msg: Json | null
          queue_name: string | null
        }
        Insert: {
          details?: Json | null
          fail_count?: number | null
          failed_at?: string | null
          msg?: Json | null
          queue_name?: string | null
        }
        Update: {
          details?: Json | null
          fail_count?: number | null
          failed_at?: string | null
          msg?: Json | null
          queue_name?: string | null
        }
        Relationships: []
      }
      queue_error_rates: {
        Row: {
          error_count: number | null
          error_rate_percent: number | null
          queue_name: string | null
          time_bucket: string | null
          total_messages: number | null
        }
        Relationships: []
      }
      queue_latency_stats: {
        Row: {
          avg_latency_ms: number | null
          max_latency_ms: number | null
          p95_latency_ms: number | null
          queue_name: string | null
          time_bucket: string | null
        }
        Relationships: []
      }
      queue_stats: {
        Row: {
          avg_processing_ms: number | null
          error_count: number | null
          hour: string | null
          max_processing_ms: number | null
          messages_processed: number | null
          queue_name: string | null
          success_count: number | null
        }
        Relationships: []
      }
      trace_summary: {
        Row: {
          duration: unknown | null
          end_time: string | null
          operations: string[] | null
          services: string[] | null
          span_count: number | null
          start_time: string | null
          trace_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      check_queue_health: {
        Args: Record<PropertyKey, never>
        Returns: {
          queue_name: string
          status: string
          details: Json
        }[]
      }
      get_queue_metrics: {
        Args: Record<PropertyKey, never>
        Returns: {
          queue_name: string
          pending_messages: number
          max_retries: number
          oldest_message_age: unknown
        }[]
      }
      notify_queue_health_issues: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      pgmq_archive: {
        Args: { queue_name: string; msg_id: number }
        Returns: boolean
      }
      pgmq_read: {
        Args: {
          queue_name: string
          visibility_timeout: number
          batch_size: number
        }
        Returns: {
          msg_id: number
          read_ct: number
          enqueued_at: string
          vt: string
          message: Json
        }[]
      }
      pgmq_send: {
        Args: { queue_name: string; msg: Json }
        Returns: number
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DefaultSchema = Database[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof Database },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
