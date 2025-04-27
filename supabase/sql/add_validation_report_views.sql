
-- Create a view for easy validation report access
CREATE OR REPLACE VIEW validation_summary AS
SELECT 
  id,
  created_at as timestamp,
  summary->>'total_tests' as total_tests,
  summary->>'passed' as tests_passed,
  summary->>'warnings' as tests_with_warnings,
  summary->>'failures' as tests_failed,
  summary->>'critical_failures' as critical_failures,
  results
FROM validation_reports
ORDER BY created_at DESC;

-- Create a view for validation trend analysis
CREATE OR REPLACE VIEW validation_trends AS
SELECT
  date_trunc('day', created_at) as day,
  COUNT(*) as validation_runs,
  AVG((summary->>'passed')::numeric) as avg_tests_passed,
  AVG((summary->>'failures')::numeric) as avg_tests_failed,
  AVG((summary->>'warnings')::numeric) as avg_tests_warnings
FROM validation_reports
GROUP BY date_trunc('day', created_at)
ORDER BY day DESC;
