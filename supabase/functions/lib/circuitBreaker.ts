import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { logger } from "./logger.ts";
import { wait, getRetryDelayFromHeaders } from "./retry.ts";

export enum CircuitState {
  CLOSED = 'closed',   // Normal operation - requests go through
  OPEN = 'open',       // Circuit is tripped - requests fail fast
  HALF_OPEN = 'half-open' // Testing if service is back - allows one request
}

export interface CircuitBreakerOptions {
  name: string;         // Name of the service/endpoint
  failureThreshold: number; // How many failures before opening
  resetTimeoutMs: number;   // How long circuit stays open before trying again
  halfOpenSuccessThreshold?: number; // How many successes in half-open before closing
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private lastStateChange: number = Date.now();
  private options: CircuitBreakerOptions;
  private supabase: any;
  private logger = logger.child({ component: 'CircuitBreaker' });
  private lastRequestTime: number = 0;
  private customResetTimeout: number | null = null;
  
  constructor(options: CircuitBreakerOptions, supabaseClient?: any) {
    this.options = {
      failureThreshold: 5,
      resetTimeoutMs: 30000, // 30s default
      halfOpenSuccessThreshold: 2,
      ...options
    };
    this.supabase = supabaseClient;
    
    // Auto-initialize from database if supabase client is provided
    if (this.supabase) {
      this.syncStateFromStorage().catch(err => {
        this.logger.error(`Error initializing circuit breaker from database`, err);
      });
    }
  }
  
  async fire<T>(action: () => Promise<T>): Promise<T> {
    const startTime = Date.now();
    const operationLogger = this.logger.child({ 
      circuit: this.options.name, 
      state: this.state 
    });
    
    if (this.supabase) {
      await this.syncStateFromStorage();
    }
    
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      // Use customResetTimeout if set (from Retry-After headers)
      const resetTimeoutMs = this.customResetTimeout || this.options.resetTimeoutMs;
      
      if (now - this.lastFailureTime > resetTimeoutMs) {
        await this.changeState(CircuitState.HALF_OPEN);
        operationLogger.info(`Circuit ${this.options.name} entering half-open state`);
      } else {
        const remainingMs = this.lastFailureTime + resetTimeoutMs - now;
        operationLogger.debug(`Circuit ${this.options.name} is open; failing fast`, { 
          remainingMs,
          resetAt: new Date(this.lastFailureTime + resetTimeoutMs).toISOString()
        });
        
        throw new Error(`Circuit ${this.options.name} is open; failing fast until ${new Date(this.lastFailureTime + resetTimeoutMs).toISOString()}`);
      }
    }
    
    // For HALF_OPEN state, ensure requests are properly spaced
    if (this.state === CircuitState.HALF_OPEN) {
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      
      // Only allow one request every 10 seconds in HALF_OPEN state
      if (timeSinceLastRequest < 10000) {
        const waitTime = 10000 - timeSinceLastRequest;
        operationLogger.debug(`Waiting ${waitTime}ms before next half-open test`);
        await wait(waitTime);
      }
      
      this.lastRequestTime = Date.now();
    }
    
    try {
      const result = await action();
      const duration = Date.now() - startTime;
      
      await this.logExecution(true, duration);
      
      if (this.state === CircuitState.HALF_OPEN) {
        this.successCount++;
        if (this.successCount >= (this.options.halfOpenSuccessThreshold || 1)) {
          await this.reset();
          operationLogger.info(`Circuit ${this.options.name} closed after ${this.successCount} successful tests`);
        }
      }
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.logExecution(false, duration, error);
      await this.handleFailure(error);
      throw error;
    }
  }
  
  // New method to record a failure from response for rate limits
  async recordFailure(response: Response): Promise<void> {
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        // Parse the retry delay from headers
        const retryDelayMs = getRetryDelayFromHeaders(response.headers);
        
        if (retryDelayMs) {
          // Set custom reset timeout based on Retry-After
          this.customResetTimeout = retryDelayMs;
          this.logger.info(`Setting custom reset timeout for ${this.options.name}: ${retryDelayMs}ms`);
        }
      }
    }
    
    await this.handleFailure();
  }
  
  private async handleFailure(error?: any): Promise<void> {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    const isRateLimitError = error && (
      error.status === 429 || 
      (error.message && error.message.includes('rate limit'))
    );
    
    if (
      (this.state === CircuitState.CLOSED && this.failureCount >= this.options.failureThreshold) ||
      (this.state === CircuitState.CLOSED && isRateLimitError && this.options.name.includes('rate-limit'))
    ) {
      await this.changeState(CircuitState.OPEN);
      this.logger.warn(`Circuit ${this.options.name} opened after ${this.failureCount} failures`);
    } else if (this.state === CircuitState.HALF_OPEN) {
      await this.changeState(CircuitState.OPEN);
      this.logger.warn(`Circuit ${this.options.name} reopened after failed test`);
      this.successCount = 0;
    }
    
    if (this.supabase) {
      await this.syncStateToStorage();
    }
  }
  
  async reset(): Promise<void> {
    this.failureCount = 0;
    this.successCount = 0;
    this.customResetTimeout = null;  // Reset custom timeout
    await this.changeState(CircuitState.CLOSED);
    
    if (this.supabase) {
      await this.syncStateToStorage();
    }
  }
  
  private async changeState(newState: CircuitState): Promise<void> {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();
    
    this.logger.info(`Circuit ${this.options.name} state changed from ${oldState} to ${newState}`);
    
    if (this.supabase) {
      try {
        await this.supabase
          .from('circuit_breaker_events')
          .insert({
            circuit_name: this.options.name,
            old_state: oldState,
            new_state: newState,
            failure_count: this.failureCount,
            details: {
              threshold: this.options.failureThreshold,
              reset_timeout_ms: this.customResetTimeout || this.options.resetTimeoutMs,
              last_failure: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null
            }
          });
      } catch (err) {
        this.logger.error(`Failed to log circuit state change to database`, err);
      }
    }
  }
  
  private async logExecution(success: boolean, durationMs: number, error?: any): Promise<void> {
    if (this.supabase) {
      try {
        await this.supabase
          .from('circuit_breaker_executions')
          .insert({
            circuit_name: this.options.name,
            state: this.state,
            success,
            duration_ms: durationMs,
            details: error ? {
              error_message: error.message,
              error_name: error.name,
              stack: error.stack
            } : {
              success_count: this.successCount,
              failure_count: this.failureCount
            }
          });
      } catch (err) {
        this.logger.error(`Failed to log circuit execution`, err);
      }
    }
  }
  
  private async syncStateFromStorage(): Promise<void> {
    try {
      const { data, error } = await this.supabase
        .from('circuit_breakers')
        .select('*')
        .eq('name', this.options.name)
        .maybeSingle();
        
      if (error) {
        this.logger.error(`Error fetching circuit state: ${error.message}`);
        return;
      }
      
      if (data) {
        this.state = data.state as CircuitState;
        this.failureCount = data.failure_count;
        this.successCount = data.success_count;
        this.lastFailureTime = data.last_failure_time ? new Date(data.last_failure_time).getTime() : 0;
        this.lastStateChange = data.last_state_change ? new Date(data.last_state_change).getTime() : Date.now();
        
        // Automatic transition to HALF_OPEN if needed
        if (this.state === CircuitState.OPEN && 
            Date.now() - this.lastFailureTime > this.options.resetTimeoutMs) {
          await this.changeState(CircuitState.HALF_OPEN);
        }
        
        this.logger.debug(`Circuit state loaded from database`, { 
          name: this.options.name, 
          state: this.state 
        });
      } else {
        // Initialize state in database
        await this.syncStateToStorage();
      }
    } catch (err) {
      this.logger.error(`Error syncing circuit state from storage`, err);
    }
  }
  
  private async syncStateToStorage(): Promise<void> {
    try {
      await this.supabase
        .from('circuit_breakers')
        .upsert({
          name: this.options.name,
          state: this.state,
          failure_count: this.failureCount,
          success_count: this.successCount,
          failure_threshold: this.options.failureThreshold,
          reset_timeout_ms: this.customResetTimeout || this.options.resetTimeoutMs,
          last_failure_time: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
          last_state_change: new Date(this.lastStateChange).toISOString()
        });
        
      this.logger.debug(`Circuit state synchronized to database`, { 
        name: this.options.name,
        state: this.state
      });
    } catch (err) {
      this.logger.error(`Error syncing circuit state to storage`, err);
    }
  }
  
  getState(): CircuitState {
    return this.state;
  }
  
  getStatus(): any {
    return {
      name: this.options.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      failureThreshold: this.options.failureThreshold,
      resetTimeoutMs: this.customResetTimeout || this.options.resetTimeoutMs,
      lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
      lastStateChange: new Date(this.lastStateChange).toISOString(),
      timeInCurrentState: Date.now() - this.lastStateChange
    };
  }
}

export class CircuitBreakerRegistry {
  private static circuits: Map<string, CircuitBreaker> = new Map();
  private static supabaseClient: any = null;
  private static logger = logger.child({ component: 'CircuitBreakerRegistry' });
  
  static setSupabaseClient(client: any): void {
    this.supabaseClient = client;
  }
  
  static getOrCreate(options: CircuitBreakerOptions): CircuitBreaker {
    const circuitName = options.name;
    
    if (!this.circuits.has(circuitName)) {
      this.logger.debug(`Creating new circuit breaker: ${circuitName}`);
      const circuit = new CircuitBreaker(options, this.supabaseClient);
      this.circuits.set(circuitName, circuit);
    }
    
    return this.circuits.get(circuitName)!;
  }
  
  static async reset(name: string): Promise<void> {
    const circuit = this.circuits.get(name);
    if (circuit) {
      await circuit.reset();
      this.logger.info(`Circuit ${name} was manually reset`);
    } else {
      this.logger.warn(`Attempted to reset non-existent circuit: ${name}`);
    }
  }
  
  static async getAllStatuses(): Promise<any[]> {
    return Array.from(this.circuits.values()).map(circuit => circuit.getStatus());
  }
  
  static async loadFromStorage(): Promise<void> {
    if (!this.supabaseClient) {
      this.logger.info('No Supabase client provided, skipping loading circuit breakers from storage');
      return;
    }
    
    try {
      const { data, error } = await this.supabaseClient
        .from('circuit_breakers')
        .select('*');
        
      if (error) {
        this.logger.error(`Error loading circuit breakers: ${error.message}`);
        return;
      }
      
      if (data && data.length > 0) {
        for (const record of data) {
          const options: CircuitBreakerOptions = {
            name: record.name,
            failureThreshold: record.failure_threshold,
            resetTimeoutMs: record.reset_timeout_ms
          };
          
          this.getOrCreate(options);
        }
        this.logger.info(`Loaded ${data.length} circuit breakers from database`);
      }
    } catch (err) {
      this.logger.error(`Error loading circuit breakers from storage`, err);
    }
  }
}
