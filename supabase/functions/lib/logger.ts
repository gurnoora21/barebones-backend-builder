
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
  
  error(message: string, error?: Error, data?: any) {
    const errorData = error ? {
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack
      },
      ...data
    } : data;
    
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
}

// Create a default logger
export const logger = new Logger();

// Generate a random trace ID
export function generateTraceId(): string {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}
