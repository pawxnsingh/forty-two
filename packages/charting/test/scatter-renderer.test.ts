import assert from "node:assert/strict";
import { test } from "node:test";

import { scatterSeriesBuilder_data } from "../src/viz/components/ui/charts/ChartJS/hooks/useSeriesOptions/scatterSeriesBuilder.ts";

test("scatter points retain a visible radius without a size column", () => {
  const datasets = scatterSeriesBuilder_data({
    colors: ["#123456"],
    scatterDotSize: [3, 15],
    columnLabelFormats: {},
    xAxisKeys: ["Sales"],
    sizeOptions: null,
    datasetOptions: {
      datasets: [
        {
          id: "Profit",
          label: ["Profit"],
          data: [75],
          dataKey: "Profit",
          axisType: "y",
          tooltipData: [[]],
          ticksForScatter: [[225]],
        },
      ],
      ticksKey: [],
      ticks: [],
    },
    trendlines: [],
  } as never);

  assert.deepEqual(datasets[0]?.data, [{ x: 225, y: 75, r: 3, originalR: 0 }]);
});
