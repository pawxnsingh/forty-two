"use client";

import { Streamdown } from "streamdown";
import type { ComponentProps } from "react";
import styles from "./chat.module.css";

function safeHref(href?: string) {
  if (!href) return undefined;
  const value = href.trim();
  if (/^(https?:|mailto:|tel:)/i.test(value) || /^[/#]/.test(value))
    return href;
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? undefined : href;
}

const components = {
  a: ({ href, children, ...props }: ComponentProps<"a">) => (
    <a
      {...props}
      href={safeHref(href)}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  ),
  blockquote: ({ children, ...props }: ComponentProps<"blockquote">) => (
    <blockquote {...props}>{children}</blockquote>
  ),
  code: ({ children, ...props }: ComponentProps<"code">) => (
    <code {...props}>{children}</code>
  ),
  h1: ({ children, ...props }: ComponentProps<"h1">) => (
    <h1 {...props}>{children}</h1>
  ),
  h2: ({ children, ...props }: ComponentProps<"h2">) => (
    <h2 {...props}>{children}</h2>
  ),
  h3: ({ children, ...props }: ComponentProps<"h3">) => (
    <h3 {...props}>{children}</h3>
  ),
  ol: ({ children, ...props }: ComponentProps<"ol">) => (
    <ol {...props}>{children}</ol>
  ),
  p: ({ children, ...props }: ComponentProps<"p">) => (
    <p {...props}>{children}</p>
  ),
  pre: ({ children, ...props }: ComponentProps<"pre">) => (
    <pre {...props}>{children}</pre>
  ),
  table: ({ children, ...props }: ComponentProps<"table">) => (
    <div className={styles.markdownTable}>
      <table {...props}>{children}</table>
    </div>
  ),
  ul: ({ children, ...props }: ComponentProps<"ul">) => (
    <ul {...props}>{children}</ul>
  ),
};

export function MarkdownView({ text }: { text: string }) {
  return (
    <Streamdown className={styles.markdown} components={components}>
      {text}
    </Streamdown>
  );
}
