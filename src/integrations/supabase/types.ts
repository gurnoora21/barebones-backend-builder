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
    }
    Views: {
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
      queue_stats: {
        Row: {
          error_count: number | null
          hour: string | null
          messages_processed: number | null
          queue_name: string | null
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
      pgmq_read: {
        Args: { queue_name: string; vt: number; qty: number }
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
