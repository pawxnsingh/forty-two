"use client";

import { motion, type HTMLMotionProps, type Transition } from "framer-motion";
import type { CSSProperties } from "react";
import styles from "./chat.module.css";

interface ShimmeringTextProps
  extends Omit<HTMLMotionProps<"span">, "children"> {
  color?: string;
  duration?: number;
  shimmeringColor?: string;
  text: string;
  transition?: Transition;
}

export function ShimmeringText({
  color = "var(--console-text-3)",
  duration = 1,
  shimmeringColor = "var(--console-text)",
  text,
  transition,
  ...props
}: ShimmeringTextProps) {
  return (
    <motion.span
      className={styles.shimmeringText}
      style={
        {
          "--shimmer-color": shimmeringColor,
          "--shimmer-rest": color,
          color: "var(--shimmer-rest)",
        } as CSSProperties
      }
      {...props}
    >
      {text.split("").map((character, index) => (
        <motion.span
          animate={{
            color: [
              "var(--shimmer-rest)",
              "var(--shimmer-color)",
              "var(--shimmer-rest)",
            ],
          }}
          className={styles.shimmeringCharacter}
          initial={{ color: "var(--shimmer-rest)" }}
          key={`${character}-${index}`}
          transition={{
            delay: (index * duration) / text.length,
            duration,
            ease: "easeInOut",
            repeat: Number.POSITIVE_INFINITY,
            repeatDelay: text.length * 0.05,
            repeatType: "loop",
            ...transition,
          }}
        >
          {character}
        </motion.span>
      ))}
    </motion.span>
  );
}
