
/**
 * Utility functions for handling upsert operations with better conflict resolution
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { logger } from './logger.ts';

/**
 * Helper to safely upsert a record and handle unique constraint violations
 * @param supabase The Supabase client instance
 * @param tableName Name of the table to upsert into
 * @param data Data to upsert
 * @param keyField The field that might cause constraint violations (usually the external ID)
 * @param returnFields Fields to return from the operation
 * @param loggerContext Optional context for logging
 */
export async function safeUpsert<T = any>(
  supabase: SupabaseClient,
  tableName: string,
  data: Record<string, any>,
  keyField: string,
  returnFields: string,
  loggerContext: Record<string, any> = {}
): Promise<{ data: T | null; id: string | null; error: Error | null }> {
  const contextLogger = logger.child({ 
    operation: 'safeUpsert', 
    table: tableName,
    ...loggerContext 
  });
  
  try {
    // First try the upsert operation
    const { data: upsertedData, error: upsertError } = await supabase
      .from(tableName)
      .upsert(data, {
        onConflict: keyField,
        ignoreDuplicates: false // Update existing records
      })
      .select(returnFields);
    
    // If successful, return the data
    if (!upsertError) {
      const resultArray = upsertedData as any[];
      if (resultArray && resultArray.length > 0) {
        return { 
          data: resultArray[0] as T, 
          id: resultArray[0]?.id,
          error: null 
        };
      }
      return { data: null, id: null, error: null };
    }
    
    // If we hit a unique constraint violation
    if (upsertError.code === '23505') {
      contextLogger.info(`Handling conflict on ${keyField}=${data[keyField]}`);
      
      // Try to fetch the existing record
      const { data: existingData, error: fetchError } = await supabase
        .from(tableName)
        .select(returnFields)
        .eq(keyField, data[keyField])
        .single();
        
      if (fetchError) {
        contextLogger.error(`Failed to fetch existing record after conflict:`, fetchError);
        return { data: null, id: null, error: fetchError };
      }
      
      contextLogger.info(`Resolved conflict, using existing ${tableName} record with ID ${existingData.id}`);
      return { 
        data: existingData as T, 
        id: existingData.id,
        error: null 
      };
    }
    
    // Any other error
    contextLogger.error(`Upsert error:`, upsertError);
    return { data: null, id: null, error: upsertError };
  } catch (error) {
    contextLogger.error(`Unexpected error:`, error);
    return { data: null, id: null, error: error as Error };
  }
}

/**
 * Checks if an entity exists by its external ID
 * @param supabase The Supabase client instance
 * @param tableName Table to check
 * @param keyField The field to match (typically spotify_id)
 * @param keyValue The value to search for
 * @returns The database ID if found, null otherwise
 */
export async function getEntityIdByExternalId(
  supabase: SupabaseClient,
  tableName: string,
  keyField: string,
  keyValue: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from(tableName)
    .select('id')
    .eq(keyField, keyValue)
    .maybeSingle();
    
  if (error) {
    logger.error(`Error checking if ${tableName} exists with ${keyField}=${keyValue}:`, error);
    return null;
  }
  
  return data?.id || null;
}
