"use client";

import {
  Code2,
  Database,
  Dot,
  FileText,
  Search,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
  type ChainStepStatus,
} from "./chain-of-thought";
import { ShimmeringText } from "./shimmering-text";

export interface ExecutionStep {
  completed: boolean;
  failed?: boolean;
  id: string;
  kind: "mcp" | "reasoning" | "system";
  name: string;
  serverName?: string;
  summary?: string;
}

interface ToolDisplay {
  icon: LucideIcon;
  label: string;
}

const TOOL_DISPLAY: Record<string, ToolDisplay> = {
  apply_sql_change: { icon: Database, label: "Applying database change" },
  create_query_table_artifact: {
    icon: FileText,
    label: "Creating result table",
  },
  describe_table: { icon: Search, label: "Reading table structure" },
  finalize_chart_artifact: { icon: FileText, label: "Creating chart" },
  finalize_table_artifact: { icon: FileText, label: "Finalizing table" },
  list_data_sources: { icon: Database, label: "Checking data sources" },
  list_databases: { icon: Search, label: "Listing databases" },
  list_schemas: { icon: Search, label: "Listing schemas" },
  list_tables: { icon: Search, label: "Listing tables" },
  prepare_sql_change: { icon: Database, label: "Preparing database change" },
  run_read_query: { icon: Database, label: "Running query" },
  web_search: { icon: Search, label: "Searching the web" },
  web_fetch: { icon: Search, label: "Reading a page" },
};

function toolDisplay(name: string): ToolDisplay {
  if (TOOL_DISPLAY[name]) return TOOL_DISPLAY[name];
  if (/query|sql|database|schema|introspect/i.test(name)) {
    return { icon: Database, label: "Querying data" };
  }
  if (/search|list|get|inspect|describe/i.test(name)) {
    return { icon: Search, label: "Inspecting sources" };
  }
  if (/code|python|calculate|analy/i.test(name)) {
    return { icon: Code2, label: "Running analysis" };
  }
  if (/artifact|chart|table|visual|finalize|create/i.test(name)) {
    return { icon: FileText, label: "Building the result" };
  }
  const label = name
    .replace(/^(run_|create_|finalize_|get_)/, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return { icon: Wrench, label: label || "Working" };
}

export function ExecutionChain({
  failed = false,
  running,
  steps,
}: {
  failed?: boolean;
  running: boolean;
  steps: readonly ExecutionStep[];
}) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? running;
  const builtSteps = useMemo(
    () =>
      steps.map((step, index) => {
        const display =
          step.kind === "reasoning"
            ? { icon: Dot, label: step.summary || "Thinking…" }
            : toolDisplay(step.name);
        const status: ChainStepStatus = step.failed
          ? "failed"
          : step.completed
            ? "complete"
            : failed && index === steps.length - 1
              ? "failed"
              : running
                ? "active"
                : "complete";
        return {
          ...display,
          id: step.id,
          kind: step.kind,
          status,
          summary: step.kind === "reasoning" ? undefined : step.summary,
        };
      }),
    [failed, running, steps],
  );

  if (builtSteps.length === 0 && !running) return null;

  const active = [...builtSteps]
    .reverse()
    .find((step) => step.status === "active");
  const runningText = active?.label ?? "Thinking…";
  const completedText = `Analysis${
    builtSteps.length > 0 ? ` · ${builtSteps.length} steps` : ""
  }`;

  return (
    <ChainOfThought open={open} onOpenChange={setOpenOverride}>
      <ChainOfThoughtHeader>
        {running ? (
          <ShimmeringText key={runningText} duration={1.2} text={runningText} />
        ) : (
          <span>{completedText}</span>
        )}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {builtSteps.map((step) => (
          <ChainOfThoughtStep
            description={
              step.status === "failed" ? "This action did not complete" : null
            }
            icon={step.icon}
            key={step.id}
            label={
              step.kind === "reasoning" ? (
                <span>{step.label}</span>
              ) : (
                <>
                  <strong>{step.label}</strong>
                  {step.status === "active" ? <span> …</span> : null}
                  {step.status !== "active" && step.summary ? (
                    <span> → {step.summary}</span>
                  ) : null}
                </>
              )
            }
            status={step.status}
          />
        ))}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}
