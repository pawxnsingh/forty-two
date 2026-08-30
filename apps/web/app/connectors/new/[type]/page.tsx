import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConnectorSetupForm } from "./setup-form";
import { connectorDefinition, isConnectorType } from "../../connector-registry";

type PageProps = { params: Promise<{ type: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { type } = await params;
  return {
    title: connectorDefinition(type)
      ? `Connect ${connectorDefinition(type)!.label}`
      : "Connector",
  };
}

export default async function ConnectorSetupPage({ params }: PageProps) {
  const { type } = await params;
  if (!isConnectorType(type)) notFound();
  return <ConnectorSetupForm type={type} />;
}
