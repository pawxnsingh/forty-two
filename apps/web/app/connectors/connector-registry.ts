import {
  Braces,
  Database,
  FileSpreadsheet,
  HardDrive,
  Server,
  Snowflake,
  Table2,
  Warehouse,
  type LucideIcon,
} from "lucide-react";

export const CONNECTOR_TYPES = [
  "csv",
  "xlsx",
  "postgresql",
  "mysql",
  "sqlserver",
  "snowflake",
  "bigquery",
  "redshift",
] as const;

export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export interface ConnectorDefinition {
  description: string;
  icon: LucideIcon;
  label: string;
  type: ConnectorType;
}

export const connectorGroups: readonly {
  description: string;
  id: string;
  label: string;
  connectors: readonly ConnectorDefinition[];
}[] = [
  {
    id: "files",
    label: "Files",
    description:
      "Upload a local dataset and make it available to the workspace.",
    connectors: [
      {
        type: "csv",
        label: "CSV",
        description: "Comma-separated tabular data",
        icon: Table2,
      },
      {
        type: "xlsx",
        label: "Excel",
        description: "Microsoft Excel workbooks",
        icon: FileSpreadsheet,
      },
    ],
  },
  {
    id: "databases",
    label: "Databases and warehouses",
    description:
      "Connect with encrypted credentials and validate access before use.",
    connectors: [
      {
        type: "postgresql",
        label: "PostgreSQL",
        description: "PostgreSQL databases",
        icon: Database,
      },
      {
        type: "mysql",
        label: "MySQL",
        description: "MySQL-compatible databases",
        icon: HardDrive,
      },
      {
        type: "sqlserver",
        label: "SQL Server",
        description: "Microsoft SQL Server",
        icon: Server,
      },
      {
        type: "snowflake",
        label: "Snowflake",
        description: "Snowflake data warehouse",
        icon: Snowflake,
      },
      {
        type: "bigquery",
        label: "BigQuery",
        description: "Google BigQuery projects",
        icon: Braces,
      },
      {
        type: "redshift",
        label: "Redshift",
        description: "Amazon Redshift clusters",
        icon: Warehouse,
      },
    ],
  },
];

export const connectors = connectorGroups.flatMap((group) => group.connectors);

export function connectorDefinition(
  type: string,
): ConnectorDefinition | undefined {
  return connectors.find((connector) => connector.type === type);
}

export function isConnectorType(type: string): type is ConnectorType {
  return CONNECTOR_TYPES.includes(type as ConnectorType);
}

export function isFileConnector(type: ConnectorType): type is "csv" | "xlsx" {
  return type === "csv" || type === "xlsx";
}
