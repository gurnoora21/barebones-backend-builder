
-- Create function to reset a specific circuit breaker
CREATE OR REPLACE FUNCTION reset_circuit_breaker(circuit_name TEXT) 
RETURNS BOOLEAN AS $$
DECLARE
  reset_successful BOOLEAN := FALSE;
  response JSONB;
BEGIN
  -- Check if the circuit exists
  IF NOT EXISTS (
    SELECT 1 FROM circuit_breakers
    WHERE name = circuit_name
  ) THEN
    RAISE EXCEPTION 'Circuit % does not exist', circuit_name;
  END IF;

  -- Call the resetCircuitBreakers edge function
  SELECT content::jsonb INTO response
  FROM net.http_post(
    url := concat(current_setting('app.settings.supabase_url'), '/functions/v1/resetCircuitBreakers'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', concat('Bearer ', current_setting('app.settings.supabase_anon_key'))
    ),
    body := jsonb_build_object('circuitName', circuit_name)
  );
  
  -- Check if reset was successful
  IF response->>'success' = 'true' THEN
    reset_successful := TRUE;
    
    -- Log the reset operation
    INSERT INTO worker_issues (
      worker_name, 
      issue_type, 
      details
    ) VALUES (
      'circuit_breaker_manager',
      'manual_circuit_reset',
      jsonb_build_object(
        'circuit_name', circuit_name,
        'reset_method', 'sql_function',
        'response', response,
        'timestamp', now()
      )
    );
  ELSE
    RAISE WARNING 'Failed to reset circuit %: %', circuit_name, response;
  END IF;

  RETURN reset_successful;
END;
$$ LANGUAGE plpgsql;

-- Function to reset all open Spotify circuit breakers
CREATE OR REPLACE FUNCTION reset_all_spotify_circuits() 
RETURNS INTEGER AS $$
DECLARE
  circuit_rec RECORD;
  reset_count INTEGER := 0;
BEGIN
  -- Iterate through all open Spotify-related circuits
  FOR circuit_rec IN 
    SELECT name 
    FROM circuit_breakers 
    WHERE name LIKE 'spotify%' AND state = 'open'
  LOOP
    -- Reset each circuit
    IF reset_circuit_breaker(circuit_rec.name) THEN
      reset_count := reset_count + 1;
    END IF;
  END LOOP;

  -- Log the batch reset operation if any were reset
  IF reset_count > 0 THEN
    INSERT INTO worker_issues (
      worker_name, 
      issue_type, 
      details
    ) VALUES (
      'circuit_breaker_manager',
      'batch_circuit_reset',
      jsonb_build_object(
        'reset_count', reset_count,
        'circuit_type', 'spotify',
        'reset_method', 'sql_function',
        'timestamp', now()
      )
    );
  END IF;

  RETURN reset_count;
END;
$$ LANGUAGE plpgsql;
