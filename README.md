
# Backend-Only Music Producer Discovery Pipeline

A robust, backend-only pipeline that crawls Spotify and Genius data, identifies music producers and writers, and enriches them with social media information. Built on Supabase with PGMQ queue system.

## Architecture

This system uses a page-worker pattern, where each worker:
1. Reads exactly one message from PGMQ
2. Processes the message
3. Acknowledges/archives the message on success
4. Manages errors with dead letter queues

![Architecture Diagram](https://mermaid.ink/svg/pako:eNqNk8tu2zAQRX_FIJtWgGLY3gSlK6doswwMd9GFoYU0ImlSJSnDMPTvHcqO0zRBgHihebiHc-dBvypla1Xl1dHz4GSYiOLlGI9JMAHdooYHDuk0kOuM2Kh2Et_wZFTNsRpzg0EDzlnbfgcX8Clt0L_inmUEe1iu-5_2mdrt0H1TDyja6AGjUXfs5Rmm8k7KaIA8aOGhBhdoAgtJhGglT1BADJZ3PfmsRCOeB5y8XdnfP1cAN9B3CtQhVOTNnJnUXOAXyri0B9VoA9rR5u-JYge2pXnagNe5Mm-NJLLERA5c-kzkvNGxGVuOOzUeAuqbzVQVbY66avBpDpaNBK-cqMl4ZHYAJ5SwwKimmFbhHmw-xKc9ODtTlXwktF0lRduQc5r23b5ht_fU5p5UDE63O4bjDnRHSiJKhPDnHBn-Ap3RwkJuViJrE3UjdSds9APzTKujGPay4wVxF5OjFGM044e2Bmctb49flWGLJvQnypCV-FOu7XSJrDH5XcNJSwrLkJZslE5xeZzCSP45TuLOOd5inerQJm95wXNgW0k4i_wJdRjWRal0_u5l5sxvnc_tf1Cp0lRrpSoJzVkVFAtTLfND09TMXVUs63XZ1L8-NPXq-GE5X31U-ybHGwE=)

## Queue Structure

The system uses these PGMQ queues:
- `artist_discovery`: Entry point, contains artist IDs or names to process
- `album_discovery`: Album discovery tasks (artistId + offset)
- `track_discovery`: Track discovery tasks for each album
- `producer_identification`: Producer identification tasks for each track
- `social_enrichment`: Social profile enrichment for identified producers

## Core Components

### Enhanced Base Classes
- `PageWorker<Msg>`: Base class for all workers with resilience features
- `RateLimiter`: Controls API request rates to avoid hitting limits
- `CircuitBreaker`: Prevents calling failing services repeatedly
- `MemoryCache`: Simple TTL cache for API responses

### Worker Functions
All implemented as Supabase Edge Functions:
- `artistDiscovery`: Entry point, resolves artist IDs and kickstarts pipeline
- `albumDiscovery`: Gets artist's albums in pages of 50
- `trackDiscovery`: Gets album tracks in pages of 50
- `producerIdentification`: Identifies producers/collaborators for tracks from both Spotify and Genius
- `socialEnrichment`: Enriches producer info with social profiles

### API Clients
- `spotifyClient.ts`: Enhanced Spotify API client with rate limiting, caching, etc.
- `geniusClient.ts`: Genius API client for fetching detailed producer/writer credits

### Utilities
- `maintenance`: Scheduled cleanup and recovery tasks

## Required Environment Variables

```
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SPOTIFY_CLIENT_ID=your-spotify-client-id
SPOTIFY_CLIENT_SECRET=your-spotify-client-secret
GENIUS_ACCESS_TOKEN=your-genius-access-token
```

## Setup Instructions

1. **Create Database Tables and Functions**:
   Run the SQL files in `/supabase/sql` in the following order:
   - `create_rate_limits_table.sql`
   - `setup_maintenance.sql`
   - `setup_cron_jobs.sql`

2. **Set Environment Variables**:
   Add the required secrets in Supabase Dashboard > Settings > API > Edge Functions.

3. **Deploy Edge Functions**:
   The Edge Functions should deploy automatically with your code changes.

4. **Initialize Cron Jobs**:
   Run this SQL command in Supabase SQL Editor:
   ```sql
   CALL schedule_worker_invocations();
   ```

## Testing the Pipeline

To manually trigger the process for a specific artist (e.g., Drake):

```bash
curl -X POST https://your-project-ref.supabase.co/functions/v1/artistDiscovery \
  -H "Authorization: Bearer your-anon-key" \
  -H "Content-Type: application/json" \
  -d '{"artistName": "Drake"}'
```

For Drake, you can also use his Spotify artist ID directly:
```bash
curl -X POST https://your-project-ref.supabase.co/functions/v1/artistDiscovery \
  -H "Authorization: Bearer your-anon-key" \
  -H "Content-Type: application/json" \
  -d '{"artistId": "3TVXtAsR1Inumwj472S9r4"}'
```

## Monitoring

1. **Queue Statistics**:
   ```sql
   SELECT * FROM queue_stats ORDER BY hour DESC;
   ```

2. **Dead Letter Analysis**:
   ```sql
   SELECT * FROM dead_letter_analysis;
   ```

3. **Edge Function Logs**:
   View logs in Supabase Dashboard > Edge Functions > [function name] > Logs

4. **Rate Limit Status**:
   ```sql
   SELECT * FROM rate_limits;
   ```

5. **Maintenance Logs**:
   ```sql
   SELECT * FROM maintenance_logs ORDER BY timestamp DESC;
   ```

## Advanced Features

The system includes these production-grade features:

1. **Multi-Source Producer Identification**:
   - Spotify API for collaborator information
   - Genius API for detailed producer and writer credits
   - Confidence scoring based on data source reliability
   - Deduplication of producers across multiple sources

2. **Rate Limiting & Backpressure Control**:
   - Fixed-window rate limiting with DB storage
   - Concurrency limits to prevent overloading
   - Dynamic backoff based on response headers

3. **Circuit Breaker Pattern**:
   - Prevents hammering failing services
   - Auto-resets after cooldown period
   - State tracking (CLOSED, OPEN, HALF-OPEN)

4. **Enhanced Error Handling**:
   - Error categorization by type
   - Retryable vs. non-retryable distinction
   - Timeout controls for all operations

5. **Caching Layer**:
   - In-memory TTL cache for API responses
   - Per-endpoint TTL configuration
   - Automatic cache invalidation

6. **Maintenance Tasks**:
   - Scheduled cleanup of expired records
   - Detection and handling of stalled messages
   - Health checks and monitoring

7. **Observability**:
   - Detailed structured logging
   - Performance metrics collection
   - Error aggregation and analysis

8. **Schema Validation**:
   - Message schema validation
   - Strong typing with TypeScript
   - Dead-letter handling of invalid messages
