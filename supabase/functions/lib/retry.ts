
import { logger } from './logger.ts';

// Retry configuration options
export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs?: number;
  factor?: number; // Multiplicative factor for exponential backoff
  jitter?: boolean; // Add randomness to delay to prevent thundering herd
  retryableErrorPredicate?: (err: any) => boolean; // Function to determine if error is retryable
}

// Default retry options
const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2, // Double the delay on each retry
  jitter: true, // Apply jitter by default
};

// Error categories for handling different types of errors
export enum ErrorCategory {
  TRANSIENT, // Temporary error, retryable
  RATE_LIMIT, // Rate limit error, retryable with specific delay
  PERMANENT, // Permanent error, not retryable
  UNKNOWN // Unknown error, default to retryable
}

/**
 * Categorize errors to determine how they should be handled
 */
export function categorizeError(error: any): ErrorCategory {
  // Check error status code for HTTP errors
  const status = error.status || error.statusCode;
  
  // Permanent errors that should not be retried
  if (
    status === 400 || // Bad Request
    status === 401 || // Unauthorized
    status === 403 || // Forbidden
    status === 404 || // Not Found
    status === 405 || // Method Not Allowed
    status === 409 || // Conflict
    status === 410 || // Gone
    status === 412 || // Precondition Failed
    status === 413 || // Payload Too Large
    status === 415 || // Unsupported Media Type
    status === 422 || // Unprocessable Entity
    status === 431 || // Request Header Fields Too Large
    (status >= 400 && status < 500 && status !== 429) // Other 4xx errors except rate limit
  ) {
    return ErrorCategory.PERMANENT;
  }
  
  // Rate limiting errors
  if (status === 429) {
    return ErrorCategory.RATE_LIMIT;
  }
  
  // Transient errors that should be retried
  if (
    status === 408 || // Request Timeout
    status === 425 || // Too Early 
    status === 500 || // Internal Server Error
    status === 502 || // Bad Gateway
    status === 503 || // Service Unavailable
    status === 504 || // Gateway Timeout
    (status >= 500 && status < 600) || // Other 5xx server errors
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNABORTED' ||
    error.code === 'ENETUNREACH' ||
    error.name === 'AbortError' ||
    error.message?.includes('timeout') ||
    error.message?.includes('network error')
  ) {
    return ErrorCategory.TRANSIENT;
  }
  
  // Default to unknown - we'll generally retry these
  return ErrorCategory.UNKNOWN;
}

/**
 * Improved wait function with better handling for very long delays
 */
export async function wait(ms: number): Promise<void> {
  // For extremely long delays, use multiple setTimeout calls
  // to avoid issues with setTimeout's 32-bit integer limit
  if (ms > 2147483647) {
    await wait(2147483647); // Wait for max setTimeout delay
    await wait(ms - 2147483647); // Wait for remaining time
    return;
  }
  
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract retry delay from headers with improved parsing
 */
export function getRetryDelayFromHeaders(headers: Headers): number | null {
  const retryAfter = headers.get('Retry-After');
  if (!retryAfter) return null;
  
  // Try parsing as a number of seconds
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000; // Convert to ms
  }
  
  // Try parsing as HTTP date
  try {
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      return date.getTime() - Date.now();
    }
  } catch (e) {
    // Invalid date format
  }
  
  return null; // Could not parse
}

/**
 * Calculate retry delay with exponential backoff and optional jitter
 */
function calculateRetryDelay(attempt: number, options: RetryOptions): number {
  // Calculate base delay with exponential backoff
  let delay = options.initialDelayMs * Math.pow(options.factor || 2, attempt - 1);
  
  // Apply maximum delay limit
  if (options.maxDelayMs) {
    delay = Math.min(delay, options.maxDelayMs);
  }
  
  // Add jitter to prevent thundering herd problem
  if (options.jitter) {
    // Add ±30% randomness
    const jitterFactor = 0.7 + Math.random() * 0.6; // 0.7 to 1.3
    delay = Math.floor(delay * jitterFactor);
  }
  
  return delay;
}

/**
 * Enhanced retry function with support for different error categories
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  // Merge with default options
  const retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const retryLogger = logger.child({ operation: 'retry' });
  
  let attempt = 1;
  
  while (true) {
    try {
      return await fn();
    } catch (error) {
      // Check if we've reached max attempts
      if (attempt >= retryOptions.maxAttempts) {
        retryLogger.error(`Max retry attempts (${retryOptions.maxAttempts}) reached. Giving up.`, { 
          error: error.message,
          stack: error.stack,
          attempt
        });
        throw error;
      }
      
      // Check if error is retryable
      const errorCategory = categorizeError(error);
      const isRetryable = retryOptions.retryableErrorPredicate ? 
        retryOptions.retryableErrorPredicate(error) : 
        errorCategory !== ErrorCategory.PERMANENT;
      
      if (!isRetryable) {
        retryLogger.warn(`Non-retryable error encountered`, {
          error: error.message,
          category: errorCategory,
          attempt
        });
        throw error;
      }
      
      // Calculate delay for next retry
      let delay = calculateRetryDelay(attempt, retryOptions);
      
      // Use Retry-After header if available for rate limit errors
      if (errorCategory === ErrorCategory.RATE_LIMIT && error.headers) {
        const retryAfterMs = getRetryDelayFromHeaders(error.headers);
        if (retryAfterMs && retryAfterMs > 0) {
          delay = retryAfterMs;
          retryLogger.info(`Using Retry-After header value: ${delay}ms`);
        }
      }
      
      retryLogger.warn(`Retry attempt ${attempt}/${retryOptions.maxAttempts} after ${delay}ms delay`, {
        error: error.message,
        category: errorCategory,
        statusCode: error.status || error.statusCode
      });
      
      // Wait before next attempt
      await wait(delay);
      attempt++;
    }
  }
}

/**
 * Special retry function for rate-limited operations with resource tracking
 */
export async function withRateLimitedRetry<T>(
  fn: () => Promise<T>,
  resourceKey: string,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const retryLogger = logger.child({ 
    operation: 'rateLimitedRetry', 
    resource: resourceKey 
  });
  
  // Special options for rate limited operations
  const rateLimitOptions: RetryOptions = {
    ...DEFAULT_RETRY_OPTIONS,
    initialDelayMs: 5000,   // Start with 5s delay for rate limits
    maxDelayMs: 60 * 60 * 1000, // Up to 1h max delay
    factor: 4,             // More aggressive backoff
    jitter: true,
    ...options
  };
  
  let attempt = 1;
  
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= rateLimitOptions.maxAttempts) {
        retryLogger.error(`Max rate limit retry attempts reached.`, { 
          attempt, 
          error: error.message
        });
        throw error;
      }
      
      // Check for rate limit errors
      const errorCategory = categorizeError(error);
      const isRateLimit = errorCategory === ErrorCategory.RATE_LIMIT;
      let delay = calculateRetryDelay(attempt, rateLimitOptions);
      
      // Get specific delay from headers for rate limit errors
      if (isRateLimit && error.headers) {
        const retryAfterMs = getRetryDelayFromHeaders(error.headers);
        if (retryAfterMs && retryAfterMs > 0) {
          delay = retryAfterMs;
        }
      }
      
      retryLogger.warn(`Rate limit retry for ${resourceKey}`, {
        attempt,
        delay,
        isRateLimit,
        error: error.message,
        status: error.status,
        headers: error.headers ? JSON.stringify(error.headers) : undefined
      });
      
      await wait(delay);
      attempt++;
    }
  }
}
