
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
    };
  };
}
