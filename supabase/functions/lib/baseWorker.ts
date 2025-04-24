
import { createClient, SupabaseClient } from '@supabase/supabase-js';
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
    const { data, error } = await this.supabase.rpc('pgmq_read', {
      queue_name: this.queueName,
      vt: this.vtSeconds,
      qty: this.batchSize
    });
    
    if (error) {
      console.error(`Error polling queue ${this.queueName}:`, error);
      throw error;
    }
    
    return data || [];
  }

  // Process a single message (to be implemented by subclass)
  protected abstract processMessage(msgBody: Msg, msgId: number): Promise<void>;

  // Run the worker: poll and handle messages
  async run() {
    console.log(`Running worker for queue: ${this.queueName}`);
    const messages = await this.poll();
    console.log(`Found ${messages.length} messages in queue: ${this.queueName}`);
    
    for (const row of messages) {
      const msgId: number = row.msg_id;
      const msgBody: Msg = row.message as Msg;
      
      try {
        console.log(`Processing message ${msgId} from queue ${this.queueName}`);
        await this.processMessage(msgBody, msgId);
        
        // Archive message on success to remove it
        await this.supabase.rpc('pgmq_send', {
          queue_name: this.queueName,
          msg_id: msgId
        });
        
        // Log success metric
        await this.supabase.from('queue_metrics').insert({
          queue_name: this.queueName,
          msg_id: msgId,
          status: 'success'
        });
        
        console.log(`Successfully processed message ${msgId} from queue ${this.queueName}`);
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
            details: { error: String(err) }
          });
          
          // Archive so it doesn't reappear
          await this.supabase.rpc('pgmq_send', {
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
            details: { error: String(err) }
          });
          
          console.log(`Failed to process message ${msgId}, will retry later`);
        }
      }
    }
  }
}
