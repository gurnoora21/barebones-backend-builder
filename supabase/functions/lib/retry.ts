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
  [key: string]: any;
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
    error.code === 'ETIMEDOUT' ||
    error.message?.includes('fetch failed')
  ) {
    return ErrorCategory.CONNECTION;
  }
  
  // Check for typical transient errors
  if (
    (error.status >= 500 && error.status < 600) || 
    (error.statusCode >= 500 && error.statusCode < 600) || 
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
    [401, 403, 404].includes(error.status) || 
    [401, 403, 404].includes(error.statusCode)
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
  
  // Handle both Headers object and plain objects
  const getHeaderValue = (name: string): string | null => {
    if (headers instanceof Headers) {
      return headers.get(name);
    } else {
      return (headers as RateLimitHeaders)[name] || null;
    }
  };
  
  // Try multiple header formats
  const retryAfter = getHeaderValue('retry-after') || 
                    getHeaderValue('Retry-After') || 
                    getHeaderValue('ratelimit-reset') ||
                    getHeaderValue('x-rate-limit-reset');
                     
  if (!retryAfter) return null;
  
  try {
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
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now());
    }
  } catch (err) {
    // Ignore parsing errors
    logger.warn(`Failed to parse Retry-After header: ${retryAfter}`, { error: String(err) });
  }
  
  // Return reasonable default if parsing fails
  return 30000; // 30 seconds default
}

// Calculate retry delay with exponential backoff and jitter
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
      
      // Log retry attempt with category information
      const errorCategory = categorizeError(error);
      logger.warn(`Retry attempt ${attempt}/${maxAttempts} after ${delay}ms delay`, { 
        error: error.message,
        category: ErrorCategory[errorCategory],
        statusCode: error.status || error.statusCode
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
      // Enhanced logging for rate limit retries
      const category = categorizeError(error);
      const isRateLimit = category === ErrorCategory.RATE_LIMIT;
      
      contextLogger.warn(`${isRateLimit ? 'Rate limit' : 'Error'} retry for ${resourceName}`, {
        attempt,
        delay,
        isRateLimit,
        error: error.message,
        status: error.status || error.statusCode,
        headers: error.headers ? JSON.stringify(Object.fromEntries(error.headers.entries())) : undefined
      });
      
      if (options.onRetry) {
        options.onRetry(attempt, delay, error);
      }
    }
  });
}

// Enhanced wait function with backpressure control
export async function waitForBackpressure(concurrentRequests: number, maxConcurrent: number, baseDelayMs = 200): Promise<void> {
  if (concurrentRequests >= maxConcurrent) {
    // Add exponential delay based on how far over limit we are
    const overLimit = concurrentRequests - maxConcurrent + 1;
    const delayMs = baseDelayMs * Math.pow(1.5, overLimit);
    
    // Add jitter
    const jitterFactor = 0.2;
    const jitteredDelay = delayMs * (1 - jitterFactor + (Math.random() * jitterFactor * 2));
    
    await wait(jitteredDelay);
  }
}
