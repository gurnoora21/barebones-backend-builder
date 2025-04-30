
import { SupabaseClient, createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';
import { BatchProcessor } from './batchProcessor.ts';
import { logger } from './logger.ts';
import { wait } from './retry.ts';

// Global state shared across all workers to implement backpressure control
const globalState = {
  concurrentOperations: 0,
  maxConcurrentOperations: 5,
  waitForBackpressure: async function(workerName: string): Promise<void> {
    if (this.concurrentOperations >= this.maxConcurrentOperations) {
      const waitLogger = logger.child({ component: 'Backpressure', worker: workerName });
      waitLogger.info(`Applying backpressure, waiting for capacity. Current: ${this.concurrentOperations}/${this.maxConcurrentOperations}`);
      
      while (this.concurrentOperations >= this.maxConcurrentOperations) {
        await wait(500);
      }
      
      waitLogger.debug('Backpressure released, proceeding with operation');
    }
  },
  incrementOperations: function(): void {
    this.concurrentOperations++;
  },
  decrementOperations: function(): void {
    this.concurrentOperations = Math.max(0, this.concurrentOperations - 1);
  }
};

/**
 * Base Worker for processing work from a PGMQ queue using a page-based approach
 * @template T - The message payload type
 */
export abstract class PageWorker<T> {
  protected supabase: SupabaseClient<Database>;
  protected queueName: string;
  protected visibilityTimeout: number;
  protected batchProcessor: BatchProcessor<T>;
  protected logger: any;
  protected isRunning = false;
  protected lastRunTime = 0;
  protected minTimeBetweenRuns = 1000; // Minimum 1s between worker runs
  
  constructor(queueName: string, visibilityTimeout = 300) {
    this.queueName = queueName;
    this.visibilityTimeout = visibilityTimeout;
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    this.supabase = createClient<Database>(supabaseUrl, supabaseKey);
    this.batchProcessor = new BatchProcessor<T>(this.supabase, {
      concurrency: 1,   // Process one message at a time
      batchSize: 1,     // Read one message at a time 
      delayBetweenItemsMs: 1000 // 1 second between items by default
    });
    
    this.logger = logger.child({ worker: queueName });
    
    // Log worker initialization
    this.logger.info(`Worker initialized with visibility timeout: ${visibilityTimeout}s`);
  }
  
  /**
   * Process a single message
   * This must be implemented by the derived class
   */
  protected abstract process(msg: T): Promise<void>;
  
  /**
   * Run the worker to process messages from the queue
   */
  async run(): Promise<void> {
    // Apply rate limiting to prevent too frequent worker invocations
    const now = Date.now();
    const timeSinceLastRun = now - this.lastRunTime;
    
    if (timeSinceLastRun < this.minTimeBetweenRuns) {
      const waitTime = this.minTimeBetweenRuns - timeSinceLastRun;
      this.logger.debug(`Throttling worker execution, waiting ${waitTime}ms`);
      await wait(waitTime);
    }
    
    // Mark this worker as running
    this.lastRunTime = Date.now();
    this.isRunning = true;
    
    try {
      // Wait for global backpressure to allow this operation
      await globalState.waitForBackpressure(this.queueName);
      
      // Increase the global operation counter
      globalState.incrementOperations();
      
      // Check if this worker is paused in the database
      const { data: workerStatus } = await this.supabase
        .from('worker_status')
        .select('is_paused, paused_at, paused_by')
        .eq('worker_name', this.queueName)
        .maybeSingle();
        
      if (workerStatus?.is_paused) {
        this.logger.info(`Worker is paused by ${workerStatus.paused_by} at ${workerStatus.paused_at}, skipping execution`);
        return;
      }
      
      // Read batch of messages from queue
      this.logger.info(`Reading batch of messages from queue: ${this.queueName}`);
      
      // Process messages in batch
      const stats = await this.batchProcessor.processBatch(
        this.queueName, 
        async (messages) => {
          // Process each message in series
          await Promise.all(messages.map(async msg => {
            try {
              await this.process(msg);
            } catch (error) {
              this.logger.error(`Error processing message:`, error);
              throw error; // Let BatchProcessor handle this error
            }
          }));
        },
        this.visibilityTimeout
      );
      
      // Log results
      if (stats.processed > 0) {
        this.logger.info(`Processed ${stats.processed} messages, succeeded: ${stats.succeeded}, failed: ${stats.failed}`);
      } else {
        this.logger.debug(`No messages to process in queue ${this.queueName}`);
      }
    } catch (error) {
      this.logger.error(`Unexpected error in worker:`, error);
    } finally {
      // Decrement global operation counter
      globalState.decrementOperations();
      this.isRunning = false;
    }
  }
  
  /**
   * Enqueue a message to a queue
   */
  async enqueue(queueName: string, message: any): Promise<void> {
    try {
      const { data, error } = await this.supabase.rpc(
        'pgmq_send',
        { 
          queue_name: queueName, 
          msg: message 
        }
      );
      
      if (error) {
        throw error;
      }
      
    } catch (error) {
      this.logger.error(`Error enqueuing message to ${queueName}:`, error);
      throw error;
    }
  }
}
