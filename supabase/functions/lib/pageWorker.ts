
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';

export abstract class PageWorker<Msg> {
  protected supabase: SupabaseClient<Database>;
  protected queueName: string;
  protected vtSeconds: number;

  constructor(queueName: string, vtSeconds = 60) {
    this.queueName = queueName;
    this.vtSeconds = vtSeconds;
    
    // Initialize Supabase client with service role key
    this.supabase = createClient<Database>(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );
  }

  // Read exactly one message from the queue
  async readOne(): Promise<{ msgId: number; msg: Msg; readCt: number } | null> {
    console.log(`Reading one message from queue: ${this.queueName}`);
    
    const { data, error } = await this.supabase.rpc('pgmq_read', {
      queue_name: this.queueName,
      vt: this.vtSeconds,
      qty: 1 // Always read exactly one message
    });
    
    if (error) {
      console.error(`Error polling queue ${this.queueName}:`, error);
      throw error;
    }
    
    if (!data || data.length === 0) {
      console.log(`No messages available in queue: ${this.queueName}`);
      return null;
    }
    
    const row = data[0];
    return {
      msgId: row.msg_id,
      msg: row.message as Msg,
      readCt: row.read_ct
    };
  }

  // Process a single message (to be implemented by subclass)
  protected abstract process(msg: Msg): Promise<void>;

  // Acknowledge/archive a processed message
  async ack(msgId: number): Promise<void> {
    console.log(`Acknowledging message ${msgId} from queue ${this.queueName}`);
    
    const { error } = await this.supabase.rpc('pgmq_archive', {
      queue_name: this.queueName,
      msg_id: msgId
    });
    
    if (error) {
      console.error(`Error archiving message ${msgId} from ${this.queueName}:`, error);
      throw error;
    }
    
    // Log success metric
    await this.supabase.from('queue_metrics').insert({
      queue_name: this.queueName,
      msg_id: msgId,
      status: 'success'
    });
    
    console.log(`Successfully archived message ${msgId} from queue ${this.queueName}`);
  }

  // Enqueue a new message to any queue
  async enqueue(queueName: string, msg: any): Promise<number> {
    const { data, error } = await this.supabase.rpc('pgmq_send', {
      queue_name: queueName,
      msg: msg
    });
    
    if (error) {
      console.error(`Error enqueueing message to ${queueName}:`, error);
      throw error;
    }
    
    console.log(`Successfully enqueued message to ${queueName}, msg_id: ${data}`);
    return data;
  }

  // Move message to dead letter queue after too many failures
  async moveToDeadLetter(msgId: number, msg: any, readCt: number, error: any): Promise<void> {
    console.log(`Moving message ${msgId} to dead letter queue after ${readCt} failures`);
    
    await this.supabase.from('pgmq_dead_letter_items').insert({
      queue_name: this.queueName,
      msg: msg,
      fail_count: readCt,
      details: { error: String(error) }
    });
    
    // Archive the message so it doesn't reappear in the queue
    await this.ack(msgId);
  }

  // Log error without moving to dead letter
  async logError(msgId: number, error: any): Promise<void> {
    console.error(`Error processing message ${msgId} on ${this.queueName}:`, error);
    
    await this.supabase.from('queue_metrics').insert({
      queue_name: this.queueName,
      msg_id: msgId,
      status: 'error',
      details: { error: String(error) }
    });
  }

  // Main runner method - read one, process, ack if success, handle errors
  async run(): Promise<void> {
    console.log(`Running page-worker for queue: ${this.queueName}`);
    
    const message = await this.readOne();
    if (!message) {
      console.log(`No message to process for queue: ${this.queueName}`);
      return;
    }
    
    const { msgId, msg, readCt } = message;
    
    try {
      console.log(`Processing message ${msgId} from queue ${this.queueName}`);
      await this.process(msg);
      await this.ack(msgId);
    } catch (err) {
      console.error(`Error processing msg ${msgId} on ${this.queueName}:`, err);
      
      // If too many retries, move to dead-letter
      if (readCt >= 5) {
        await this.moveToDeadLetter(msgId, msg, readCt + 1, err);
      } else {
        // Log the error and leave the message (it will reappear after vt)
        await this.logError(msgId, err);
      }
    }
  }
}
