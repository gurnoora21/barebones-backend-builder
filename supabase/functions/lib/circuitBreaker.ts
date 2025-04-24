
// Circuit breaker pattern implementation
// Prevents calling failing services repeatedly

export enum CircuitState {
  CLOSED = 'closed',   // Normal operation - requests go through
  OPEN = 'open',       // Circuit is tripped - requests fail fast
  HALF_OPEN = 'half-open' // Testing if service is back - allows one request
}

export interface CircuitBreakerOptions {
  name: string;         // Name of the service/endpoint
  failureThreshold: number; // How many failures before opening
  resetTimeoutMs: number;   // How long circuit stays open before trying again
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private options: CircuitBreakerOptions;
  
  constructor(options: CircuitBreakerOptions) {
    this.options = {
      failureThreshold: 5,
      resetTimeoutMs: 30000, // 30s default
      ...options
    };
  }
  
  // Execute an action through the circuit breaker
  async fire<T>(action: () => Promise<T>): Promise<T> {
    // If circuit is open, check if we should try half-open
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      // Check if timeout elapsed to try a new request
      if (now - this.lastFailureTime > this.options.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        console.log(`Circuit ${this.options.name} entering half-open state`);
      } else {
        // Still open, fail fast
        throw new Error(`Circuit ${this.options.name} is open; failing fast`);
      }
    }
    
    try {
      const result = await action();
      
      // Success - close the circuit if it was half-open
      if (this.state === CircuitState.HALF_OPEN) {
        this.reset();
        console.log(`Circuit ${this.options.name} closed after successful test`);
      }
      
      return result;
    } catch (error) {
      this.handleFailure();
      throw error;
    }
  }
  
  private handleFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    // Trip the circuit if we hit the threshold
    if (
      this.state === CircuitState.CLOSED && 
      this.failureCount >= this.options.failureThreshold
    ) {
      this.state = CircuitState.OPEN;
      console.log(`Circuit ${this.options.name} opened after ${this.failureCount} failures`);
    } else if (this.state === CircuitState.HALF_OPEN) {
      // If failed during test, reopen the circuit
      this.state = CircuitState.OPEN;
      console.log(`Circuit ${this.options.name} reopened after failed test`);
    }
  }
  
  // Reset the circuit to closed state
  reset(): void {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }
  
  // Get current state
  getState(): CircuitState {
    return this.state;
  }
}

// Global registry to manage circuit breakers
export class CircuitBreakerRegistry {
  private static circuits: Map<string, CircuitBreaker> = new Map();
  
  static getOrCreate(options: CircuitBreakerOptions): CircuitBreaker {
    if (!this.circuits.has(options.name)) {
      this.circuits.set(options.name, new CircuitBreaker(options));
    }
    return this.circuits.get(options.name)!;
  }
  
  static reset(name: string): void {
    const circuit = this.circuits.get(name);
    if (circuit) {
      circuit.reset();
    }
  }
}
