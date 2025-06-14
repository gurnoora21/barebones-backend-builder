
// Database transaction helpers and common database operations

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { Database } from '../types.ts';
import { logger } from './logger.ts';
import { withRetry } from './retry.ts';

// Transaction helper for managing database transactions
export class Transaction {
  private supabase: SupabaseClient<Database>;
  private logger = logger.child({ component: 'Transaction' });
  
  constructor(supabaseClient: SupabaseClient<Database>) {
    this.supabase = supabaseClient;
  }
  
  async begin(): Promise<void> {
    await this.supabase.rpc('begin_transaction');
    this.logger.debug('Transaction started');
  }
  
  async commit(): Promise<void> {
    await this.supabase.rpc('commit_transaction');
    this.logger.debug('Transaction committed');
  }
  
  async rollback(): Promise<void> {
    await this.supabase.rpc('rollback_transaction');
    this.logger.warn('Transaction rolled back');
  }
  
  // Run a function within a transaction
  async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await this.begin();
      const result = await fn();
      await this.commit();
      return result;
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }
}

// Create database transaction helpers
export function createDbTransactionHelpers(supabase: SupabaseClient<Database>) {
  // RPC function to begin transaction
  if (!supabase.rpc) {
    supabase.rpc = async function(procedureName: string, params?: any) {
      const { data, error } = await supabase.functions.invoke('database-functions', {
        body: { procedure: procedureName, params }
      });
      
      if (error) throw error;
      return { data, error: null };
    };
  }
  
  return {
    // Use transaction for related database operations
    async withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      const tx = new Transaction(supabase);
      return tx.run(() => fn(tx));
    },
    
    // Helper for retryable database operations
    async withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
      return withRetry(fn, {
        maxAttempts: 3,
        initialDelayMs: 500,
        retryableErrorPredicate: (error) => {
          // Add specific database error conditions that should be retried
          return error && (
            error.code === '23505' || // Unique violation - could be race condition
            error.code === '40001' || // Serialization failure
            error.code === '40P01' || // Deadlock
            error.message?.includes('connection timeout') ||
            error.message?.includes('too many connections')
          );
        }
      });
    },
    
    /**
     * Helper function to handle unique constraint violations gracefully
     * Attempts to fetch the existing record if a duplicate key error occurs
     */
    async upsertWithConflictResolution<T>(
      table: string, 
      data: Record<string, any>, 
      options: { 
        onConflict: string, 
        keyField: string,
        returnFields: string 
      }
    ): Promise<{ data: T | null; error: Error | null }> {
      try {
        // First try the upsert operation
        const { data: upsertedData, error: upsertError } = await supabase
          .from(table)
          .upsert(data, {
            onConflict: options.onConflict,
            ignoreDuplicates: false
          })
          .select(options.returnFields);
        
        // If successful, return the data
        if (!upsertError) {
          return { data: upsertedData as unknown as T, error: null };
        }
        
        // If we hit a unique constraint violation
        if (upsertError.code === '23505') {
          logger.info(`Handling conflict on ${table} with ${options.keyField}=${data[options.keyField]}`);
          
          // Try to fetch the existing record
          const { data: existingData, error: fetchError } = await supabase
            .from(table)
            .select(options.returnFields)
            .eq(options.keyField, data[options.keyField])
            .single();
            
          if (fetchError) {
            return { data: null, error: fetchError };
          }
          
          return { data: existingData as unknown as T, error: null };
        }
        
        // Any other error
        return { data: null, error: upsertError };
      } catch (error) {
        logger.error(`Unexpected error in upsertWithConflictResolution for ${table}:`, error);
        return { data: null, error: error as Error };
      }
    }
  };
}

// Define environment helper for standardized environment access
export function getEnvConfig() {
  // Cache environment values
  const envCache = new Map<string, string>();
  
  return {
    get(name: string, required: boolean = false): string | undefined {
      if (envCache.has(name)) {
        return envCache.get(name);
      }
      
      const value = Deno.env.get(name);
      
      if (required && !value) {
        throw new Error(`Required environment variable ${name} is missing`);
      }
      
      if (value) {
        envCache.set(name, value);
      }
      
      return value;
    },
    
    getRequired(name: string): string {
      const value = this.get(name, true);
      return value as string;
    },
    
    isDevelopment(): boolean {
      return Deno.env.get('ENVIRONMENT') === 'development';
    },
    
    isProduction(): boolean {
      return Deno.env.get('ENVIRONMENT') === 'production';
    }
  };
}
