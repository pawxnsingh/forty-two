import type { Metadata } from "next";
import { ChatWorkspace } from "./chat-workspace";

export const metadata: Metadata = { title: "New session" };

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[] }>;
}) {
  const source = (await searchParams).source;
  return (
    <ChatWorkspace
      initialSourceId={typeof source === "string" ? source : undefined}
    />
  );
}
