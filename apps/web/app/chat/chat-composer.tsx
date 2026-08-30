"use client";

import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import styles from "./chat.module.css";

const MAX_HEIGHT = 220;

export function ChatComposer({
  message,
  onMessageChange,
  onStop,
  onSubmit,
  plan,
  running,
  submitting,
  toolbarStart,
}: {
  message: string;
  onMessageChange: (message: string) => void;
  onStop: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  plan?: ReactNode;
  running: boolean;
  submitting: boolean;
  toolbarStart: ReactNode;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useEffect(resize, [message, resize]);

  return (
    <div className={styles.composerShell}>
      {plan}
      <form className={styles.composer} onSubmit={onSubmit}>
        <textarea
          aria-label="Message Forty Two"
          disabled={running || submitting}
          id="forty-two-composer"
          onChange={(event) => onMessageChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={
            running ? "Forty Two is working…" : "Ask anything about your data…"
          }
          ref={textarea}
          rows={1}
          value={message}
        />
        <div className={styles.composerToolbar}>
          <div>{toolbarStart}</div>
          <span className={styles.composerHint} aria-hidden="true">
            Enter to send
          </span>
          {running ? (
            <button
              aria-label="Stop response"
              className={styles.sendButton}
              onClick={onStop}
              type="button"
            >
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button
              aria-label="Send message"
              className={styles.sendButton}
              disabled={!message.trim() || submitting}
              type="submit"
            >
              {submitting ? (
                <LoaderCircle aria-hidden="true" data-loading="true" />
              ) : (
                <ArrowUp aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
