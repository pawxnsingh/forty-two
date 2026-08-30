import { z } from 'zod';

/**
 * Common data result type used across metrics and datasets
 * Represents tabular data as an array of row objects where:
 * - Each object represents a row
 * - Keys are column names
 * - Values can be numbers, strings, or null
 */
export const DataResultSchema = z
  .array(z.record(z.string(), z.union([z.number(), z.string(), z.null()])))
  .describe('Array of data rows with column-value pairs');

export type DataResult = z.infer<typeof DataResultSchema>;

/**
 * Column metadata for describing individual columns in a dataset
 */
export const ColumnMetadataSchema = z.object({
  name: z.string().describe('Column name'),
  min_value: z.union([z.number(), z.string()]).describe('Minimum value in the column'),
  max_value: z.union([z.number(), z.string()]).describe('Maximum value in the column'),
  unique_values: z.number().describe('Count of unique values in the column'),
  simple_type: z.enum(['text', 'number', 'date']).describe('Simplified type category'),
  type: z
    .enum([
      'text',
      'float',
      'integer',
      'date',
      'float8',
      'timestamp',
      'timestamptz',
      'bool',
      'time',
      'boolean',
      'json',
      'jsonb',
      'int8',
      'int4',
      'int2',
      'decimal',
      'char',
      'character varying',
      'character',
      'varchar',
      'number',
      'numeric',
      'tinytext',
      'mediumtext',
      'longtext',
      'nchar',
      'nvarchat',
      'ntext',
      'float4',
    ])
    .describe('Database-specific column type'),
});

export type ColumnMetadata = z.infer<typeof ColumnMetadataSchema>;

/**
 * Metadata about a complete data result set
 */
export const DataMetadataSchema = z
  .object({
    column_count: z.number().describe('Total number of columns'),
    column_metadata: z.array(ColumnMetadataSchema).describe('Metadata for each column'),
    row_count: z.number().describe('Total number of rows'),
  })
  .nullable()
  .describe('Overall metadata for the data result set');

export type DataMetadata = z.infer<typeof DataMetadataSchema>;
