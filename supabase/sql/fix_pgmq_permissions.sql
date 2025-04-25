
-- Grant permissions to interact with pgmq schema
GRANT USAGE ON SCHEMA pgmq TO anon;
GRANT USAGE ON SCHEMA pgmq TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgmq TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgmq TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO service_role;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA pgmq TO service_role;

-- Allow anon role to execute specific functions (used by Edge Functions)
GRANT EXECUTE ON FUNCTION pgmq.send(text, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION pgmq.read(text, integer, integer) TO anon;
GRANT EXECUTE ON FUNCTION pgmq.read_with_options(text, integer, integer, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION pgmq.archive(text, bigint) TO anon;
GRANT EXECUTE ON FUNCTION pgmq.create(text) TO anon;
GRANT EXECUTE ON FUNCTION pgmq.list_queues() TO anon;
GRANT EXECUTE ON FUNCTION pgmq.get_queue(text) TO anon;
GRANT EXECUTE ON FUNCTION pgmq.get_queues() TO anon;
GRANT SELECT ON pgmq.pgmq_state TO anon;
GRANT SELECT ON pgmq.messages TO anon;

-- Create or replace the pgmq_read function with correct parameter names
CREATE OR REPLACE FUNCTION public.pgmq_read(queue_name text, visibility_timeout integer, batch_size integer)
 RETURNS TABLE(msg_id bigint, read_ct integer, enqueued_at timestamp with time zone, vt timestamp with time zone, message jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message 
  FROM pgmq.read(queue_name, visibility_timeout, batch_size) m;
END;
$function$;

-- Create queues if they don't already exist
DO $$
BEGIN
  PERFORM pgmq.create('artist_discovery');
  PERFORM pgmq.create('album_discovery');
  PERFORM pgmq.create('track_discovery');
  PERFORM pgmq.create('producer_identification');
  PERFORM pgmq.create('social_enrichment');
EXCEPTION
  WHEN duplicate_table THEN
    RAISE NOTICE 'Queues already exist';
END;
$$;
