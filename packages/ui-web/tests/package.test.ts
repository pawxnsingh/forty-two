import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const source = (name: string) => readFile(resolve(packageRoot, "src", name), "utf8");

describe("package contract", () => {
  it("publishes the complete source stack with explicit workspace peer boundaries", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    ) as {
      exports: Record<string, string>;
      files: string[];
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      sideEffects: string[];
    };

    expect(packageJson.exports).toEqual({
      ".": "./src/index.ts",
      "./button": "./src/button.tsx",
      "./charts": "./src/charts/index.ts",
      "./checkbox": "./src/checkbox.tsx",
      "./collapsible": "./src/collapsible.tsx",
      "./data-table": "./src/data-table.tsx",
      "./dialog": "./src/dialog.tsx",
      "./drop-zone": "./src/drop-zone.tsx",
      "./dropdown-menu": "./src/dropdown-menu.tsx",
      "./input": "./src/input.tsx",
      "./nova.css": "./src/nova.css",
      "./number-field": "./src/number-field.tsx",
      "./progress-bar": "./src/progress-bar.tsx",
      "./radio-group": "./src/radio-group.tsx",
      "./select": "./src/select.tsx",
      "./separator": "./src/separator.tsx",
      "./sheet": "./src/sheet.tsx",
      "./sidebar": "./src/sidebar.tsx",
      "./skeleton": "./src/skeleton.tsx",
      "./text-field": "./src/text-field.tsx",
      "./toast": "./src/toast.tsx",
      "./tooltip": "./src/tooltip.tsx",
      "./use-mobile": "./src/use-mobile.ts",
      "./utils": "./src/cn.ts",
    });
    expect(packageJson.files).toEqual(["src", "LICENSE.shadcn-ui"]);
    expect(packageJson.sideEffects).toEqual(["./src/nova.css"]);
    expect(packageJson.dependencies).toEqual({
      "@repo/design-tokens": "workspace:*",
      "class-variance-authority": "0.7.1",
      clsx: "2.1.1",
      "lucide-react": "1.28.0",
      // Exact-pinned: the chart layer's rendering engine is a supply-chain
      // surface, not a range to float on.
      recharts: "3.9.1",
      tailwindcss: "4.3.3",
      "tailwind-merge": "3.6.0",
    });
    expect(packageJson.peerDependencies).toEqual({
      react: "19.2.8",
      "react-aria-components": "1.20.0",
      "react-dom": "19.2.8",
    });
  });

  it("owns the pinned upstream source, MIT notice, and transformed Lucide icons", async () => {
    const [license, ...ownedSources] = await Promise.all([
      readFile(resolve(packageRoot, "LICENSE.shadcn-ui"), "utf8"),
      source("button.tsx"),
      source("collapsible.tsx"),
      source("dropdown-menu.tsx"),
      source("input.tsx"),
      source("separator.tsx"),
      source("sheet.tsx"),
      source("sidebar.tsx"),
      source("skeleton.tsx"),
      source("tooltip.tsx"),
      source("use-mobile.ts"),
      source("cn.ts"),
      source("nova.css"),
    ]);
    const combined = ownedSources.join("\n");

    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2023 shadcn");
    for (const ownedSource of ownedSources) {
      expect(ownedSource).toContain("9846e22ce52c723554742860a0dbd3e5cf19b573");
    }
    expect(combined).not.toContain("@/registry/");
    expect(combined).not.toContain("@/app/");
    expect(combined).not.toContain("IconPlaceholder");
    expect(await source("sidebar.tsx")).toContain('import { PanelLeftIcon } from "lucide-react"');
    expect(await source("sidebar.tsx")).toContain('className="rtl:rotate-180"');
    expect(await source("sidebar.tsx")).not.toContain("cn-rtl-flip");
    expect(await source("sheet.tsx")).toContain('import { XIcon } from "lucide-react"');
    expect(await source("dropdown-menu.tsx")).toContain(
      'import { CheckIcon, ChevronRightIcon } from "lucide-react"',
    );
  });

  it("keeps the sidebar dependency graph source-local and excludes the Drawer substitution", async () => {
    const sidebar = await source("sidebar.tsx");
    const sheet = await source("sheet.tsx");

    for (const dependency of [
      "./button",
      "./cn",
      "./input",
      "./separator",
      "./sheet",
      "./skeleton",
      "./tooltip",
      "./use-mobile",
    ]) {
      expect(sidebar).toContain(`from "${dependency}"`);
    }
    expect(sidebar).not.toMatch(/\bDrawer\b/);
    expect(sheet).toContain('from "./button"');
    expect(sheet).toContain('from "./cn"');
  });

  it("keeps the workflow primitives original rather than claiming shadcn provenance", async () => {
    const [dropZone, radioGroup, progressBar, nova] = await Promise.all([
      source("drop-zone.tsx"),
      source("radio-group.tsx"),
      source("progress-bar.tsx"),
      source("nova.css"),
    ]);

    // Nova has no contract for these three, so they are ours. They must not
    // carry the upstream attribution the adapted sources do.
    for (const original of [dropZone, radioGroup, progressBar]) {
      expect(original).not.toContain("9846e22ce52c723554742860a0dbd3e5cf19b573");
      expect(original).toContain('from "react-aria-components"');
      expect(original).toContain('from "./cn"');
    }

    // Built on the accessible primitives, not hand-rolled equivalents.
    expect(dropZone).toContain("DropZone as DropZonePrimitive");
    expect(dropZone).toContain("FileTrigger as FileTriggerPrimitive");
    expect(radioGroup).toContain("RadioGroup as RadioGroupPrimitive");
    expect(progressBar).toContain("ProgressBar as ProgressBarPrimitive");

    for (const contract of [
      ".cn-drop-zone",
      ".cn-radio-group",
      ".cn-radio-control",
      ".cn-progress-bar-track",
      ".cn-progress-bar-fill",
    ]) {
      expect(nova).toContain(contract);
    }
  });

  it("keeps the installable navigation composition source-local", async () => {
    const [collapsible, dropdownMenu, nova] = await Promise.all([
      source("collapsible.tsx"),
      source("dropdown-menu.tsx"),
      source("nova.css"),
    ]);

    expect(collapsible).toContain("DisclosurePanel as CollapsibleContentPrimitive");
    expect(collapsible).toContain('slot="trigger"');
    expect(dropdownMenu).toContain("MenuTrigger as MenuTriggerPrimitive");
    expect(dropdownMenu).toContain("Popover as PopoverPrimitive");
    expect(dropdownMenu).not.toContain("@/registry/");
    expect(dropdownMenu).not.toContain("IconPlaceholder");
    expect(nova).toContain(".cn-dropdown-menu-content-aria");
    expect(nova).toContain(".cn-menu-translucent");
  });

  it("builds the administration primitives on React Aria, and says where it does not", async () => {
    const [checkbox, dataTable, dialog, numberField, select, textField, toast, nova] =
      await Promise.all([
        source("checkbox.tsx"),
        source("data-table.tsx"),
        source("dialog.tsx"),
        source("number-field.tsx"),
        source("select.tsx"),
        source("text-field.tsx"),
        source("toast.tsx"),
        source("nova.css"),
      ]);

    // Ours, so they must not claim the upstream shadcn provenance.
    for (const original of [checkbox, dataTable, dialog, numberField, select, textField, toast]) {
      expect(original).not.toContain("9846e22ce52c723554742860a0dbd3e5cf19b573");
      expect(original).toContain('from "./cn"');
    }

    // Every interactive primitive is React Aria-backed rather than hand-rolled.
    expect(textField).toContain("TextField as TextFieldPrimitive");
    expect(textField).toContain("FieldError as FieldErrorPrimitive");
    expect(checkbox).toContain("Checkbox as CheckboxPrimitive");
    expect(checkbox).toContain("CheckboxGroup as CheckboxGroupPrimitive");
    expect(numberField).toContain("NumberField as NumberFieldPrimitive");
    expect(select).toContain("Select as SelectPrimitive");
    expect(select).toContain("ListBox as ListBoxPrimitive");
    expect(select).toContain("Popover as PopoverPrimitive");
    expect(dialog).toContain("ModalOverlay as ModalOverlayPrimitive");
    expect(dialog).toContain("Dialog as DialogPrimitive");
    expect(dataTable).toContain("Table as TablePrimitive");
    expect(dataTable).toContain("Row as RowPrimitive");
    for (const reactAria of [checkbox, dataTable, dialog, numberField, select, textField]) {
      expect(reactAria).toContain('from "react-aria-components"');
    }

    // The toast is the one exception, and it has to admit that in the source
    // rather than let a reader assume upstream guarantees it does not have.
    expect(toast).not.toContain('from "react-aria-components"');
    expect(toast).toContain("**This is not a React Aria component.**");
    expect(toast).toContain("Toast primitive");

    for (const contract of [
      ".cn-field-label",
      ".cn-field-error",
      ".cn-checkbox-control",
      ".cn-number-field-group",
      ".cn-select-trigger",
      ".cn-dialog-overlay",
      ".cn-data-table",
      ".cn-toast-region",
    ]) {
      expect(nova).toContain(contract);
    }
  });
});
