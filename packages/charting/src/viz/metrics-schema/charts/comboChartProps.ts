import { z } from "zod";
import { ComboChartAxisSchema } from "./axisInterfaces.ts";

export const ComboChartPropsSchema = z.object({
  // Required for Combo
  comboChartAxis: ComboChartAxisSchema,
});

export type ComboChartProps = z.infer<typeof ComboChartPropsSchema>;
