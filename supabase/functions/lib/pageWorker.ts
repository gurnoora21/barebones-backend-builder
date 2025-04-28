import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';
import { globalCache } from './cache.ts';
import { CircuitBreakerRegistry, CircuitState } from './circuitBreaker.ts';
import { BatchProcessor, BatchStats } from './batchProcessor.ts';

// Enhanced error categorization
export enum ErrorCategory {
  NETWORK = 'network',
  TIMEOUT = 'timeout',
  AUTH = 'authorization',
  VALIDATION = 'validation',
  RATE_LIMIT = 'rate_limit',
  NOT_FOUND = 'not_found',
  UNKNOWN = 'unknown',
  MISSING_RECORD = 'missing_record',
  UNKNOWN_PRODUCER = 'unknown_producer',
  DATABASE_ERROR = 'database_error',
  CONNECTION_ERROR = 'connection_error',
  TRANSIENT_ERROR = 'transient_error',
  PERMANENT_ERROR = 'permanent_error'
}

export interface ErrorDetails {
  category: ErrorCategory;
  retryable: boolean; // Whether this error can be retried
  message: string;
  originalError?: Error;
  stack?: string;
  context?: Record<string, any>;
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

// Enhanced DLQ handling options
export interface DLQOptions {
  maxRetries: number;         // Maximum retries before sending to DLQ
  retryDelayBaseMs: number;   // Base delay for retries (will be multiplied by retry count)
  categorizeForAutoRetry?: (error: ErrorDetails) => boolean; // Function to determine if error should be auto-retried
}

export abstract class PageWorker<Msg> {
  protected supabase: SupabaseClient<Database>;
  protected queueName: string;
  protected vtSeconds: number;
  protected startTime: number;
  protected traceContext?: TraceContext;
  private _workerId: string | undefined;
  protected dlqOptions: DLQOptions;
  private batchProcessor: BatchProcessor<Msg>;

  constructor(queueName: string, vtSeconds = 60, dlqOptions?: Partial<DLQOptions>) {
    this.queueName = queueName;
    this.vtSeconds = vtSeconds;
    this.startTime = Date.now();
    
    // Default DLQ options
    this.dlqOptions = {
      maxRetries: 5,
      retryDelayBaseMs: 1000,
      ...dlqOptions
    };
    
    // Initialize Supabase client with service role key
    this.supabase = createClient<Database>(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );
    
    this.batchProcessor = new BatchProcessor(this.supabase, {
      concurrency: 3,
      batchSize: 10
    });
  }

  // New method for batch processing
  async readBatch(): Promise<BatchStats> {
    console.log(`Reading batch of messages from queue: ${this.queueName}`);
    
    return this.batchProcessor.processBatch(
      this.queueName,
      async (messages) => {
        await Promise.all(messages.map(msg => this.process(msg)));
      },
      this.vtSeconds
    );
  }

  // Original readOne method remains for compatibility
  async readOne(): Promise<{ msgId: number; msg: Msg; readCt: number; traceContext?: TraceContext } | null> {
    console.log(`Reading one message from queue: ${this.queueName}`);
    
    try {
      const { data, error } = await this.supabase.rpc('pgmq_read', {
        queue_name: this.queueName,
        visibility_timeout: this.vtSeconds,
        batch_size: 1
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
      
      // Log queue metrics
      await this.logQueueMetric('dequeued', row.msg_id, {
        read_count: row.read_ct,
        queue_name: this.queueName,
        worker_id: this.getWorkerId(),
        dequeue_time: Date.now(),
        trace_id: extractedTraceContext?.traceId
      });
      
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
      if (categorizedError.category === ErrorCategory.NETWORK || 
          categorizedError.category === ErrorCategory.CONNECTION_ERROR) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      
      throw categorizedError;
    }
  }

  // Update run method to support both single and batch processing
  async run(useBatch = true): Promise<void> {
    console.log(`Running page-worker for queue: ${this.queueName} (batch mode: ${useBatch})`);
    this.startTime = Date.now();
    
    if (useBatch) {
      const stats = await this.readBatch();
      console.log(`Batch processing complete for ${this.queueName}:`, stats);
    } else {
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
        // Use circuit breaker pattern for processing
        const circuitBreaker = CircuitBreakerRegistry.getOrCreate({
          name: `queue-${this.queueName}`,
          failureThreshold: 5,
          resetTimeoutMs: 60000 // 1 minute
        });
        
        await circuitBreaker.fire(async () => {
          await this.traceOperation('process', async () => {
            // Apply timeout to processing
            const timeout = 30000; // 30 second timeout
            const processPromise = this.process(msg);
            const timeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error(`Processing timed out after ${timeout}ms`)), timeout);
            });
            
            await Promise.race([processPromise, timeoutPromise]);
          });
        });
        
        await this.ack(msgId);
      } catch (err) {
        console.error(`[Trace:${this.traceContext.traceId}] Error processing msg ${msgId} on ${this.queueName}:`, err);
        
        const error = this.categorizeError(err);
        
        // If too many retries or non-retryable error, move to dead-letter
        if (readCt >= this.dlqOptions.maxRetries || !error.retryable) {
          await this.moveToDeadLetter(msgId, msg, readCt + 1, error);
        } else {
          // Check if this error category should be auto-retried based on custom logic
          const shouldAutoRetry = this.dlqOptions.categorizeForAutoRetry ? 
            this.dlqOptions.categorizeForAutoRetry(error) :
            this.shouldRetryError(error);
            
          if (shouldAutoRetry) {
            // Calculate exponential backoff
            const delayMs = this.dlqOptions.retryDelayBaseMs * Math.pow(2, Math.min(readCt, 8));
            console.log(`Scheduling retry for message ${msgId} with backoff delay ${delayMs}ms`);
            
            // We could implement a delayed retry here if the queue supports it
            // For now, we just log and let the VT expire
            await this.logError(msgId, {
              ...error,
              context: {
                ...(error.context || {}),
                retry_count: readCt,
                next_retry_delay_ms: delayMs
              }
            });
          } else {
            // Not eligible for auto-retry, move to dead letter
            await this.moveToDeadLetter(msgId, msg, readCt + 1, {
              ...error,
              context: {
                ...(error.context || {}),
                retry_ineligible: true,
                retry_count: readCt
              }
            });
          }
        }
      }
    }
  }

  // Process a single message (to be implemented by subclass)
  protected abstract process(msg: Msg): Promise<void>;

  // Validate message schema (can be overridden by subclasses)
  protected validateMessage(msg: Msg): boolean {
    // Basic validation - ensure msg is not null/undefined
    // Subclasses should implement more specific validation
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
      
      // Log queue metrics
      await this.logQueueMetric('completed', msgId, {
        status: 'success',
        queue_name: this.queueName,
        worker_id: this.getWorkerId(),
        processing_time_ms: processingTime,
        trace_id: this.traceContext?.traceId
      });
      
      console.log(`Successfully archived message ${msgId} from queue ${this.queueName} in ${processingTime}ms`);
    } catch (err) {
      console.error(`Failed to acknowledge message ${msgId}:`, err);
      // We'll still consider the message processed, but the ack failed
      // It will eventually reappear in the queue after VT expires
    }
  }

  // Log queue monitoring metrics
  private async logQueueMetric(action: string, msgId: number, details: any): Promise<void> {
    try {
      await this.supabase.from('queue_depth_metrics').insert({
        queue_name: this.queueName,
        msg_id: msgId,
        action,
        details: {
          ...details,
          timestamp: new Date().toISOString()
        }
      });
    } catch (err) {
      // Don't fail if we can't log metrics
      console.error(`Failed to log queue metric for ${action}:`, err);
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
      
      // Log queue metrics
      await this.logQueueMetric('enqueued', data, {
        source_queue: this.queueName,
        target_queue: queueName,
        worker_id: this.getWorkerId(),
        enqueue_time: Date.now(),
        trace_id: this.traceContext?.traceId
      });
      
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
      // Enhanced DLQ entry with more context
      await this.supabase.from('pgmq_dead_letter_items').insert({
        queue_name: this.queueName,
        msg: msg,
        fail_count: readCt,
        details: { 
          error: error.message,
          category: error.category,
          stack: error.stack || new Error().stack,
          context: error.context || {},
          retryable: error.retryable,
          time: new Date().toISOString(),
          worker_instance: this.getWorkerId(),
          trace_id: this.traceContext?.traceId
        }
      });
      
      // Archive the message so it doesn't reappear in the queue
      await this.ack(msgId);
      
      // Log queue metrics
      await this.logQueueMetric('dead_letter', msgId, {
        queue_name: this.queueName,
        fail_count: readCt,
        error_category: error.category,
        worker_id: this.getWorkerId(),
        trace_id: this.traceContext?.traceId
      });
      
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
          stack: error.stack || new Error().stack,
          context: error.context || {},
          retryable: error.retryable,
          time: new Date().toISOString(),
          worker_instance: this.getWorkerId(),
          trace_id: this.traceContext?.traceId
        }
      });
      
      // Log queue metrics
      if (msgId > 0) {
        await this.logQueueMetric('error', msgId, {
          queue_name: this.queueName,
          error_category: error.category,
          retryable: error.retryable,
          worker_id: this.getWorkerId(),
          trace_id: this.traceContext?.traceId
        });
      }
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
        error: error.message || String(error),
        error_category: error.category || ErrorCategory.UNKNOWN,
        stack: error.stack || new Error().stack
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

  // Determine if an error should be retried based on its category
  protected shouldRetryError(error: ErrorDetails): boolean {
    // By default, follow the retryable flag on the error
    if (error.retryable !== undefined) {
      return error.retryable;
    }
    
    // Default retry strategy based on error category
    switch (error.category) {
      case ErrorCategory.NETWORK:
      case ErrorCategory.TIMEOUT:
      case ErrorCategory.RATE_LIMIT:
      case ErrorCategory.CONNECTION_ERROR:
      case ErrorCategory.TRANSIENT_ERROR:
        return true;
      case ErrorCategory.AUTH:
      case ErrorCategory.VALIDATION:
      case ErrorCategory.NOT_FOUND:
      case ErrorCategory.MISSING_RECORD:
      case ErrorCategory.PERMANENT_ERROR:
        return false;
      case ErrorCategory.UNKNOWN:
      default:
        return true; // Default to retry for unknown errors
    }
  }

  // Helper method to categorize errors
  protected categorizeError(err: any): ErrorDetails {
    const originalError = this.defaultCategorizeError(err);

    // Add more specific error categorization
    if (err.message?.includes('No record found') || 
        err.code === 'PGRST116') {
      return {
        ...originalError,
        category: ErrorCategory.MISSING_RECORD,
        retryable: false
      };
    }
    
    if (err.message?.includes('Rate limit exceeded') ||
        err.status === 429) {
      return {
        ...originalError, 
        category: ErrorCategory.RATE_LIMIT,
        retryable: true,
        context: {
          retry_after: err.headers?.['retry-after'] || 60
        }
      };
    }
    
    if (err.message?.includes('Connection') ||
        err.message?.includes('network')) {
      return {
        ...originalError,
        category: ErrorCategory.CONNECTION_ERROR,
        retryable: true
      };
    }
    
    if (err.code?.startsWith('23') || // Postgres integrity violation
        err.message?.includes('duplicate key')) {
      return {
        ...originalError,
        category: ErrorCategory.DATABASE_ERROR,
        retryable: false,
        context: {
          pg_code: err.code
        }
      };
    }

    // You can add more specific error categorizations here
    return originalError;
  }

  // Extract the original categorizeError logic into a method
  private defaultCategorizeError(err: any): ErrorDetails {
    const errorMessage = err.message || String(err);
    const errorStack = err.stack || new Error().stack;
    
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
        stack: errorStack,
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
        stack: errorStack,
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
        stack: errorStack,
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
        stack: errorStack,
        originalError: err,
        context: {
          retry_after: err.headers?.['retry-after'] || 60
        }
      };
    }
    
    // Not found errors
    if (err.status === 404) {
      return {
        category: ErrorCategory.NOT_FOUND,
        retryable: false, // Not found usually doesn't fix itself
        message: errorMessage,
        stack: errorStack,
        originalError: err
      };
    }
    
    // Default - unknown error, generally retryable
    return {
      category: ErrorCategory.UNKNOWN,
      retryable: true,
      message: errorMessage,
      stack: errorStack,
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

  // Enhanced metadata tracking for producers
  protected mergeMetadata(
    existingMetadata: any, 
    newMetadata: any, 
    role: string = 'producer'
  ): any {
    const mergedMetadata = { ...existingMetadata };

    // Merge external IDs
    if (newMetadata.external_ids) {
      mergedMetadata.external_ids = [
        ...new Set([
          ...(existingMetadata?.external_ids || []), 
          ...newMetadata.external_ids
        ])
      ];
    }

    // Add roles if not already present
    if (role === 'collaborator' || role === 'producer') {
      const roles = new Set(existingMetadata?.roles || []);
      roles.add(role);
      mergedMetadata.roles = Array.from(roles);
    }

    // Merge other metadata fields
    return {
      ...mergedMetadata,
      ...newMetadata,
      sources: [
        ...(existingMetadata?.sources || []),
        ...(newMetadata.sources || [])
      ]
    };
  }
  
  // Utility method for handling retryable operations with exponential backoff
  protected async withRetry<T>(
    operation: () => Promise<T>,
    options: {
      name: string;
      maxRetries?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
    }
  ): Promise<T> {
    const { name, maxRetries = 3, baseDelayMs = 200, maxDelayMs = 10000 } = options;
    let lastError: any;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const categorizedError = this.categorizeError(error);
        
        // Don't retry non-retryable errors
        if (!categorizedError.retryable) {
          console.error(`Non-retryable error in ${name}, giving up:`, categorizedError);
          throw error;
        }
        
        if (attempt < maxRetries) {
          // Calculate exponential backoff with jitter
          const delay = Math.min(
            maxDelayMs,
            baseDelayMs * Math.pow(2, attempt) * (0.8 + Math.random() * 0.4)
          );
          
          console.log(`Retrying ${name} after error, attempt ${attempt + 1}/${maxRetries}, delay: ${delay}ms:`, categorizedError.message);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    console.error(`${name} failed after ${maxRetries} retries`);
    throw lastError;
  }
}
