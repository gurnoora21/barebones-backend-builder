
// Structured logging utility with level-based methods and context

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

interface LogContext {
  worker?: string;
  operation?: string;
  traceId?: string;
  component?: string;
  service?: string;
  [key: string]: any;
}

export class Logger {
  private context: LogContext;
  private minLevel: LogLevel;
  
  constructor(context: LogContext = {}, minLevel: LogLevel = LogLevel.INFO) {
    this.context = context;
    this.minLevel = minLevel;
  }
  
  private log(level: LogLevel, message: string, data?: any) {
    if (level < this.minLevel) return;
    
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: LogLevel[level],
      message,
      ...this.context,
      ...(data ? { data } : {})
    };
    
    // For error level, use console.error
    if (level === LogLevel.ERROR) {
      console.error(JSON.stringify(logEntry));
    } else {
      console.log(JSON.stringify(logEntry));
    }
  }
  
  debug(message: string, data?: any) {
    this.log(LogLevel.DEBUG, message, data);
  }
  
  info(message: string, data?: any) {
    this.log(LogLevel.INFO, message, data);
  }
  
  warn(message: string, data?: any) {
    this.log(LogLevel.WARN, message, data);
  }
  
  error(message: string, error?: Error | any, data?: any) {
    let errorData;
    
    if (error) {
      errorData = {
        error: {
          message: error.message || String(error),
          name: error.name || 'Error',
          stack: error.stack || new Error().stack,
          status: error.status || error.statusCode,
          category: error.category || 'unknown'
        },
        ...data
      };
      
      // Include any additional properties from the error
      if (typeof error === 'object') {
        for (const key of Object.keys(error)) {
          if (!['message', 'name', 'stack'].includes(key) && typeof error[key] !== 'function') {
            errorData.error[key] = error[key];
          }
        }
      }
    } else {
      errorData = data;
    }
    
    this.log(LogLevel.ERROR, message, errorData);
  }
  
  // Create a child logger with additional context
  child(additionalContext: LogContext): Logger {
    return new Logger({
      ...this.context,
      ...additionalContext
    }, this.minLevel);
  }
  
  // Set minimum log level
  setLevel(level: LogLevel) {
    this.minLevel = level;
  }
  
  // Get the current context
  getContext(): LogContext {
    return { ...this.context };
  }
  
  // Clear all context
  clearContext(): void {
    this.context = {};
  }
}

// Create a default logger
export const logger = new Logger();

// Generate a random trace ID with improved format
export function generateTraceId(): string {
  const randomPart = () => Math.random().toString(36).substring(2, 15);
  return randomPart() + randomPart();
}
