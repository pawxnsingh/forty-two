import type { Metadata } from "next";
import { ConnectorPicker } from "./connector-picker";

export const metadata: Metadata = { title: "New connector" };

export default function NewConnectorPage() {
  return <ConnectorPicker />;
}
