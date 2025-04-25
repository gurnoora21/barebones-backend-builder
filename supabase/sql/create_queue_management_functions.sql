
-- Function to safely drop and recreate a PGMQ queue
CREATE OR REPLACE FUNCTION pgmq_drop_and_recreate_queue(queue_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Try to drop the queue if it exists
  BEGIN
    PERFORM pgmq.drop_queue(queue_name);
    RAISE NOTICE 'Dropped queue: %', queue_name;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not drop queue: % (% - %)', queue_name, SQLSTATE, SQLERRM;
  END;

  -- Create the queue
  BEGIN
    PERFORM pgmq.create(queue_name);
    RAISE NOTICE 'Created queue: %', queue_name;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not create queue: % (% - %)', queue_name, SQLSTATE, SQLERRM;
    -- If we can't create it, try to purge it instead
    BEGIN
      EXECUTE format('TRUNCATE TABLE pgmq.q_%I', queue_name);
      EXECUTE format('TRUNCATE TABLE pgmq.a_%I', queue_name);
      RAISE NOTICE 'Purged messages from queue: %', queue_name;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not purge queue: % (% - %)', queue_name, SQLSTATE, SQLERRM;
    END;
  END;
END;
$$;

-- Function to just purge messages in an existing queue
CREATE OR REPLACE FUNCTION pgmq_purge_queue(queue_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  BEGIN
    EXECUTE format('TRUNCATE TABLE pgmq.q_%I', queue_name);
    EXECUTE format('TRUNCATE TABLE pgmq.a_%I', queue_name);
    RAISE NOTICE 'Purged messages from queue: %', queue_name;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not purge queue: % (% - %)', queue_name, SQLSTATE, SQLERRM;
  END;
END;
$$;
