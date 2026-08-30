import { z } from 'zod';
// Import shared types from common location
import {
  type ColumnMetadata as BaseColumnMetadata,
  ColumnMetadataSchema as BaseColumnMetadataSchema,
  type DataMetadata as BaseDataMetadata,
  DataMetadataSchema as BaseDataMetadataSchema,
  type DataResult as BaseDataResult,
  DataResultSchema as BaseDataResultSchema,
} from '../common/data-types';

// Re-export with original names for backward compatibility
export const ColumnMetaDataSchema = BaseColumnMetadataSchema;
export const DataMetadataSchema = BaseDataMetadataSchema;
export const DataResultSchema = BaseDataResultSchema;

export type DataResult = BaseDataResult;
export type ColumnMetaData = BaseColumnMetadata;
export type DataMetadata = BaseDataMetadata;
