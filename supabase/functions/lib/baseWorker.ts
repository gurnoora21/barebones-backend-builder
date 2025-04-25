
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';

export abstract class BaseWorker<Msg> {
  protected supabase: SupabaseClient<Database>;
  protected queueName: string;
  protected vtSeconds: number;
  protected batchSize: number;

  constructor(queueName: string, vtSeconds = 60, batchSize = 5) {
    this.queueName = queueName;
    this.vtSeconds = vtSeconds;
    this.batchSize = batchSize;
    
    // Initialize Supabase client with service role key
    this.supabase = createClient<Database>(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );
  }

  // Poll the queue for messages (up to batchSize)
  async poll(): Promise<any[]> {
    try {
      console.log(`Polling queue ${this.queueName} with visibility timeout ${this.vtSeconds}s and batch size ${this.batchSize}`);
      const { data, error } = await this.supabase.rpc('pgmq_read', {
        queue_name: this.queueName,
        visibility_timeout: this.vtSeconds,
        batch_size: this.batchSize
      });
      
      if (error) {
        console.error(`Error polling queue ${this.queueName}:`, error);
        await this.logIssue('queue_poll_error', { error: error.message });
        throw error;
      }
      
      return data || [];
    } catch (err) {
      console.error(`Exception polling queue ${this.queueName}:`, err);
      await this.logIssue('queue_poll_exception', { error: String(err) });
      return [];
    }
  }

  // Process a single message (to be implemented by subclass)
  protected abstract processMessage(msgBody: Msg, msgId: number): Promise<void>;

  // Log an issue to a dedicated table
  protected async logIssue(type: string, details: any): Promise<void> {
    try {
      await this.supabase.from('worker_issues').insert({
        worker_name: this.queueName,
        issue_type: type,
        details: details
      });
    } catch (e) {
      // Don't let error logging cause more errors
      console.error('Failed to log issue:', e);
    }
  }

  // Run the worker: poll and handle messages
  async run() {
    console.log(`Running worker for queue: ${this.queueName}`);
    
    try {
      const messages = await this.poll();
      console.log(`Found ${messages.length} messages in queue: ${this.queueName}`);
      
      for (const row of messages) {
        const msgId: number = row.msg_id;
        const msgBody: Msg = row.message as Msg;
        
        try {
          console.log(`Processing message ${msgId} from queue ${this.queueName}`);
          const startTime = Date.now();
          await this.processMessage(msgBody, msgId);
          const processingTime = Date.now() - startTime;
          
          // Archive message on success to remove it
          await this.supabase.rpc('pgmq_archive', {
            queue_name: this.queueName,
            msg_id: msgId
          });
          
          // Log success metric
          await this.supabase.from('queue_metrics').insert({
            queue_name: this.queueName,
            msg_id: msgId,
            status: 'success',
            details: { processing_time_ms: processingTime }
          });
          
          console.log(`Successfully processed message ${msgId} from queue ${this.queueName} in ${processingTime}ms`);
        } catch (err) {
          console.error(`Error processing msg ${msgId} on ${this.queueName}:`, err);
          
          // If too many retries (read_ct), move to dead-letter
          const read_ct = row.read_ct || 0;
          if (read_ct >= 5) {
            // Move to dead-letter table
            await this.supabase.from('pgmq_dead_letter_items').insert({
              queue_name: this.queueName,
              msg: msgBody,
              fail_count: read_ct + 1,
              details: { error: String(err), category: this.categorizeError(err) }
            });
            
            // Archive so it doesn't reappear
            await this.supabase.rpc('pgmq_archive', {
              queue_name: this.queueName,
              msg_id: msgId
            });
            
            console.log(`Moved message ${msgId} to dead letter queue after ${read_ct} attempts`);
          } else {
            // Log the error and leave the message (it will reappear after vt)
            await this.supabase.from('queue_metrics').insert({
              queue_name: this.queueName,
              msg_id: msgId,
              status: 'error',
              details: { error: String(err), category: this.categorizeError(err) }
            });
            
            console.log(`Failed to process message ${msgId}, will retry later`);
          }
        }
      }
    } catch (err) {
      console.error(`Worker execution error in ${this.queueName}:`, err);
      await this.logIssue('worker_execution_error', { error: String(err) });
    }
  }

  // Enqueue a message in a queue
  async enqueue(queueName: string, message: any): Promise<number> {
    console.log(`Enqueueing message to ${queueName}:`, message);
    
    try {
      const { data, error } = await this.supabase.rpc('pgmq_send', {
        queue_name: queueName,
        msg: message
      });
      
      if (error) {
        console.error(`Error enqueueing to ${queueName}:`, error);
        throw error;
      }
      
      console.log(`Successfully enqueued message to ${queueName}, msg_id: ${data}`);
      return data;
    } catch (err) {
      console.error(`Exception enqueueing to ${queueName}:`, err);
      throw err;
    }
  }

  // Categorize error for better tracking
  protected categorizeError(err: any): string {
    const errString = String(err);
    
    if (errString.includes('permission denied')) {
      return 'permission_denied';
    } else if (errString.includes('not found') || errString.includes('does not exist')) {
      return 'not_found';
    } else if (errString.includes('timeout')) {
      return 'timeout';
    } else if (errString.includes('rate limit')) {
      return 'rate_limit';
    } else {
      return 'unknown';
    }
  }
}
