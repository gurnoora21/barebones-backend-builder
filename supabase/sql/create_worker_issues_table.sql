
-- Create a table for tracking worker issues
CREATE TABLE IF NOT EXISTS public.worker_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_name TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Fix permissions issues 
GRANT USAGE ON SCHEMA pgmq TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA pgmq TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgmq TO service_role;

-- Create the view for error analysis if it doesn't exist yet
CREATE OR REPLACE VIEW public.dead_letter_analysis AS
SELECT 
  queue_name,
  COALESCE(details->>'category', 'unknown') AS error_category,
  COUNT(*) AS error_count,
  MAX(failed_at) AS last_occurrence,
  MIN(failed_at) AS first_occurrence
FROM 
  pgmq_dead_letter_items
GROUP BY 
  queue_name, error_category
ORDER BY 
  error_count DESC;

-- Update the queue metrics view to include success/error counts
CREATE OR REPLACE VIEW public.queue_stats AS
SELECT 
  queue_name,
  date_trunc('hour', processed_at) AS hour,
  COUNT(*) AS messages_processed,
  COUNT(*) FILTER (WHERE status = 'success') AS success_count,
  COUNT(*) FILTER (WHERE status = 'error') AS error_count,
  AVG((details->>'processing_time_ms')::numeric) FILTER (WHERE status = 'success') AS avg_processing_ms,
  MAX((details->>'processing_time_ms')::numeric) FILTER (WHERE status = 'success') AS max_processing_ms
FROM 
  queue_metrics
GROUP BY 
  queue_name, hour
ORDER BY 
  hour DESC, queue_name;
