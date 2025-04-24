
# Spotify Producer Discovery Pipeline

This project implements a backend data pipeline using Supabase Edge Functions and PGMQ (PostgreSQL Message Queue) to discover music producers and their social profiles based on Spotify data.

## Architecture

The pipeline consists of five worker components that process data in a sequential pipeline:

1. **Artist Discovery**: Takes an artist name or ID, resolves to Spotify artist ID, and enqueues for album discovery
2. **Album Discovery**: Fetches pages of albums (50 at a time) for an artist, enqueuing each album for track discovery
3. **Track Discovery**: Fetches pages of tracks (50 at a time) from albums, enqueuing each track for producer identification
4. **Producer Identification**: Analyzes track collaborators, identifying producers and enqueuing them for social enrichment
5. **Social Enrichment**: Discovers social profiles for each producer and stores the results

## Setup

### 1. Environment Variables

The following environment variables must be set in your Supabase project:

- `SPOTIFY_CLIENT_ID`: Your Spotify developer API client ID
- `SPOTIFY_CLIENT_SECRET`: Your Spotify developer API client secret
- `SUPABASE_URL`: Your Supabase project URL (set automatically)
- `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase service role key (set automatically)

### 2. Database Setup

Run the following SQL commands to set up the necessary database objects:

```sql
-- Create PostgreSQL Message Queue (PGMQ) queues
SELECT pgmq.create('artist_discovery');
SELECT pgmq.create('album_discovery');
SELECT pgmq.create('track_discovery');
SELECT pgmq.create('producer_identification');
SELECT pgmq.create('social_enrichment');

-- Create metrics and dead letter tables
CREATE TABLE IF NOT EXISTS public.queue_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name TEXT NOT NULL,
  msg_id BIGINT NOT NULL,
  status TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB
);

CREATE TABLE IF NOT EXISTS public.pgmq_dead_letter_items (
  id BIGSERIAL PRIMARY KEY,
  queue_name TEXT NOT NULL,
  msg JSONB NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fail_count INTEGER NOT NULL,
  details JSONB
);

-- Create RPC for pgmq_send
CREATE OR REPLACE FUNCTION public.pgmq_send(
  queue_name text, 
  msg jsonb
) RETURNS bigint AS $$
DECLARE
  res bigint;
BEGIN
  SELECT pgmq.send(queue_name, msg) INTO res;
  RETURN res;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create RPC for pgmq_read
CREATE OR REPLACE FUNCTION public.pgmq_read(
  queue_name text, 
  vt integer, 
  qty integer
) RETURNS TABLE(
  msg_id bigint, 
  read_ct integer, 
  enqueued_at timestamptz, 
  vt timestamptz, 
  message jsonb
) AS $$
BEGIN
  RETURN QUERY SELECT m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message 
  FROM pgmq.read(queue_name, vt, qty) m;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create RPC for pgmq_archive
CREATE OR REPLACE FUNCTION public.pgmq_archive(
  queue_name text, 
  msg_id bigint
) RETURNS boolean AS $$
DECLARE
  res boolean;
BEGIN
  SELECT pgmq.archive(queue_name, msg_id) INTO res;
  RETURN res;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create views for monitoring
CREATE OR REPLACE VIEW public.queue_stats AS
SELECT 
  queue_name,
  date_trunc('hour', processed_at) as hour,
  count(*) as messages_processed,
  count(*) FILTER (WHERE status = 'error') as error_count
FROM 
  public.queue_metrics
GROUP BY 
  queue_name, hour
ORDER BY 
  hour DESC, queue_name;

CREATE OR REPLACE VIEW public.dead_letter_details AS
SELECT 
  queue_name, 
  msg, 
  failed_at, 
  fail_count, 
  details 
FROM 
  public.pgmq_dead_letter_items 
ORDER BY 
  failed_at DESC;
```

### 3. Setup Scheduled Jobs

Run the following SQL to schedule your worker functions:

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Schedule worker functions to run every 2 minutes
SELECT cron.schedule(
  'artist-discovery-worker',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url:='https://nsxxzhhbcwzatvlulfyp.functions.supabase.co/artistDiscovery',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body:='{}'::jsonb
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'album-discovery-worker',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url:='https://nsxxzhhbcwzatvlulfyp.functions.supabase.co/albumDiscovery',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body:='{}'::jsonb
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'track-discovery-worker',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url:='https://nsxxzhhbcwzatvlulfyp.functions.supabase.co/trackDiscovery',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body:='{}'::jsonb
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'producer-identification-worker',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url:='https://nsxxzhhbcwzatvlulfyp.functions.supabase.co/producerIdentification',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body:='{}'::jsonb
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'social-enrichment-worker',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url:='https://nsxxzhhbcwzatvlulfyp.functions.supabase.co/socialEnrichment',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body:='{}'::jsonb
  ) AS request_id;
  $$
);

-- Schedule stalled message recovery job every 15 minutes
SELECT cron.schedule(
  'stalled-message-recovery',
  '*/15 * * * *',
  $$
  DO $$
  DECLARE
    queue_rec record;
    cutoff timestamptz := now() - interval '10 minutes';
  BEGIN
    FOR queue_rec IN 
      SELECT DISTINCT queue_name FROM pgmq.messages WHERE vt < cutoff AND archived = false
    LOOP
      PERFORM pgmq.clear_visibility(queue_rec.queue_name);
      RAISE NOTICE 'Cleared visibility timeouts for queue %', queue_rec.queue_name;
    END LOOP;
  END $$;
  $$
);
```

Replace `YOUR_SERVICE_ROLE_KEY` with your actual Supabase service role key.

## Testing

To test the pipeline, you can manually enqueue an artist discovery task:

### Test with Drake (ID: 3TVXtAsR1Inumwj472S9r4)

```bash
curl -X POST \
  https://nsxxzhhbcwzatvlulfyp.functions.supabase.co/artistDiscovery \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{"artistId": "3TVXtAsR1Inumwj472S9r4"}'
```

Or using an artist name:

```bash
curl -X POST \
  https://nsxxzhhbcwzatvlulfyp.functions.supabase.co/artistDiscovery \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{"artistName": "Drake"}'
```

## Monitoring

Monitor your pipeline using the following SQL queries:

```sql
-- Check queue stats
SELECT * FROM public.queue_stats;

-- Check dead letter details
SELECT * FROM public.dead_letter_details;

-- Check current queue lengths
SELECT queue_name, count(*) 
FROM pgmq.messages 
WHERE archived = false 
GROUP BY queue_name;

-- Check currently processing messages (with visibility timeout)
SELECT queue_name, count(*) 
FROM pgmq.messages 
WHERE archived = false AND vt > now()
GROUP BY queue_name;
```

## Diagnosing Issues

To diagnose issues:

1. Check the Edge Function logs in the Supabase dashboard
2. Check the dead letter queue for failed messages
3. Check the queue metrics table for error patterns
4. Verify Spotify API credentials are valid
5. Ensure all workers are running on schedule
