import { z } from "zod";
import { ScatterAxisSchema } from "./axisInterfaces.ts";

export const ScatterChartPropsSchema = z.object({
  // Required for Scatter
  scatterAxis: ScatterAxisSchema,
  scatterDotSize: z.tuple([z.number(), z.number()]).default([3, 15]),
});

export type ScatterChartProps = z.infer<typeof ScatterChartPropsSchema>;
