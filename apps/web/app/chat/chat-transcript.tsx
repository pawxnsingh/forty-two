"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./chat.module.css";

export function ChatTranscript({
  children,
  contentVersion,
}: {
  children: ReactNode;
  contentVersion: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (!stickToBottom.current || !element.current) return;
    const frame = requestAnimationFrame(() => {
      if (element.current)
        element.current.scrollTop = element.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [contentVersion]);

  return (
    <div
      className={styles.transcript}
      onScroll={(event) => {
        const target = event.currentTarget;
        stickToBottom.current =
          target.scrollHeight - target.scrollTop - target.clientHeight < 140;
      }}
      ref={element}
    >
      <div className={styles.transcriptInner}>{children}</div>
    </div>
  );
}
