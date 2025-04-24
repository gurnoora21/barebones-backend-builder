
-- Rate limits table to track API usage
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key TEXT PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  window_end BIGINT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Add Postgres function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add a trigger for automatically updating timestamps
DROP TRIGGER IF EXISTS set_rate_limits_timestamp ON rate_limits;
CREATE TRIGGER set_rate_limits_timestamp
BEFORE UPDATE ON rate_limits
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
