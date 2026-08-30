"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Dot, type LucideIcon } from "lucide-react";
import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";
import styles from "./chat.module.css";

interface ChainContextValue {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

const ChainContext = createContext<ChainContextValue | null>(null);

function useChain() {
  const context = useContext(ChainContext);
  if (!context) throw new Error("Chain components require ChainOfThought");
  return context;
}

export const ChainOfThought = memo(function ChainOfThought({
  children,
  onOpenChange,
  open = false,
}: {
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  open?: boolean;
}) {
  const context = useMemo(
    () => ({ isOpen: open, setIsOpen: onOpenChange }),
    [onOpenChange, open],
  );

  return (
    <ChainContext.Provider value={context}>
      <div className={styles.chainRoot}>{children}</div>
    </ChainContext.Provider>
  );
});

export const ChainOfThoughtHeader = memo(function ChainOfThoughtHeader({
  children,
}: {
  children: ReactNode;
}) {
  const { isOpen, setIsOpen } = useChain();

  return (
    <button
      aria-expanded={isOpen}
      className={styles.chainHeader}
      onClick={() => setIsOpen(!isOpen)}
      type="button"
    >
      <span>{children}</span>
      <ChevronDown aria-hidden="true" />
    </button>
  );
});

export const ChainOfThoughtContent = memo(function ChainOfThoughtContent({
  children,
}: {
  children: ReactNode;
}) {
  const { isOpen } = useChain();

  return (
    <div className={styles.chainContent} data-open={isOpen || undefined}>
      <div>
        <div className={styles.chainSteps}>
          <AnimatePresence initial={false}>{children}</AnimatePresence>
        </div>
      </div>
    </div>
  );
});

export type ChainStepStatus = "active" | "complete" | "failed" | "pending";

export const ChainOfThoughtStep = memo(function ChainOfThoughtStep({
  description,
  icon: Icon = Dot,
  label,
  meta,
  status = "complete",
  ...props
}: ComponentProps<"div"> & {
  description?: ReactNode;
  icon?: LucideIcon;
  label: ReactNode;
  meta?: ReactNode;
  status?: ChainStepStatus;
}) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={styles.chainStep}
      data-status={status}
      exit={{ opacity: 0 }}
      initial={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
      {...(props as Record<string, unknown>)}
    >
      <div className={styles.chainStepIcon}>
        <Icon aria-hidden="true" />
        <i aria-hidden="true" />
      </div>
      <div className={styles.chainStepCopy}>
        <div>{label}</div>
        {meta ? <small className={styles.chainStepMeta}>{meta}</small> : null}
        {description ? (
          <small className={styles.chainStepResult}>{description}</small>
        ) : null}
      </div>
    </motion.div>
  );
});
