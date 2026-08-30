import { AnimatePresence, motion } from "framer-motion";
import React, { useMemo } from "react";
import { useMemoizedFn } from "@viz/hooks/useMemoizedFn";
import { cn } from "@viz/lib/classMerge";
import type { ChartLegendItem, ChartLegendProps } from "./interfaces";
import { LegendItemDot } from "./LegendDot";

export const LegendItem: React.FC<{
  item: ChartLegendItem;
  onClickItem?: ChartLegendProps["onClickItem"];
  onFocusItem?: ChartLegendProps["onFocusItem"];
  onHoverItem?: ChartLegendProps["onHoverItem"];
}> = React.memo(
  ({ item, onClickItem, onFocusItem: onFocusItemProp, onHoverItem }) => {
    const { inactive } = item;

    const onHoverItemPreflight = useMemoizedFn((hover: boolean) => {
      if (!inactive) onHoverItem?.(item, hover);
    });

    const onFocusItemHandler = useMemoizedFn(() => {
      if (onFocusItemProp) onFocusItemProp(item);
    });

    const onFocusItem = onFocusItemProp ? onFocusItemHandler : undefined;

    return (
      <LegendItemStandard
        onClickItem={onClickItem}
        onHoverItemPreflight={onHoverItemPreflight}
        onFocusItem={onFocusItem}
        item={item}
      />
    );
  },
);
LegendItem.displayName = "LegendItem";

const headlineTypeToText: Record<
  "current" | "average" | "total" | "median" | "min" | "max",
  string
> = {
  current: "Cur.",
  average: "Avg.",
  total: "Total",
  median: "Med.",
  min: "Min.",
  max: "Max.",
};

const headlineAnimation = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: "20px" },
  exit: { opacity: 0, height: 0 },
};

const headlinePreTextAnimation = {
  initial: { opacity: 0, width: 0, marginRight: 0 },
  animate: { opacity: 1, width: "auto", marginRight: "3px" },
  exit: { opacity: 0, width: 0, marginRight: 0 },
};

const LegendItemStandard = React.forwardRef<
  HTMLDivElement,
  {
    onClickItem: ChartLegendProps["onClickItem"];
    onHoverItemPreflight: (hover: boolean) => void;
    onFocusItem: (() => void) | undefined;
    item: ChartLegendItem;
  }
>(({ onClickItem, onHoverItemPreflight, onFocusItem, item }, ref) => {
  const clickable = onClickItem !== undefined;
  const { formattedName, inactive, headline } = item;
  const hasHeadline = headline?.type;

  const headlinePreText = useMemo(() => {
    if (hasHeadline && headline.type) return headlineTypeToText[headline.type];
    return "";
  }, [hasHeadline, headline]);

  const onClickItemHandler = useMemoizedFn(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (onClickItem) onClickItem(item);
    },
  );

  const onMouseEnterHandler = useMemoizedFn(() => {
    if (onHoverItemPreflight) onHoverItemPreflight(true);
  });

  const onMouseLeaveHandler = useMemoizedFn(() => {
    if (onHoverItemPreflight) onHoverItemPreflight(false);
  });

  const itemWrapperAnimation = useMemo(() => {
    return {
      height: hasHeadline ? 38 : 24,
      borderRadius: hasHeadline ? 8 : 4,
    };
  }, [hasHeadline]);

  return (
    <motion.div
      ref={ref}
      initial={false}
      animate={itemWrapperAnimation}
      onClick={onClickItemHandler}
      onMouseEnter={onMouseEnterHandler}
      onMouseLeave={onMouseLeaveHandler}
      className={cn(
        "flex h-[24px] flex-col justify-center space-y-0 rounded-control px-2.5",
        clickable &&
          "cursor-pointer transition-colors duration-100 hover:bg-surface-sunken",
      )}
    >
      <AnimatePresence initial={false}>
        {hasHeadline && (
          <motion.div
            {...headlineAnimation}
            className="flex items-center space-x-1.5"
          >
            <span
              className={cn(
                "text-[15px] leading-none font-semibold!",
                !inactive ? "text-foreground" : "text-foreground-secondary",
              )}
            >
              {headline?.titleAmount}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={cn(
          "flex flex-nowrap items-center space-x-1.5 whitespace-nowrap",
          {
            clickable: clickable,
          },
        )}
      >
        <LegendItemDot
          size={!hasHeadline ? "default" : "sm"}
          onFocusItem={onFocusItem}
          color={item.color}
          type={item.type}
          inactive={item.inactive}
        />
        {/*We use text 13px because blake modified the base in different envs  */}
        <div
          className={cn(
            "charting-legend-label flex max-w-[185px] items-center truncate text-body transition-all duration-100 select-none",
            !inactive ? "text-foreground" : "text-foreground-secondary",
          )}
        >
          <AnimatePresence mode="wait" initial={false}>
            {headlinePreText && (
              <motion.div
                key={hasHeadline ? "hasHeadline" : "noHeadline"}
                {...headlinePreTextAnimation}
              >
                {headlinePreText}
              </motion.div>
            )}
          </AnimatePresence>

          <span>{formattedName}</span>
        </div>
      </div>
    </motion.div>
  );
});
LegendItemStandard.displayName = "LegendItemStandard";
