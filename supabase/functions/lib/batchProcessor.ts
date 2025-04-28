
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';

export interface BatchOptions {
  concurrency: number;  // Max parallel operations
  batchSize: number;    // Messages per batch
  retryAttempts: number;
  timeoutMs: number;
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

  constructor(
    supabaseClient: SupabaseClient<Database>,
    options: Partial<BatchOptions> = {}
  ) {
    this.supabase = supabaseClient;
    this.options = {
      concurrency: 3,
      batchSize: 10,
      retryAttempts: 3,
      timeoutMs: 30000,
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

      if (error) throw error;
      if (!messages || messages.length === 0) {
        return stats;
      }

      // Process messages in chunks based on concurrency
      const chunks = this.chunkArray(messages, this.options.concurrency);
      
      for (const chunk of chunks) {
        try {
          // Process chunk with timeout
          await Promise.race([
            processor(chunk.map(m => m.message as T)),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Batch processing timeout')), this.options.timeoutMs)
            )
          ]);

          // Archive successfully processed messages
          await Promise.all(chunk.map(msg =>
            this.supabase.rpc('pgmq_archive', {
              queue_name: queueName,
              msg_id: msg.msg_id
            })
          ));

          stats.succeeded += chunk.length;
        } catch (error) {
          stats.failed += chunk.length;
          stats.errors.push(error as Error);
          
          // Log chunk failure
          await this.supabase.from('worker_issues').insert({
            worker_name: queueName,
            issue_type: 'batch_processing_error',
            details: {
              error: error.message,
              messages: chunk.map(m => m.msg_id),
              timestamp: new Date().toISOString()
            }
          });
        }

        stats.processed += chunk.length;
      }

    } catch (error) {
      console.error(`Batch processing error in queue ${queueName}:`, error);
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
