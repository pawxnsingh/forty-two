import { config } from "@repo/eslint-config/react-internal";

export default [
  ...config,
  {
    // Recharts is an implementation detail of the chart module. Anywhere else
    // in this package — and, by the matching rule in the applications, anywhere
    // else in the monorepo — importing it would leak vendor geometry and
    // vendor styling into code that is supposed to express product data.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/charts/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "recharts",
              message:
                "Import the Op*Chart wrappers from @repo/ui-web/charts. Recharts stays private to src/charts.",
            },
          ],
          patterns: [
            {
              group: ["recharts/*"],
              message:
                "Import the Op*Chart wrappers from @repo/ui-web/charts. Recharts stays private to src/charts.",
            },
          ],
        },
      ],
    },
  },
];
