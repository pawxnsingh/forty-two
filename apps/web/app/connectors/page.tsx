import type { Metadata } from "next";
import { ConnectorsList } from "./connectors-list";

export const metadata: Metadata = { title: "Connectors" };

export default function ConnectorsPage() {
  return <ConnectorsList />;
}
