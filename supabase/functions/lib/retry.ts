// Retry utility with exponential backoff, jitter, and error categorization

import { logger } from './logger.ts';

export enum ErrorCategory {
  TRANSIENT, // Temporary error, should retry
  PERMANENT, // Permanent error, don't retry 
  RATE_LIMIT, // Rate limit error with specific handling
  CONNECTION, // Network or connection error
  VALIDATION, // Data validation error
  UNKNOWN // Uncategorized error
}

interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  retryableErrorPredicate?: (error: any) => boolean;
  onRetry?: (attempt: number, delay: number, error: any) => void;
}

interface RateLimitHeaders {
  // Common rate-limit header patterns
  'retry-after'?: string;
  'ratelimit-reset'?: string;
  'x-rate-limit-reset'?: string;
}

// Helper to classify errors for retry decisions
export function categorizeError(error: any): ErrorCategory {
  if (!error) return ErrorCategory.UNKNOWN;
  
  // Check for rate limit status codes
  if (error.status === 429 || error.statusCode === 429) {
    return ErrorCategory.RATE_LIMIT;
  }
  
  // Network or connection errors
  if (
    error.name === 'FetchError' || 
    error.name === 'AbortError' ||
    error.code === 'ECONNRESET' || 
    error.code === 'ECONNREFUSED' || 
    error.code === 'ETIMEDOUT'
  ) {
    return ErrorCategory.CONNECTION;
  }
  
  // Check for typical transient errors
  if (
    error.status >= 500 || 
    error.statusCode >= 500 || 
    error.message?.includes('timeout') ||
    error.message?.includes('temporarily unavailable')
  ) {
    return ErrorCategory.TRANSIENT;
  }
  
  // Validation errors
  if (
    error.status === 400 || 
    error.statusCode === 400 ||
    error.name === 'ValidationError'
  ) {
    return ErrorCategory.VALIDATION;
  }
  
  // Permanent errors
  if (
    error.status === 401 || 
    error.status === 403 || 
    error.status === 404 ||
    error.statusCode === 401 || 
    error.statusCode === 403 || 
    error.statusCode === 404
  ) {
    return ErrorCategory.PERMANENT;
  }
  
  return ErrorCategory.UNKNOWN;
}

// Default retry predicate based on error category
function defaultRetryPredicate(error: any): boolean {
  const category = categorizeError(error);
  return category === ErrorCategory.TRANSIENT || 
         category === ErrorCategory.RATE_LIMIT || 
         category === ErrorCategory.CONNECTION;
}

// Extract retry delay from rate limit headers
export function getRetryDelayFromHeaders(headers?: Headers | RateLimitHeaders): number | null {
  if (!headers) return null;
  
  const retryAfter = headers['retry-after'] || 
                     headers.get?.('retry-after') || 
                     headers['ratelimit-reset'] ||
                     headers.get?.('ratelimit-reset') ||
                     headers['x-rate-limit-reset'] ||
                     headers.get?.('x-rate-limit-reset');
                     
  if (!retryAfter) return null;
  
  // Check if it's a timestamp or a delay in seconds
  if (/^\d+$/.test(retryAfter)) {
    const value = parseInt(retryAfter, 10);
    
    // If it's a Unix timestamp (usually > 1,000,000), convert to delay
    if (value > 1000000) {
      return Math.max(0, value * 1000 - Date.now());
    }
    
    // Otherwise, it's a delay in seconds
    return value * 1000;
  }
  
  // Try to parse HTTP date format
  try {
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now());
    }
  } catch (err) {
    // Ignore parsing errors
  }
  
  return null;
}

// Calculate retry delay with exponential backoff and optional jitter
function calculateRetryDelay(
  attempt: number,
  initialDelay: number,
  maxDelay: number,
  factor: number,
  useJitter: boolean,
  headers?: Headers | RateLimitHeaders
): number {
  // First check rate limit headers
  const headerDelay = getRetryDelayFromHeaders(headers);
  if (headerDelay !== null) {
    return Math.min(headerDelay, maxDelay);
  }
  
  // Calculate exponential backoff
  let delay = initialDelay * Math.pow(factor, attempt - 1);
  
  // Add jitter if enabled (±30% randomness)
  if (useJitter) {
    const jitterFactor = 0.3; // 30% jitter
    const randomFactor = 1 - jitterFactor + (Math.random() * jitterFactor * 2);
    delay = delay * randomFactor;
  }
  
  // Cap the delay at maxDelay
  return Math.min(delay, maxDelay);
}

// Wait for the specified milliseconds
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main retry function with exponential backoff
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    factor = 2,
    jitter = true,
    retryableErrorPredicate = defaultRetryPredicate,
    onRetry
  } = options;
  
  let attempt = 1;
  
  while (true) {
    try {
      return await fn();
    } catch (error) {
      // Don't retry if we've reached max attempts or error isn't retryable
      if (attempt >= maxAttempts || !retryableErrorPredicate(error)) {
        throw error;
      }
      
      const headers = error.headers || (error.response && error.response.headers);
      const delay = calculateRetryDelay(
        attempt,
        initialDelayMs,
        maxDelayMs,
        factor,
        jitter,
        headers
      );
      
      // Log retry attempt
      logger.warn(`Retry attempt ${attempt}/${maxAttempts} after ${delay}ms delay`, { 
        error: error.message,
        category: ErrorCategory[categorizeError(error)]
      });
      
      // Call onRetry callback if provided
      if (onRetry) {
        onRetry(attempt, delay, error);
      }
      
      // Wait before retrying
      await wait(delay);
      
      attempt++;
    }
  }
}

// Specialized rate-limited retry for API calls
export async function withRateLimitedRetry<T>(
  fn: () => Promise<T>,
  resourceName: string,
  options: RetryOptions = {}
): Promise<T> {
  const contextLogger = logger.child({ operation: 'rateLimitedRetry', resource: resourceName });
  
  return withRetry(fn, {
    maxAttempts: 5,
    initialDelayMs: 2000,
    maxDelayMs: 60000,
    factor: 2,
    jitter: true,
    ...options,
    onRetry: (attempt, delay, error) => {
      contextLogger.warn(`Rate limit retry for ${resourceName}`, {
        attempt,
        delay,
        error: error.message
      });
      
      if (options.onRetry) {
        options.onRetry(attempt, delay, error);
      }
    }
  });
}
