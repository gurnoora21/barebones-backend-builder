
-- Function to reset a circuit breaker
CREATE OR REPLACE FUNCTION reset_circuit_breaker(circuit_name TEXT)
RETURNS VOID AS $$
DECLARE
  old_state TEXT;
BEGIN
  -- Get the current state
  SELECT state INTO old_state FROM circuit_breakers WHERE name = circuit_name;
  
  -- Update the circuit breaker state
  UPDATE circuit_breakers
  SET 
    state = 'closed',
    failure_count = 0,
    success_count = 0,
    last_state_change = NOW()
  WHERE name = circuit_name;
  
  -- Log the change event
  INSERT INTO circuit_breaker_events (
    circuit_name,
    old_state,
    new_state,
    failure_count,
    details
  ) VALUES (
    circuit_name,
    COALESCE(old_state, 'unknown'),
    'closed',
    0,
    jsonb_build_object(
      'reset_by', 'database',
      'reset_time', NOW(),
      'reason', 'Manual reset via SQL function'
    )
  );
END;
$$ LANGUAGE plpgsql;

-- Function to reset all circuit breakers
CREATE OR REPLACE FUNCTION reset_all_circuit_breakers()
RETURNS INTEGER AS $$
DECLARE
  reset_count INTEGER := 0;
  circuit_rec RECORD;
BEGIN
  FOR circuit_rec IN SELECT name FROM circuit_breakers LOOP
    PERFORM reset_circuit_breaker(circuit_rec.name);
    reset_count := reset_count + 1;
  END LOOP;
  
  RETURN reset_count;
END;
$$ LANGUAGE plpgsql;

-- Create worker pause and unpause procedures
CREATE OR REPLACE PROCEDURE pause_worker(worker_name TEXT, admin_name TEXT)
AS $$
BEGIN
  UPDATE worker_status
  SET 
    is_paused = TRUE,
    paused_at = NOW(),
    paused_by = admin_name,
    last_updated = NOW()
  WHERE worker_name = $1;
  
  INSERT INTO worker_issues (
    worker_name,
    issue_type,
    details
  ) VALUES (
    worker_name,
    'worker_paused',
    jsonb_build_object(
      'paused_by', admin_name,
      'paused_at', NOW(),
      'reason', 'Manual pause for maintenance or rate limit recovery'
    )
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE PROCEDURE unpause_worker(worker_name TEXT)
AS $$
BEGIN
  UPDATE worker_status
  SET 
    is_paused = FALSE,
    last_updated = NOW()
  WHERE worker_name = $1;
  
  INSERT INTO worker_issues (
    worker_name,
    issue_type,
    details
  ) VALUES (
    worker_name,
    'worker_resumed',
    jsonb_build_object(
      'resumed_at', NOW()
    )
  );
END;
$$ LANGUAGE plpgsql;

-- Create functions to clear queue visibility timeouts
CREATE OR REPLACE FUNCTION pgmq_clear_visibility(queue_name TEXT)
RETURNS INTEGER AS $$
DECLARE
  cleared_count INTEGER;
BEGIN
  -- This is a direct call to the underlying PGMQ table
  UPDATE pgmq.messages
  SET vt = NULL
  WHERE queue_name = $1
    AND NOT archived
    AND vt IS NOT NULL
    AND vt < NOW();
    
  GET DIAGNOSTICS cleared_count = ROW_COUNT;
  RETURN cleared_count;
END;
$$ LANGUAGE plpgsql;
