import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';
import { logger } from './logger.ts';
import { wait } from './retry.ts';

export interface BatchOptions {
  concurrency: number;  // Max parallel operations
  batchSize: number;    // Messages per batch
  retryAttempts: number;
  timeoutMs: number;
  delayBetweenItemsMs: number; // Delay between processing items
}

export interface BatchStats {
  processed: number;
  succeeded: number;
  failed: number;
  timing: {
    start: number;
    end: number;
    duration: number;
  };
  errors: Error[];
}

export class BatchProcessor<T> {
  private supabase: SupabaseClient<Database>;
  private options: BatchOptions;
  private logger = logger.child({ component: 'BatchProcessor' });

  constructor(
    supabaseClient: SupabaseClient<Database>,
    options: Partial<BatchOptions> = {}
  ) {
    this.supabase = supabaseClient;
    this.options = {
      concurrency: 2, // Reduced default concurrency
      batchSize: 3,   // Reduced default batch size
      retryAttempts: 3,
      timeoutMs: 30000,
      delayBetweenItemsMs: 250,  // Default delay between items
      ...options
    };
  }

  async processBatch(
    queueName: string,
    processor: (messages: T[]) => Promise<void>,
    visibilityTimeout = 60
  ): Promise<BatchStats> {
    const stats: BatchStats = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      timing: {
        start: Date.now(),
        end: 0,
        duration: 0
      },
      errors: []
    };

    try {
      // Read batch of messages
      const { data: messages, error } = await this.supabase.rpc('pgmq_read', {
        queue_name: queueName,
        visibility_timeout: visibilityTimeout,
        batch_size: this.options.batchSize
      });

      if (error) {
        this.logger.error(`Error reading from queue ${queueName}:`, error);
        throw error;
      }
      
      if (!messages || messages.length === 0) {
        return stats;
      }

      this.logger.info(`Processing ${messages.length} messages from queue ${queueName}`);
      
      // Process messages in chunks based on concurrency
      const chunks = this.chunkArray(messages, this.options.concurrency);
      
      for (const chunk of chunks) {
        try {
          // Process each message in the chunk sequentially
          for (const msg of chunk) {
            try {
              // Process with timeout
              await Promise.race([
                processor([msg.message as T]), // Process single message at a time
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('Processing timeout')), this.options.timeoutMs)
                )
              ]);

              // Archive successfully processed message
              await this.supabase.rpc('pgmq_archive', {
                queue_name: queueName,
                msg_id: msg.msg_id
              });

              stats.succeeded += 1;
              stats.processed += 1;
              
              // Add delay between items to prevent rate limiting
              await wait(this.options.delayBetweenItemsMs);
              
            } catch (error) {
              stats.failed += 1;
              stats.processed += 1;
              stats.errors.push(error as Error);
              
              // Log individual message failure
              this.logger.error(`Error processing message ${msg.msg_id} from queue ${queueName}:`, error);
              
              await this.supabase.from('worker_issues').insert({
                worker_name: queueName,
                issue_type: 'message_processing_error',
                details: {
                  error: error.message,
                  stack: error.stack,
                  message_id: msg.msg_id,
                  timestamp: new Date().toISOString()
                }
              });
              
              // Add delay between items even after errors
              await wait(this.options.delayBetweenItemsMs);
            }
          }
        } catch (error) {
          // This shouldn't happen with the sequential approach,
          // but let's keep it as a fallback for chunk-level errors
          this.logger.error(`Unexpected error processing chunk in queue ${queueName}:`, error);
          stats.errors.push(error as Error);
        }
      }

    } catch (error) {
      this.logger.error(`Batch processing error in queue ${queueName}:`, error);
      stats.errors.push(error as Error);
    }

    stats.timing.end = Date.now();
    stats.timing.duration = stats.timing.end - stats.timing.start;

    // Log batch stats
    await this.supabase.from('queue_metrics').insert({
      queue_name: queueName,
      status: stats.failed === 0 ? 'success' : 'partial_failure',
      msg_id: 0, // Batch operation
      details: {
        ...stats,
        batch_size: this.options.batchSize,
        concurrency: this.options.concurrency
      }
    });

    return stats;
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
