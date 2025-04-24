
-- Table to log maintenance runs
CREATE TABLE IF NOT EXISTS public.maintenance_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT now(),
  results JSONB
);

-- Function to get stalled messages (messages whose VT has expired)
CREATE OR REPLACE FUNCTION pgmq_get_stalled_messages(max_stalled_minutes INTEGER DEFAULT 30)
RETURNS TABLE (
  queue_name TEXT,
  msg_id BIGINT,
  read_ct INTEGER,
  enqueued_at TIMESTAMP WITH TIME ZONE,
  vt TIMESTAMP WITH TIME ZONE,
  stalled_minutes NUMERIC
)
LANGUAGE SQL
AS $$
  SELECT 
    t.queue_name,
    t.msg_id,
    t.read_ct,
    t.enqueued_at,
    t.vt,
    EXTRACT(EPOCH FROM (now() - t.vt)) / 60 AS stalled_minutes
  FROM 
    pgmq.get_queues() q
  CROSS JOIN LATERAL (
    SELECT *
    FROM pgmq.get_queue(q.name)
    WHERE vt < now() - (max_stalled_minutes || ' minutes')::INTERVAL
    AND read_ct > 0
  ) t;
$$;

-- Function to archive a message by ID
CREATE OR REPLACE FUNCTION public.pgmq_archive(queue_name text, msg_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  success BOOLEAN;
BEGIN
  SELECT pgmq.archive(queue_name, msg_id) INTO success;
  RETURN success;
END;
$function$;

-- Update the queue_metrics view to be more useful
CREATE OR REPLACE VIEW queue_stats AS
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

-- Set up a view for common dead letter patterns
CREATE OR REPLACE VIEW dead_letter_analysis AS
SELECT 
  queue_name,
  details->>'category' AS error_category,
  COUNT(*) AS error_count,
  MAX(failed_at) AS last_occurrence,
  MIN(failed_at) AS first_occurrence
FROM 
  pgmq_dead_letter_items
GROUP BY 
  queue_name, error_category
ORDER BY 
  error_count DESC;
