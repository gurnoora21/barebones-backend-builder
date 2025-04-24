
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';
import { globalCache } from './cache.ts';
import { CircuitBreakerRegistry } from './circuitBreaker.ts';

// Error categories for better handling
export enum ErrorCategory {
  NETWORK = 'network',
  TIMEOUT = 'timeout',
  AUTH = 'authorization',
  VALIDATION = 'validation',
  RATE_LIMIT = 'rate_limit',
  NOT_FOUND = 'not_found',
  UNKNOWN = 'unknown'
}

export interface ErrorDetails {
  category: ErrorCategory;
  retryable: boolean; // Whether this error can be retried
  message: string;
  originalError?: Error;
}

export abstract class PageWorker<Msg> {
  protected supabase: SupabaseClient<Database>;
  protected queueName: string;
  protected vtSeconds: number;
  protected startTime: number;

  constructor(queueName: string, vtSeconds = 60) {
    this.queueName = queueName;
    this.vtSeconds = vtSeconds;
    this.startTime = Date.now();
    
    // Initialize Supabase client with service role key
    this.supabase = createClient<Database>(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );
  }

  // Read exactly one message from the queue
  async readOne(): Promise<{ msgId: number; msg: Msg; readCt: number } | null> {
    console.log(`Reading one message from queue: ${this.queueName}`);
    
    try {
      const { data, error } = await this.supabase.rpc('pgmq_read', {
        queue_name: this.queueName,
        vt: this.vtSeconds,
        qty: 1 // Always read exactly one message
      });
      
      if (error) {
        console.error(`Error polling queue ${this.queueName}:`, error);
        throw this.categorizeError(error);
      }
      
      if (!data || data.length === 0) {
        console.log(`No messages available in queue: ${this.queueName}`);
        return null;
      }
      
      const row = data[0];
      
      // Validate message schema before processing
      const msg = row.message as Msg;
      if (!this.validateMessage(msg)) {
        // Invalid schema - dead letter immediately
        await this.moveToDeadLetter(row.msg_id, msg, row.read_ct, {
          category: ErrorCategory.VALIDATION,
          retryable: false,
          message: `Invalid message schema for queue ${this.queueName}`
        });
        return null;
      }
      
      return {
        msgId: row.msg_id,
        msg: msg,
        readCt: row.read_ct
      };
    } catch (err) {
      const categorizedError = this.categorizeError(err);
      console.error(`Error reading from queue ${this.queueName}:`, categorizedError);
      
      // Log the error in queue metrics
      await this.logError(0, categorizedError);
      
      // For connection errors, wait before retry
      if (categorizedError.category === ErrorCategory.NETWORK) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      
      throw categorizedError;
    }
  }

  // Process a single message (to be implemented by subclass)
  protected abstract process(msg: Msg): Promise<void>;

  // Validate message schema (can be overridden by subclasses)
  protected validateMessage(msg: Msg): boolean {
    // Basic validation - ensure msg is not null/undefined
    // Subclasses can implement more specific validation
    return msg !== null && msg !== undefined;
  }

  // Acknowledge/archive a processed message
  async ack(msgId: number): Promise<void> {
    console.log(`Acknowledging message ${msgId} from queue ${this.queueName}`);
    
    try {
      const { error } = await this.supabase.rpc('pgmq_archive', {
        queue_name: this.queueName,
        msg_id: msgId
      });
      
      if (error) {
        console.error(`Error archiving message ${msgId} from ${this.queueName}:`, error);
        throw this.categorizeError(error);
      }
      
      // Log success metric
      const processingTime = Date.now() - this.startTime;
      await this.supabase.from('queue_metrics').insert({
        queue_name: this.queueName,
        msg_id: msgId,
        status: 'success',
        details: { 
          processing_time_ms: processingTime,
          worker_instance: this.getWorkerId()
        }
      });
      
      console.log(`Successfully archived message ${msgId} from queue ${this.queueName} in ${processingTime}ms`);
    } catch (err) {
      console.error(`Failed to acknowledge message ${msgId}:`, err);
      // We'll still consider the message processed, but the ack failed
      // It will eventually reappear in the queue after VT expires
    }
  }

  // Enqueue a new message to any queue
  async enqueue(queueName: string, msg: any): Promise<number> {
    try {
      const { data, error } = await this.supabase.rpc('pgmq_send', {
        queue_name: queueName,
        msg: msg
      });
      
      if (error) {
        console.error(`Error enqueueing message to ${queueName}:`, error);
        throw this.categorizeError(error);
      }
      
      console.log(`Successfully enqueued message to ${queueName}, msg_id: ${data}`);
      return data;
    } catch (err) {
      const categorizedError = this.categorizeError(err);
      console.error(`Failed to enqueue message to ${queueName}:`, categorizedError);
      throw categorizedError;
    }
  }

  // Move message to dead letter queue after too many failures
  async moveToDeadLetter(msgId: number, msg: any, readCt: number, error: ErrorDetails): Promise<void> {
    console.log(`Moving message ${msgId} to dead letter queue after ${readCt} failures`);
    
    try {
      await this.supabase.from('pgmq_dead_letter_items').insert({
        queue_name: this.queueName,
        msg: msg,
        fail_count: readCt,
        details: { 
          error: error.message,
          category: error.category,
          time: new Date().toISOString(),
          worker_instance: this.getWorkerId()
        }
      });
      
      // Archive the message so it doesn't reappear in the queue
      await this.ack(msgId);
      
      console.log(`Successfully moved message ${msgId} to dead letter queue`);
    } catch (err) {
      console.error(`Failed to move message ${msgId} to dead letter queue:`, err);
      // If we can't move to DLQ, just log and let VT expire
    }
  }

  // Log error without moving to dead letter
  async logError(msgId: number, error: ErrorDetails): Promise<void> {
    console.error(`Error processing message ${msgId} on ${this.queueName}:`, error);
    
    try {
      await this.supabase.from('queue_metrics').insert({
        queue_name: this.queueName,
        msg_id: msgId,
        status: 'error',
        details: { 
          error: error.message,
          category: error.category,
          retryable: error.retryable,
          time: new Date().toISOString(),
          worker_instance: this.getWorkerId()
        }
      });
    } catch (err) {
      console.error(`Failed to log error for message ${msgId}:`, err);
      // Non-critical, continue
    }
  }

  // Main runner method - read one, process, ack if success, handle errors
  async run(): Promise<void> {
    console.log(`Running page-worker for queue: ${this.queueName}`);
    this.startTime = Date.now();
    
    const message = await this.readOne();
    if (!message) {
      console.log(`No message to process for queue: ${this.queueName}`);
      return;
    }
    
    const { msgId, msg, readCt } = message;
    
    try {
      console.log(`Processing message ${msgId} from queue ${this.queueName}`);
      
      // Apply timeout to processing
      const timeout = 30000; // 30 second timeout
      const processPromise = this.process(msg);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Processing timed out after ${timeout}ms`)), timeout);
      });
      
      await Promise.race([processPromise, timeoutPromise]);
      await this.ack(msgId);
    } catch (err) {
      console.error(`Error processing msg ${msgId} on ${this.queueName}:`, err);
      
      const error = this.categorizeError(err);
      
      // If too many retries or non-retryable error, move to dead-letter
      if (readCt >= 5 || !error.retryable) {
        await this.moveToDeadLetter(msgId, msg, readCt + 1, error);
      } else {
        // Log the error and leave the message (it will reappear after vt)
        await this.logError(msgId, error);
      }
    }
  }

  // Helper method to categorize errors
  protected categorizeError(err: any): ErrorDetails {
    const errorMessage = err.message || String(err);
    
    // Network/connection errors
    if (
      errorMessage.includes('Failed to fetch') || 
      errorMessage.includes('network error') ||
      err.name === 'AbortError'
    ) {
      return {
        category: ErrorCategory.NETWORK,
        retryable: true,
        message: errorMessage,
        originalError: err
      };
    }
    
    // Timeout errors
    if (
      errorMessage.includes('timed out') || 
      errorMessage.includes('timeout')
    ) {
      return {
        category: ErrorCategory.TIMEOUT,
        retryable: true,
        message: errorMessage,
        originalError: err
      };
    }
    
    // Auth errors
    if (
      err.status === 401 ||
      err.status === 403 ||
      errorMessage.includes('unauthorized') ||
      errorMessage.includes('forbidden')
    ) {
      return {
        category: ErrorCategory.AUTH,
        retryable: false, // Auth errors generally need manual intervention
        message: errorMessage,
        originalError: err
      };
    }
    
    // Rate limit errors
    if (
      err.status === 429 ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('too many requests')
    ) {
      return {
        category: ErrorCategory.RATE_LIMIT,
        retryable: true,
        message: errorMessage,
        originalError: err
      };
    }
    
    // Not found errors
    if (err.status === 404) {
      return {
        category: ErrorCategory.NOT_FOUND,
        retryable: false, // Not found usually doesn't fix itself
        message: errorMessage,
        originalError: err
      };
    }
    
    // Default - unknown error, generally retryable
    return {
      category: ErrorCategory.UNKNOWN,
      retryable: true,
      message: errorMessage,
      originalError: err
    };
  }
  
  // Generate a unique worker ID for tracking in logs
  private getWorkerId(): string {
    if (!this._workerId) {
      this._workerId = `${this.queueName}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    }
    return this._workerId;
  }
  private _workerId: string | undefined;
}
