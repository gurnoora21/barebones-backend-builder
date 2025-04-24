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

// Trace context for distributed tracing
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentId?: string;
  serviceName: string;
  operationName: string;
  timestamp: number;
  attributes: Record<string, string | number | boolean>;
}

export abstract class PageWorker<Msg> {
  protected supabase: SupabaseClient<Database>;
  protected queueName: string;
  protected vtSeconds: number;
  protected startTime: number;
  protected traceContext?: TraceContext;
  private _workerId: string | undefined;

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
  async readOne(): Promise<{ msgId: number; msg: Msg; readCt: number; traceContext?: TraceContext } | null> {
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
      
      // Extract trace context if present in the message
      let extractedTraceContext: TraceContext | undefined;
      if (typeof msg === 'object' && msg !== null && 'traceContext' in msg) {
        extractedTraceContext = (msg as any).traceContext;
      }
      
      return {
        msgId: row.msg_id,
        msg: msg,
        readCt: row.read_ct,
        traceContext: extractedTraceContext
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
          worker_instance: this.getWorkerId(),
          trace_id: this.traceContext?.traceId
        }
      });
      
      console.log(`Successfully archived message ${msgId} from queue ${this.queueName} in ${processingTime}ms`);
    } catch (err) {
      console.error(`Failed to acknowledge message ${msgId}:`, err);
      // We'll still consider the message processed, but the ack failed
      // It will eventually reappear in the queue after VT expires
    }
  }

  // Enqueue a new message to any queue with trace context propagation
  async enqueue(queueName: string, msg: any): Promise<number> {
    try {
      // Propagate trace context if available
      const messageWithTracing = this.traceContext ? {
        ...msg,
        traceContext: {
          ...this.traceContext,
          parentId: this.traceContext.spanId,
          spanId: this.generateSpanId(),
          timestamp: Date.now()
        }
      } : msg;
      
      const { data, error } = await this.supabase.rpc('pgmq_send', {
        queue_name: queueName,
        msg: messageWithTracing
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
          worker_instance: this.getWorkerId(),
          trace_id: this.traceContext?.traceId
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
          worker_instance: this.getWorkerId(),
          trace_id: this.traceContext?.traceId
        }
      });
    } catch (err) {
      console.error(`Failed to log error for message ${msgId}:`, err);
      // Non-critical, continue
    }
  }

  // Execute an operation with tracing
  protected async traceOperation<T>(
    operationName: string, 
    fn: () => Promise<T>
  ): Promise<T> {
    const startTime = Date.now();
    
    // Create a new span for this operation
    const spanId = this.generateSpanId();
    const operationContext: TraceContext = {
      traceId: this.traceContext?.traceId || this.generateTraceId(),
      spanId: spanId,
      parentId: this.traceContext?.spanId,
      serviceName: this.queueName,
      operationName: operationName,
      timestamp: startTime,
      attributes: {
        workerId: this.getWorkerId()
      }
    };
    
    // Save the previous context so we can restore it
    const previousContext = this.traceContext;
    this.traceContext = operationContext;
    
    // Log start of operation
    console.log(`[Trace:${operationContext.traceId}:${operationContext.spanId}] Starting operation: ${operationName}`);
    
    try {
      // Execute the operation
      const result = await fn();
      
      // Log successful completion
      const duration = Date.now() - startTime;
      console.log(`[Trace:${operationContext.traceId}:${operationContext.spanId}] Completed operation: ${operationName} in ${duration}ms`);
      
      // Store trace in database for analysis
      await this.recordTrace(operationContext, {
        status: "success",
        duration_ms: duration
      });
      
      return result;
    } catch (error) {
      // Log error
      const duration = Date.now() - startTime;
      console.error(`[Trace:${operationContext.traceId}:${operationContext.spanId}] Failed operation: ${operationName} after ${duration}ms:`, error);
      
      // Store trace with error
      await this.recordTrace(operationContext, {
        status: "error",
        duration_ms: duration,
        error: error.message || String(error)
      });
      
      throw error;
    } finally {
      // Restore previous context
      this.traceContext = previousContext;
    }
  }

  // Record a trace in the database
  private async recordTrace(context: TraceContext, details: any): Promise<void> {
    try {
      await this.supabase.from('traces').insert({
        trace_id: context.traceId,
        span_id: context.spanId,
        parent_id: context.parentId,
        service: context.serviceName,
        operation: context.operationName,
        timestamp: new Date(context.timestamp).toISOString(),
        attributes: context.attributes,
        details: details
      });
    } catch (error) {
      // Don't fail if we can't record the trace
      console.error("Failed to record trace:", error);
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
    
    const { msgId, msg, readCt, traceContext } = message;
    
    // Initialize or propagate trace context
    this.traceContext = traceContext || {
      traceId: this.generateTraceId(),
      spanId: this.generateSpanId(),
      serviceName: this.queueName,
      operationName: 'process',
      timestamp: Date.now(),
      attributes: {
        workerId: this.getWorkerId(),
        msgId: String(msgId),
        readCt: String(readCt)
      }
    };
    
    console.log(`[Trace:${this.traceContext.traceId}] Processing message ${msgId} from queue ${this.queueName}`);
    
    try {
      await this.traceOperation('process', async () => {
        // Apply timeout to processing
        const timeout = 30000; // 30 second timeout
        const processPromise = this.process(msg);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Processing timed out after ${timeout}ms`)), timeout);
        });
        
        await Promise.race([processPromise, timeoutPromise]);
      });
      
      await this.ack(msgId);
    } catch (err) {
      console.error(`[Trace:${this.traceContext.traceId}] Error processing msg ${msgId} on ${this.queueName}:`, err);
      
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
  protected getWorkerId(): string {
    if (!this._workerId) {
      this._workerId = `${this.queueName}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    }
    return this._workerId;
  }
  
  // Generate a unique trace ID
  protected generateTraceId(): string {
    return crypto.randomUUID();
  }
  
  // Generate a unique span ID
  protected generateSpanId(): string {
    return Math.random().toString(36).substring(2, 16);
  }
}
