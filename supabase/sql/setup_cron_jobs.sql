
-- Enable required extensions if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Create a table to store worker status
CREATE TABLE IF NOT EXISTS worker_status (
  worker_name TEXT PRIMARY KEY,
  is_paused BOOLEAN NOT NULL DEFAULT false,
  paused_at TIMESTAMPTZ,
  paused_by TEXT,
  last_updated TIMESTAMPTZ DEFAULT now()
);

-- Function to check if a worker is paused
CREATE OR REPLACE FUNCTION is_worker_paused(worker TEXT) RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM worker_status 
    WHERE worker_name = worker AND is_paused = true
  );
END;
$$ LANGUAGE plpgsql;

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
    DO $$
    BEGIN
      IF NOT is_worker_paused('artist-discovery-worker') THEN
        PERFORM net.http_post(
          url:='$$ || url || $$/functions/v1/artistDiscovery',
          headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
          body:='{}'::jsonb
        );
      END IF;
    END $$;
    $$
  );
  
  -- Schedule album discovery worker every 2 minutes
  PERFORM cron.schedule(
    'album-discovery-worker',
    '*/2 * * * *',
    $$
    DO $$
    BEGIN
      IF NOT is_worker_paused('album-discovery-worker') THEN
        PERFORM net.http_post(
          url:='$$ || url || $$/functions/v1/albumDiscovery',
          headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
          body:='{}'::jsonb
        );
      END IF;
    END $$;
    $$
  );
  
  -- Schedule track discovery worker every 2 minutes
  PERFORM cron.schedule(
    'track-discovery-worker',
    '*/2 * * * *',
    $$
    DO $$
    BEGIN
      IF NOT is_worker_paused('track-discovery-worker') THEN
        PERFORM net.http_post(
          url:='$$ || url || $$/functions/v1/trackDiscovery',
          headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
          body:='{}'::jsonb
        );
      END IF;
    END $$;
    $$
  );
  
  -- Schedule producer identification worker every 2 minutes
  PERFORM cron.schedule(
    'producer-identification-worker',
    '*/2 * * * *',
    $$
    DO $$
    BEGIN
      IF NOT is_worker_paused('producer-identification-worker') THEN
        PERFORM net.http_post(
          url:='$$ || url || $$/functions/v1/producerIdentification',
          headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
          body:='{}'::jsonb
        );
      END IF;
    END $$;
    $$
  );
  
  -- Social enrichment worker is paused by default
  PERFORM cron.schedule(
    'social-enrichment-worker',
    '*/2 * * * *',
    $$
    DO $$
    BEGIN
      IF NOT is_worker_paused('social-enrichment-worker') THEN
        PERFORM net.http_post(
          url:='$$ || url || $$/functions/v1/socialEnrichment',
          headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
          body:='{}'::jsonb
        );
      END IF;
    END $$;
    $$
  );
  
  -- Schedule maintenance worker every 15 minutes
  PERFORM cron.schedule(
    'maintenance-worker',
    '*/15 * * * *',
    $$
    DO $$
    BEGIN
      IF NOT is_worker_paused('maintenance-worker') THEN
        PERFORM net.http_post(
          url:='$$ || url || $$/functions/v1/maintenance',
          headers:='{"Content-Type": "application/json", "Authorization": "Bearer $$ || anon_key || $$"}'::jsonb,
          body:='{}'::jsonb
        );
      END IF;
    END $$;
    $$
  );
  
  -- Insert initial worker status records if they don't exist
  INSERT INTO worker_status (worker_name, is_paused)
  VALUES 
    ('artist-discovery-worker', false),
    ('album-discovery-worker', false),
    ('track-discovery-worker', false),
    ('producer-identification-worker', false),
    ('social-enrichment-worker', true),  -- Set this worker to paused
    ('maintenance-worker', false)
  ON CONFLICT (worker_name) DO NOTHING;
  
  -- Make sure social-enrichment-worker is specifically paused
  UPDATE worker_status
  SET is_paused = true,
      paused_at = now(),
      paused_by = 'system',
      last_updated = now()
  WHERE worker_name = 'social-enrichment-worker';
END;
$$;

-- Create helper functions to pause/unpause workers
CREATE OR REPLACE PROCEDURE pause_worker(worker_name TEXT, paused_by TEXT)
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO worker_status (worker_name, is_paused, paused_at, paused_by, last_updated)
  VALUES (worker_name, true, now(), paused_by, now())
  ON CONFLICT (worker_name) 
  DO UPDATE SET 
    is_paused = true,
    paused_at = now(),
    paused_by = EXCLUDED.paused_by,
    last_updated = now();
END;
$$;

CREATE OR REPLACE PROCEDURE unpause_worker(worker_name TEXT)
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE worker_status 
  SET is_paused = false,
      paused_at = NULL,
      paused_by = NULL,
      last_updated = now()
  WHERE worker_name = worker_name;
END;
$$;

-- Reschedule all workers to apply changes
CALL schedule_worker_invocations();
