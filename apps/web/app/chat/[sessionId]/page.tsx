import type { Metadata } from "next";
import { ChatWorkspace } from "../chat-workspace";

export const metadata: Metadata = { title: "Session" };

export default async function ChatSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <ChatWorkspace initialSessionId={sessionId} />;
}
