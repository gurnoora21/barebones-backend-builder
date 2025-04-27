
-- Function to get overall pipeline counts for metrics
CREATE OR REPLACE FUNCTION public.get_pipeline_counts()
RETURNS TABLE (
  artists_count BIGINT,
  albums_count BIGINT,
  tracks_count BIGINT,
  producers_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM artists) AS artists_count,
    (SELECT COUNT(*) FROM albums) AS albums_count,
    (SELECT COUNT(*) FROM tracks) AS tracks_count,
    (SELECT COUNT(*) FROM producers) AS producers_count;
END;
$$ LANGUAGE plpgsql;
