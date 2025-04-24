
-- Enable required extensions if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Function to schedule worker invocations
CREATE OR REPLACE PROCEDURE schedule_worker_invocations()
LANGUAGE plpgsql
AS $$
DECLARE
  url TEXT;
  anon_key TEXT;
BEGIN
  -- Get the URL and key from the environment or config
  SELECT current_setting('app.settings.supabase_url') INTO url;
  SELECT current_setting('app.settings.supabase_anon_key') INTO anon_key;
  
  -- Remove any existing schedules (to avoid duplicates on re-run)
  PERFORM cron.unschedule('artist-discovery-worker');
  PERFORM cron.unschedule('album-discovery-worker');
  PERFORM cron.unschedule('track-discovery-worker');
  PERFORM cron.unschedule('producer-identification-worker');
  PERFORM cron.unschedule('social-enrichment-worker');
  PERFORM cron.unschedule('maintenance-worker');
  
  -- Schedule artist discovery worker every 2 minutes
  PERFORM cron.schedule(
    'artist-discovery-worker',
    '*/2 * * * *',
    $$
    SELECT net.http_post(
      url:='$$ || url || $$/functions/v1/artistDiscovery',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
      body:='{}'::jsonb
    ) AS request_id;
    $$
  );
  
  -- Schedule album discovery worker every 2 minutes
  PERFORM cron.schedule(
    'album-discovery-worker',
    '*/2 * * * *',
    $$
    SELECT net.http_post(
      url:='$$ || url || $$/functions/v1/albumDiscovery',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
      body:='{}'::jsonb
    ) AS request_id;
    $$
  );
  
  -- Schedule track discovery worker every 2 minutes
  PERFORM cron.schedule(
    'track-discovery-worker',
    '*/2 * * * *',
    $$
    SELECT net.http_post(
      url:='$$ || url || $$/functions/v1/trackDiscovery',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
      body:='{}'::jsonb
    ) AS request_id;
    $$
  );
  
  -- Schedule producer identification worker every 2 minutes
  PERFORM cron.schedule(
    'producer-identification-worker',
    '*/2 * * * *',
    $$
    SELECT net.http_post(
      url:='$$ || url || $$/functions/v1/producerIdentification',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
      body:='{}'::jsonb
    ) AS request_id;
    $$
  );
  
  -- Schedule social enrichment worker every 2 minutes
  PERFORM cron.schedule(
    'social-enrichment-worker',
    '*/2 * * * *',
    $$
    SELECT net.http_post(
      url:='$$ || url || $$/functions/v1/socialEnrichment',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
      body:='{}'::jsonb
    ) AS request_id;
    $$
  );
  
  -- Schedule maintenance worker every 15 minutes
  PERFORM cron.schedule(
    'maintenance-worker',
    '*/15 * * * *',
    $$
    SELECT net.http_post(
      url:='$$ || url || $$/functions/v1/maintenance',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
      body:='{}'::jsonb
    ) AS request_id;
    $$
  );
END;
$$;
