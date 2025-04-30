
-- Update the existing cron jobs to run less frequently and implement self-healing

-- Function to check Spotify circuit breaker health
CREATE OR REPLACE FUNCTION check_spotify_circuits()
RETURNS void AS $$
DECLARE
  circuit_data record;
  recent_trips integer;
  should_pause boolean := false;
BEGIN
  -- Check if any Spotify circuits are open
  SELECT COUNT(*) INTO recent_trips
  FROM circuit_breakers
  WHERE name LIKE 'spotify%' 
    AND state = 'open'
    AND last_state_change > (now() - interval '30 minutes');
    
  -- If there are multiple recent circuit trips, we should consider pausing workers
  should_pause := recent_trips >= 3;
  
  -- Log the check results
  INSERT INTO worker_issues (worker_name, issue_type, details)
  VALUES ('circuit_monitor', 'circuit_health_check', jsonb_build_object(
    'spotify_circuits_open', recent_trips,
    'should_pause', should_pause,
    'timestamp', now()
  ));
  
  -- If we have multiple recent circuit trips, pause the workers
  IF should_pause THEN
    CALL pause_worker('artist_discovery_worker', 'auto_circuit_monitor');
    CALL pause_worker('album_discovery_worker', 'auto_circuit_monitor');
    CALL pause_worker('track_discovery_worker', 'auto_circuit_monitor');
    
    -- Log the pause action
    INSERT INTO worker_issues (worker_name, issue_type, details)
    VALUES ('circuit_monitor', 'workers_paused', jsonb_build_object(
      'reason', 'multiple_circuit_trips',
      'paused_workers', jsonb_build_array('artist_discovery_worker', 'album_discovery_worker', 'track_discovery_worker'),
      'auto_unpause_at', now() + interval '30 minutes',
      'timestamp', now()
    ));
    
    -- Schedule the workers to be unpaused in 30 minutes
    PERFORM pg_sleep(1800); -- 30 minutes in seconds
    
    CALL unpause_worker('artist_discovery_worker');
    CALL unpause_worker('album_discovery_worker');
    CALL unpause_worker('track_discovery_worker');
    
    -- Log the unpause action
    INSERT INTO worker_issues (worker_name, issue_type, details)
    VALUES ('circuit_monitor', 'workers_unpaused', jsonb_build_object(
      'reason', 'auto_timeout',
      'unpaused_workers', jsonb_build_array('artist_discovery_worker', 'album_discovery_worker', 'track_discovery_worker'),
      'timestamp', now()
    ));
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to reset long-open circuit breakers
CREATE OR REPLACE FUNCTION reset_long_open_circuits()
RETURNS void AS $$
DECLARE
  circuit record;
BEGIN
  FOR circuit IN 
    SELECT * 
    FROM circuit_breakers 
    WHERE state = 'open' 
      AND last_state_change < (now() - interval '4 hours')
  LOOP
    -- Call the function to reset the circuit breaker
    PERFORM net.http_post(
      url:=concat(current_setting('app.settings.supabase_url'), '/functions/v1/resetCircuitBreakers'),
      headers:=jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', concat('Bearer ', current_setting('app.settings.supabase_anon_key'))
      ),
      body:=jsonb_build_object('circuitName', circuit.name)
    );
    
    -- Log the reset operation
    INSERT INTO worker_issues (worker_name, issue_type, details)
    VALUES ('circuit_monitor', 'circuit_auto_reset', jsonb_build_object(
      'circuit_name', circuit.name,
      'state', circuit.state,
      'open_duration_hours', extract(epoch from (now() - circuit.last_state_change))/3600,
      'timestamp', now()
    ));
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Update the worker scheduling to be more conservative
CALL schedule_worker_invocations();

-- Add new cron jobs for self-healing
SELECT cron.schedule(
  'worker-health-monitor',
  '*/10 * * * *', -- every 10 minutes
  $$
  SELECT check_spotify_circuits();
  $$
);

SELECT cron.schedule(
  'reset-spotify-circuits',
  '0 */4 * * *', -- every 4 hours
  $$
  SELECT reset_long_open_circuits();
  $$
);
