
export interface Database {
  public: {
    Tables: {
      pgmq_dead_letter_items: {
        Row: {
          id: number;
          queue_name: string;
          msg: any;
          failed_at: string;
          fail_count: number;
          details: any | null;
        };
        Insert: {
          id?: number;
          queue_name: string;
          msg: any;
          failed_at?: string;
          fail_count: number;
          details?: any | null;
        };
      };
      queue_metrics: {
        Row: {
          id: string;
          queue_name: string;
          msg_id: number;
          status: string;
          processed_at: string;
          details: any | null;
        };
        Insert: {
          id?: string;
          queue_name: string;
          msg_id: number;
          status: string;
          processed_at?: string;
          details?: any | null;
        };
      };
      rate_limits: {
        Row: {
          key: string;
          count: number;
          window_end: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          key: string;
          count: number;
          window_end: number;
          created_at?: string;
          updated_at?: string;
        };
      };
      maintenance_logs: {
        Row: {
          id: string;
          timestamp: string;
          results: any;
        };
        Insert: {
          id?: string;
          timestamp?: string;
          results: any;
        };
      };
      producers: {
        Row: {
          id: string;
          name: string;
          normalized_name: string;
          metadata: any | null;
          created_at: string | null;
          updated_at: string | null;
          enriched_at: string | null;
          enrichment_failed: boolean | null;
          instagram_handle: string | null;
          instagram_bio: string | null;
          email: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          normalized_name: string;
          metadata?: any | null;
          created_at?: string | null;
          updated_at?: string | null;
          enriched_at?: string | null;
          enrichment_failed?: boolean | null;
          instagram_handle?: string | null;
          instagram_bio?: string | null;
          email?: string | null;
        };
      };
    };
    Functions: {
      pgmq_read: {
        Args: {
          queue_name: string;
          vt: number;
          qty: number;
        };
        Returns: {
          msg_id: number;
          read_ct: number;
          enqueued_at: string;
          vt: string;
          message: any;
        }[];
      };
      pgmq_send: {
        Args: {
          queue_name: string;
          msg: any;
        };
        Returns: number;
      };
      pgmq_archive: {
        Args: {
          queue_name: string;
          msg_id: number;
        };
        Returns: boolean;
      };
      pgmq_get_stalled_messages: {
        Args: {
          max_stalled_minutes?: number;
        };
        Returns: {
          queue_name: string;
          msg_id: number;
          read_ct: number;
          enqueued_at: string;
          vt: string;
          stalled_minutes: number;
        }[];
      };
    };
    Views: {
      queue_stats: {
        Row: {
          queue_name: string;
          hour: string;
          messages_processed: number;
          success_count: number;
          error_count: number;
          avg_processing_ms: number;
          max_processing_ms: number;
        };
      };
      dead_letter_details: {
        Row: {
          details: any | null;
          fail_count: number | null;
          failed_at: string | null;
          msg: any | null;
          queue_name: string | null;
        };
      };
      dead_letter_analysis: {
        Row: {
          queue_name: string;
          error_category: string;
          error_count: number;
          last_occurrence: string;
          first_occurrence: string;
        };
      };
    };
  };
}
