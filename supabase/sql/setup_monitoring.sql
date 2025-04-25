
-- Create worker_issues table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.worker_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_name TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Grant access to anonymous users for monitoring views
GRANT SELECT ON public.queue_stats TO anon;
GRANT SELECT ON public.dead_letter_analysis TO anon;
GRANT SELECT ON public.queue_metrics TO anon;
GRANT SELECT ON public.pgmq_dead_letter_items TO anon;
GRANT SELECT ON public.worker_issues TO anon;

-- Set up RLS policies to allow reading but not writing
ALTER TABLE public.queue_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dead_letter_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pgmq_dead_letter_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_issues ENABLE ROW LEVEL SECURITY;

-- Create RLS policies to allow all users to read monitoring data
CREATE POLICY "Allow reading queue_stats" ON public.queue_stats
  FOR SELECT USING (true);
  
CREATE POLICY "Allow reading dead_letter_analysis" ON public.dead_letter_analysis
  FOR SELECT USING (true);

CREATE POLICY "Allow reading queue_metrics" ON public.queue_metrics
  FOR SELECT USING (true);

CREATE POLICY "Allow reading pgmq_dead_letter_items" ON public.pgmq_dead_letter_items
  FOR SELECT USING (true);

CREATE POLICY "Allow reading worker_issues" ON public.worker_issues
  FOR SELECT USING (true);

-- Grant RLS bypass permissions to service_role for all operations
ALTER TABLE public.artists SECURITY INVOKER;
ALTER TABLE public.albums SECURITY INVOKER;
ALTER TABLE public.tracks SECURITY INVOKER;
ALTER TABLE public.normalized_tracks SECURITY INVOKER;
ALTER TABLE public.producers SECURITY INVOKER;
ALTER TABLE public.track_producers SECURITY INVOKER;

-- Fix for the dead_letter_analysis and queue_stats views
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

CREATE OR REPLACE VIEW public.queue_stats AS
SELECT 
  queue_name,
  date_trunc('hour', processed_at) as hour,
  COUNT(*) as messages_processed,
  COUNT(*) FILTER (WHERE status = 'success') as success_count,
  COUNT(*) FILTER (WHERE status = 'error') as error_count,
  AVG((details->>'processing_time_ms')::numeric) FILTER (WHERE status = 'success') as avg_processing_ms,
  MAX((details->>'processing_time_ms')::numeric) FILTER (WHERE status = 'success') as max_processing_ms
FROM 
  queue_metrics
GROUP BY 
  queue_name, hour
ORDER BY 
  hour DESC, queue_name;
