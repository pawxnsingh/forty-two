import type {
  ColumnLabelFormat,
  ColumnMetaData,
  SimplifiedColumnType,
} from '@viz/metrics-schema';

type ColumnDataType = ColumnMetaData['type'];

export const NUMBER_TYPES: (ColumnDataType | string)[] = [
  'float',
  'integer',
  'float8',
  'int2',
  'int4',
  'int8',
  'decimal',
  'number',
  'numeric',
  'tiny',
  'float4',
];
//"CHAR", "VARCHAR", "TEXT", "TINYTEXT", "TEXT", "MEDIUMTEXT", "LONGTEXT", "NCHAR", "NVARCHAR", "NTEXT", "STRING", "TEXT"

export const TEXT_TYPES: (ColumnDataType | string)[] = [
  'text',
  'varchar',
  'char',
  'character',
  'character varying',
];
export const DATE_TYPES: (ColumnDataType | string)[] = ['date', 'timestamp', 'timestamptz', 'time'];

export const simplifyColumnType = (type: string): SimplifiedColumnType => {
  if (type === 'number' || NUMBER_TYPES.includes(type as ColumnDataType)) {
    return 'number';
  }
  if (type === 'text' || TEXT_TYPES.includes(type as ColumnDataType)) {
    return 'text';
  }
  if (type === 'date' || DATE_TYPES.includes(type as ColumnDataType)) {
    return 'date';
  }

  return 'text';
};

export const isNumericColumnType = (type: SimplifiedColumnType) => {
  return type === 'number';
};

export const isNumericColumnStyle = (style: ColumnLabelFormat['style'] | undefined) => {
  return style === 'number' || style === 'percent' || style === 'currency';
};

export const isDateColumnType = (columnType: SimplifiedColumnType | undefined) => {
  return columnType === 'date';
};
