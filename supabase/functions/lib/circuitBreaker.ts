
// Enhanced circuit breaker pattern implementation with distributed state
// Prevents calling failing services repeatedly while providing better observability

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
  
  constructor(options: CircuitBreakerOptions, supabaseClient?: any) {
    this.options = {
      failureThreshold: 5,
      resetTimeoutMs: 30000, // 30s default
      halfOpenSuccessThreshold: 2,
      ...options
    };
    this.supabase = supabaseClient;
  }
  
  // Execute an action through the circuit breaker
  async fire<T>(action: () => Promise<T>): Promise<T> {
    // If we have Supabase client, sync state from storage first
    if (this.supabase) {
      await this.syncStateFromStorage();
    }
    
    // If circuit is open, check if we should try half-open
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      // Check if timeout elapsed to try a new request
      if (now - this.lastFailureTime > this.options.resetTimeoutMs) {
        await this.changeState(CircuitState.HALF_OPEN);
        console.log(`Circuit ${this.options.name} entering half-open state`);
      } else {
        // Still open, fail fast
        throw new Error(`Circuit ${this.options.name} is open; failing fast until ${new Date(this.lastFailureTime + this.options.resetTimeoutMs).toISOString()}`);
      }
    }
    
    try {
      const startTime = Date.now();
      const result = await action();
      const duration = Date.now() - startTime;
      
      // Log success metric
      this.logExecution(true, duration);
      
      // Success - update counters and possibly close the circuit if it was half-open
      if (this.state === CircuitState.HALF_OPEN) {
        this.successCount++;
        if (this.successCount >= (this.options.halfOpenSuccessThreshold || 1)) {
          await this.reset();
          console.log(`Circuit ${this.options.name} closed after ${this.successCount} successful tests`);
        }
      }
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logExecution(false, duration, error);
      await this.handleFailure();
      throw error;
    }
  }
  
  private async handleFailure(): Promise<void> {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    // Trip the circuit if we hit the threshold
    if (
      this.state === CircuitState.CLOSED && 
      this.failureCount >= this.options.failureThreshold
    ) {
      await this.changeState(CircuitState.OPEN);
      console.log(`Circuit ${this.options.name} opened after ${this.failureCount} failures`);
    } else if (this.state === CircuitState.HALF_OPEN) {
      // If failed during test, reopen the circuit
      await this.changeState(CircuitState.OPEN);
      console.log(`Circuit ${this.options.name} reopened after failed test`);
      this.successCount = 0;
    }
    
    // Sync state to storage if available
    if (this.supabase) {
      await this.syncStateToStorage();
    }
  }
  
  // Reset the circuit to closed state
  async reset(): Promise<void> {
    this.failureCount = 0;
    this.successCount = 0;
    await this.changeState(CircuitState.CLOSED);
    
    // Sync state to storage if available
    if (this.supabase) {
      await this.syncStateToStorage();
    }
  }
  
  // Change circuit state with proper logging
  private async changeState(newState: CircuitState): Promise<void> {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();
    
    // Log state change
    console.log(`Circuit ${this.options.name} state changed from ${oldState} to ${newState}`);
    
    // Log state change to database if we have a client
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
              reset_timeout_ms: this.options.resetTimeoutMs,
              last_failure: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null
            }
          });
      } catch (err) {
        console.error(`Failed to log circuit state change to database: ${err}`);
      }
    }
  }
  
  // Log execution result for monitoring
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
        console.error(`Failed to log circuit execution: ${err}`);
      }
    }
  }
  
  // Sync circuit state from storage
  private async syncStateFromStorage(): Promise<void> {
    try {
      const { data, error } = await this.supabase
        .from('circuit_breakers')
        .select('*')
        .eq('name', this.options.name)
        .maybeSingle();
        
      if (error) {
        console.error(`Error fetching circuit state: ${error.message}`);
        return;
      }
      
      if (data) {
        this.state = data.state as CircuitState;
        this.failureCount = data.failure_count;
        this.successCount = data.success_count;
        this.lastFailureTime = new Date(data.last_failure_time).getTime();
        this.lastStateChange = new Date(data.last_state_change).getTime();
        
        // Automatically try half-open if we've passed the timeout
        if (this.state === CircuitState.OPEN && 
            Date.now() - this.lastFailureTime > this.options.resetTimeoutMs) {
          await this.changeState(CircuitState.HALF_OPEN);
        }
      }
    } catch (err) {
      console.error(`Error syncing circuit state from storage: ${err}`);
    }
  }
  
  // Sync circuit state to storage
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
          reset_timeout_ms: this.options.resetTimeoutMs,
          last_failure_time: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
          last_state_change: new Date(this.lastStateChange).toISOString()
        });
    } catch (err) {
      console.error(`Error syncing circuit state to storage: ${err}`);
    }
  }
  
  // Get current state
  getState(): CircuitState {
    return this.state;
  }
  
  // Get detailed status
  getStatus(): any {
    return {
      name: this.options.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      failureThreshold: this.options.failureThreshold,
      resetTimeoutMs: this.options.resetTimeoutMs,
      lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
      lastStateChange: new Date(this.lastStateChange).toISOString(),
      timeInCurrentState: Date.now() - this.lastStateChange
    };
  }
}

// Enhanced registry to manage circuit breakers with DB persistence
export class CircuitBreakerRegistry {
  private static circuits: Map<string, CircuitBreaker> = new Map();
  private static supabaseClient: any = null;
  
  static setSupabaseClient(client: any): void {
    this.supabaseClient = client;
  }
  
  static getOrCreate(options: CircuitBreakerOptions): CircuitBreaker {
    if (!this.circuits.has(options.name)) {
      const circuit = new CircuitBreaker(options, this.supabaseClient);
      this.circuits.set(options.name, circuit);
    }
    return this.circuits.get(options.name)!;
  }
  
  static async reset(name: string): Promise<void> {
    const circuit = this.circuits.get(name);
    if (circuit) {
      await circuit.reset();
    }
  }
  
  static async getAllStatuses(): Promise<any[]> {
    return Array.from(this.circuits.values()).map(circuit => circuit.getStatus());
  }
  
  // Load all circuit breakers from database
  static async loadFromStorage(): Promise<void> {
    if (!this.supabaseClient) {
      console.log('No Supabase client provided, skipping loading circuit breakers from storage');
      return;
    }
    
    try {
      const { data, error } = await this.supabaseClient
        .from('circuit_breakers')
        .select('*');
        
      if (error) {
        console.error(`Error loading circuit breakers: ${error.message}`);
        return;
      }
      
      if (data) {
        for (const record of data) {
          const options: CircuitBreakerOptions = {
            name: record.name,
            failureThreshold: record.failure_threshold,
            resetTimeoutMs: record.reset_timeout_ms
          };
          
          this.getOrCreate(options);
        }
        console.log(`Loaded ${data.length} circuit breakers from database`);
      }
    } catch (err) {
      console.error(`Error loading circuit breakers from storage: ${err}`);
    }
  }
}
