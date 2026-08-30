import {
  DEFAULT_CHART_CONFIG,
  DEFAULT_COLUMN_LABEL_FORMAT,
} from "@viz/metrics-schema";
import type { BubbleDataPoint, ScriptableContext } from "chart.js";
import { addOpacityToColor } from "@viz/lib/colors";
import { createDayjsDate } from "@viz/lib/date";
import { isDateColumnType } from "@viz/lib/messages";
import { formatLabelForDataset } from "../../../commonHelpers";
import type { ChartProps } from "../../core";
import { createTrendlineOnSeries } from "./createTrendlines";
import type { SeriesBuilderProps } from "./interfaces";
import type { LabelBuilderProps } from "./useSeriesOptions";

const WEEK_BUCKET_RE = /\b(wm\s*week|week_number|week number)\b/i;

const encodeWeekBucketOrdinal = (xValue: number): number => {
  const whole = Math.trunc(xValue);
  const year = Math.floor(whole / 100);
  const week = whole % 100;
  if (year <= 0 || week <= 0) return whole;
  return year * 53 + week;
};

declare module "chart.js" {
  interface BubbleDataPoint {
    originalR: number;
  }
}

const colorsRecord: Record<
  string,
  {
    color: string;
    backgroundColor: string;
    hoverBackgroundColor: string;
    borderColor: string;
  }
> = {};

export const scatterSeriesBuilder_data = ({
  colors,
  scatterDotSize,
  columnLabelFormats,
  xAxisKeys,
  sizeOptions,
  datasetOptions,
  trendlines,
}: SeriesBuilderProps): ChartProps<"bubble">["data"]["datasets"] => {
  const xAxisKey = xAxisKeys[0] || "";
  const xAxisColumnLabelFormat =
    columnLabelFormats[xAxisKey] || DEFAULT_COLUMN_LABEL_FORMAT;
  const isXAxisDate = isDateColumnType(xAxisColumnLabelFormat.columnType);
  const isWeekBucketXAxis = WEEK_BUCKET_RE.test(xAxisKey);

  const hasSizeKeyIndex = sizeOptions !== null && !!sizeOptions.key;

  const useCustomScatterElementConfig =
    hasSizeKeyIndex ||
    scatterDotSize?.[0] !== DEFAULT_CHART_CONFIG.scatterDotSize[0] ||
    scatterDotSize?.[1] !== DEFAULT_CHART_CONFIG.scatterDotSize[1];

  const scatterElementConfig = useCustomScatterElementConfig
    ? {
        point: {
          radius: (context: ScriptableContext<"bubble">) =>
            radiusMethod(context, sizeOptions, scatterDotSize),
        },
      }
    : undefined;

  return datasetOptions.datasets.map((dataset, datasetIndex) => {
    const color = colors[datasetIndex % colors.length] || "";
    let backgroundColor = colorsRecord[color]?.backgroundColor;
    let hoverBackgroundColor = colorsRecord[color]?.hoverBackgroundColor;
    let borderColor = colorsRecord[color]?.borderColor;

    if (!colorsRecord[color]) {
      backgroundColor = addOpacityToColor(color, 0.6);
      hoverBackgroundColor = addOpacityToColor(color, 0.9);
      borderColor = color;
      colorsRecord[color] = {
        color,
        backgroundColor,
        hoverBackgroundColor,
        borderColor,
      };
    }

    return {
      parsing: false, //we need to make sure the data is sorted
      label: formatLabelForDataset(dataset, columnLabelFormats),
      // @ts-expect-error - elements is not a valid prop for dataset
      elements: scatterElementConfig,
      backgroundColor,
      hoverBackgroundColor,
      borderColor: color,
      tooltipData: dataset.tooltipData,
      yAxisKey: dataset.dataKey,
      xAxisKeys,
      trendline: createTrendlineOnSeries({
        trendlines,
        datasetColor: color,
        yAxisKey: dataset.dataKey,
        columnLabelFormats,
      }),
      data: dataset.data.reduce<BubbleDataPoint[]>((acc, yData, index) => {
        if (yData !== null) {
          acc.push({
            x: getScatterXValue({
              isXAxisDate,
              isWeekBucketXAxis,
              xValue: dataset.ticksForScatter?.[index]?.[0] ?? null,
            }),
            y: yData,
            r: scatterDotSize?.[0] ?? DEFAULT_CHART_CONFIG.scatterDotSize[0],
            originalR: dataset.sizeData?.[index] ?? 0,
          });
        }
        return acc;
      }, []),
    } satisfies ChartProps<"bubble">["data"]["datasets"][number];
  });
};

const getScatterXValue = ({
  isXAxisDate,
  isWeekBucketXAxis,
  xValue,
}: {
  isXAxisDate: boolean;
  isWeekBucketXAxis: boolean;
  xValue: number | string | Date | null;
}): number => {
  if (isXAxisDate && xValue) {
    return createDayjsDate(xValue as string).valueOf();
  }

  if (isWeekBucketXAxis && typeof xValue === "number") {
    return encodeWeekBucketOrdinal(xValue);
  }

  return xValue as number;
};

const radiusMethod = (
  context: ScriptableContext<"bubble">,
  sizeOptions: SeriesBuilderProps["sizeOptions"],
  scatterDotSize: SeriesBuilderProps["scatterDotSize"],
) => {
  const originalR = (context.raw as BubbleDataPoint)?.originalR;

  if (typeof originalR === "number" && sizeOptions) {
    return computeSizeRatio(
      originalR,
      scatterDotSize,
      sizeOptions.minValue,
      sizeOptions.maxValue,
    );
  }

  return scatterDotSize?.[0] ?? DEFAULT_CHART_CONFIG.scatterDotSize[0];
};

const computeSizeRatio = (
  size: number,
  scatterDotSize: SeriesBuilderProps["scatterDotSize"],
  minValue: number,
  maxValue: number,
) => {
  const minRange =
    scatterDotSize?.[0] ?? DEFAULT_CHART_CONFIG.scatterDotSize[0];
  const maxRange =
    scatterDotSize?.[1] ?? DEFAULT_CHART_CONFIG.scatterDotSize[1];

  if (minValue === maxValue) {
    return (minRange + maxRange) / 2;
  }

  const ratio = (size - minValue) / (maxValue - minValue);
  const computedSize = minRange + ratio * (maxRange - minRange);

  return computedSize;
};

export const scatterSeriesBuilder_labels = (_props: LabelBuilderProps) => {
  return undefined;
};
