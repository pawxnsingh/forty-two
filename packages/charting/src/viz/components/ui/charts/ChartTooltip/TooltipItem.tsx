import type { ChartType } from "@viz/metrics-schema";
import type React from "react";
import { cn } from "@viz/lib/classMerge";
import { LegendItemDot } from "../ChartLegend/LegendDot";
import type { ITooltipItem, TooltipItemValueProps } from "./interfaces";

export const TooltipItem: React.FC<ITooltipItem> = ({
  values,
  color,
  seriesType,
  formattedLabel,
  usePercentage,
}) => {
  const isScatter = seriesType === "scatter";

  return (
    <>
      {!isScatter && (
        <div className="flex items-center space-x-1.5 overflow-hidden pl-3">
          <LegendItemDot
            color={color}
            type={seriesType as ChartType}
            inactive={false}
          />
          <span className={cn("truncate text-body")}>{formattedLabel}</span>
        </div>
      )}

      <TooltipItemValue
        values={values}
        usePercentage={usePercentage}
        isScatter={isScatter}
      />
    </>
  );
};

const TooltipItemValue: React.FC<{
  values: TooltipItemValueProps[];
  usePercentage: boolean;
  isScatter: boolean;
}> = ({ values, usePercentage, isScatter }) => {
  const chooseValue = (
    value: string | number | undefined,
    percentage: string | number | undefined,
  ) => {
    return usePercentage ? percentage : value;
  };

  if (values.length > 1 || isScatter) {
    return (
      <div className="grid grid-cols-[auto_auto] items-center gap-x-5 px-3">
        {values.map((value, index) => (
          <GroupTooltipValue
            key={index.toString()}
            label={value.formattedLabel}
            value={chooseValue(value.formattedValue, value.formattedPercentage)}
          />
        ))}
      </div>
    );
  }

  const formattedValue = values[0]?.formattedValue;
  return (
    <div
      className={cn(
        "text-foreground tooltip-values overflow-hidden px-3 text-right text-caption font-medium text-ellipsis whitespace-nowrap",
      )}
    >
      {chooseValue(formattedValue, values[0]?.formattedPercentage)}
    </div>
  );
};

const GroupTooltipValue: React.FC<{
  label: string;
  value: string | number | undefined;
}> = ({ label, value }) => {
  return (
    <>
      <div
        className={cn("text-body text-foreground-secondary max-w-fit truncate")}
      >
        {label}
      </div>
      <div
        className={cn(
          "text-foreground overflow-hidden text-right text-label font-medium text-ellipsis whitespace-nowrap",
        )}
      >
        {value}
      </div>
    </>
  );
};
