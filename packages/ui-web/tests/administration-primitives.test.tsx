import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These use `fireEvent` rather than `@testing-library/user-event`, which the
 * repository does not depend on. Where a test needs focus to move, it moves it
 * explicitly and then asserts what the component did with it — so tab *order*
 * is asserted through `tabIndex`/`disabled`, and everything React Aria does in
 * response to a key is driven with a real `keydown`.
 */

import {
  Checkbox,
  CheckboxGroup,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableColumn,
  DataTableHeader,
  DataTableRow,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  NumberField,
  Select,
  SelectItem,
  TextField,
  ToastProvider,
  useToast,
} from "../src/index";
import { Button } from "../src/button";

/** Elements the browser would stop at, in document order. */
function tabbable(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"),
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("tabindex") !== "-1" &&
      element.getAttribute("aria-hidden") !== "true",
  );
}

function press(element: Element, key: string) {
  fireEvent.keyDown(element, { key });
  fireEvent.keyUp(element, { key });
}

describe("TextField", () => {
  it("associates its label, description and validation message with the input", () => {
    render(
      <TextField
        description="Shown to your team."
        errorMessage="A name is required."
        isInvalid
        label="Credential name"
      />,
    );

    const input = screen.getByRole("textbox", { name: "Credential name" });
    expect(input).toHaveAccessibleDescription(/Shown to your team\./);
    expect(input).toHaveAttribute("aria-invalid", "true");
    // The message must reach the accessible description, not merely be painted
    // somewhere nearby.
    expect(input).toHaveAccessibleDescription(/A name is required\./);
  });

  it("does not report an error before one exists", () => {
    render(<TextField errorMessage="A name is required." label="Credential name" />);

    const input = screen.getByRole("textbox", { name: "Credential name" });
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("A name is required.")).not.toBeInTheDocument();
  });

  it("takes a disabled field out of the tab order", () => {
    render(
      <>
        <TextField isDisabled label="Credential name" />
        <Button>After</Button>
      </>,
    );

    expect(screen.getByRole("textbox", { name: "Credential name" })).toBeDisabled();
    expect(tabbable()).toEqual([screen.getByRole("button", { name: "After" })]);
  });
});

describe("Checkbox and CheckboxGroup", () => {
  it("announces the set as one named field rather than loose checkboxes", () => {
    render(
      <CheckboxGroup description="Choose what this key may do." label="Permissions">
        <Checkbox value="sign:write">Start signing</Checkbox>
        <Checkbox value="verify:write">Start verification</Checkbox>
      </CheckboxGroup>,
    );

    const group = screen.getByRole("group", { name: "Permissions" });
    expect(group).toHaveAccessibleDescription(/Choose what this key may do\./);
    expect(within(group).getAllByRole("checkbox")).toHaveLength(2);
  });

  it("reports selection through a real focusable input, not a painted box", () => {
    render(
      <CheckboxGroup label="Permissions">
        <Checkbox value="sign:write">Start signing</Checkbox>
      </CheckboxGroup>,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Start signing" });
    expect(checkbox).not.toBeChecked();
    // A real input is in the tab order and toggles on activation, which is
    // what makes Space work without any key handling of our own.
    expect(tabbable()).toContain(checkbox);

    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it("surfaces group validation", () => {
    render(
      <CheckboxGroup errorMessage="Choose at least one permission." isInvalid label="Permissions">
        <Checkbox value="sign:write">Start signing</Checkbox>
      </CheckboxGroup>,
    );

    expect(screen.getByRole("group", { name: "Permissions" })).toHaveAccessibleDescription(
      /Choose at least one permission\./,
    );
  });
});

describe("NumberField", () => {
  it("names the field and announces it as a number field", () => {
    render(
      <NumberField
        defaultValue={2}
        label="Concurrent deliveries"
        maxValue={20}
        minValue={1}
        step={1}
      />,
    );

    // React Aria 1.20 renders a numeric textbox rather than a `spinbutton`
    // role, so it keeps browser autofill and IME behaviour and announces its
    // purpose through `aria-roledescription`.
    const field = screen.getByRole("textbox", { name: "Concurrent deliveries" });
    expect(field).toHaveAttribute("aria-roledescription", "Number field");
    expect(field).toHaveAttribute("inputmode", "numeric");
    expect(field).toHaveValue("2");
  });

  it("steps with the arrow keys and clamps at the server's ceiling", () => {
    render(
      <NumberField defaultValue={19} label="Concurrent deliveries" maxValue={20} minValue={1} />,
    );

    const field = screen.getByRole("textbox", { name: "Concurrent deliveries" });
    field.focus();
    press(field, "ArrowUp");
    expect(field).toHaveValue("20");
    // Already at the ceiling: stepping again must not exceed it.
    press(field, "ArrowUp");
    expect(field).toHaveValue("20");
  });

  it("clamps a typed value that exceeds the bound rather than sending it", () => {
    render(
      <NumberField defaultValue={2} label="Concurrent deliveries" maxValue={20} minValue={1} />,
    );

    const field = screen.getByRole("textbox", { name: "Concurrent deliveries" });
    fireEvent.change(field, { target: { value: "999" } });
    fireEvent.blur(field);
    expect(field).toHaveValue("20");
  });

  it("keeps the stepper buttons out of the tab order", () => {
    render(
      <>
        <NumberField defaultValue={2} label="Concurrent deliveries" />
        <Button>After</Button>
      </>,
    );

    // Two stepper buttons exist and are reachable by pointer, but tabbing goes
    // straight from the input to whatever follows the field.
    // Their names are composed from the action and the field, so a screen
    // reader reaching one by pointer still knows which field it steps.
    expect(screen.getByRole("button", { name: /^Decrease/ })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: /^Increase/ })).toHaveAttribute("tabindex", "-1");
    expect(tabbable()).toEqual([
      screen.getByRole("textbox", { name: "Concurrent deliveries" }),
      screen.getByRole("button", { name: "After" }),
    ]);
  });
});

describe("Select", () => {
  it("opens a listbox from the keyboard and returns focus to the trigger on select", async () => {
    const onSelectionChange = vi.fn();
    render(
      <Select label="Environment" onSelectionChange={onSelectionChange} placeholder="Choose one">
        <SelectItem id="test" textValue="Test">
          Test
        </SelectItem>
        <SelectItem id="live" textValue="Live">
          Live
        </SelectItem>
      </Select>,
    );

    const trigger = screen.getByRole("button", { name: /Environment/ });
    trigger.focus();
    press(trigger, "Enter");

    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(2);

    fireEvent.click(options[1]!);
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(onSelectionChange).toHaveBeenCalledWith("live");
    // Focus must come back to where it left, or a keyboard user is stranded.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not open while disabled", () => {
    render(
      <Select isDisabled label="Environment">
        <SelectItem id="test">Test</SelectItem>
      </Select>,
    );

    const trigger = screen.getByRole("button", { name: /Environment/ });
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toBeDisabled();
  });
});

describe("Dialog", () => {
  it("wires the title and description and moves focus inside", async () => {
    render(
      <Dialog defaultOpen>
        <DialogHeader description="This cannot be undone." title="Revoke credential" />
        <DialogBody>
          <Button>Confirm</Button>
        </DialogBody>
      </Dialog>,
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Revoke credential");
    expect(dialog).toHaveAccessibleDescription(/This cannot be undone\./);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("uses alertdialog semantics for a destructive confirmation", async () => {
    render(
      <Dialog defaultOpen mode="destructive">
        <DialogHeader description="Integrations will stop working." title="Delete endpoint" />
      </Dialog>,
    );

    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName("Delete endpoint");
  });

  it("closes a dismissible dialog on Escape", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog defaultOpen onOpenChange={onOpenChange}>
        <DialogHeader onClose={() => onOpenChange(false)} title="Create endpoint" />
      </Dialog>,
    );

    const dialog = await screen.findByRole("dialog");
    press(dialog, "Escape");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("refuses Escape in acknowledge mode so a one-time secret is not lost by reflex", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog defaultOpen mode="acknowledge" onOpenChange={onOpenChange}>
        <DialogHeader title="Save your secret" />
        <DialogFooter>
          <Button>I have saved it</Button>
        </DialogFooter>
      </Dialog>,
    );

    const dialog = await screen.findByRole("alertdialog");
    press(dialog, "Escape");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });

  it("does not close an acknowledge dialog on a backdrop click either", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog defaultOpen mode="acknowledge" onOpenChange={onOpenChange}>
        <DialogHeader title="Save your secret" />
      </Dialog>,
    );

    await screen.findByRole("alertdialog");
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay!, { button: 0, detail: 1 });
    fireEvent.pointerUp(overlay!, { button: 0, detail: 1 });
    fireEvent.click(overlay!, { button: 0, detail: 1 });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("marks the rest of the page inert so focus cannot walk out", async () => {
    render(
      <>
        <Button>Outside</Button>
        <Dialog defaultOpen>
          <DialogHeader title="Create endpoint" />
          <DialogFooter>
            <Button>Confirm</Button>
          </DialogFooter>
        </Dialog>
      </>,
    );

    await screen.findByRole("dialog");
    // React Aria hides the rest of the tree from assistive technology while a
    // modal is open, which is what stops a screen reader walking out of it.
    // The button is only findable with `hidden: true` precisely because of it.
    expect(screen.queryByRole("button", { name: "Outside" })).not.toBeInTheDocument();
    const outside = screen.getByRole("button", { hidden: true, name: "Outside" });
    expect(
      outside.closest("[aria-hidden='true']") !== null || outside.closest("[inert]") !== null,
    ).toBe(true);
  });
});

describe("DataTable", () => {
  const rows = [
    { id: "whe_1", destination: "https://a.example/hooks", status: "Active" },
    { id: "whe_2", destination: "https://b.example/hooks", status: "Disabled" },
  ];

  function Table({ onRowAction }: { onRowAction?: (key: React.Key) => void }) {
    return (
      <DataTable aria-label="Endpoints" onRowAction={onRowAction}>
        <DataTableHeader>
          <DataTableColumn isRowHeader>Destination</DataTableColumn>
          <DataTableColumn>Status</DataTableColumn>
        </DataTableHeader>
        <DataTableBody items={rows}>
          {(row) => (
            <DataTableRow id={row.id}>
              <DataTableCell label="Destination">{row.destination}</DataTableCell>
              <DataTableCell label="Status">{row.status}</DataTableCell>
            </DataTableRow>
          )}
        </DataTableBody>
      </DataTable>
    );
  }

  it("renders real table semantics with named columns", () => {
    render(<Table />);

    const grid = screen.getByRole("grid", { name: "Endpoints" });
    expect(within(grid).getAllByRole("columnheader")).toHaveLength(2);
    expect(within(grid).getAllByRole("row")).toHaveLength(3);
  });

  it("activates a row from the keyboard, not only from a pointer", () => {
    const onRowAction = vi.fn();
    render(<Table onRowAction={onRowAction} />);

    const row = screen.getAllByRole("row")[1]!;
    row.focus();
    press(row, "Enter");
    expect(onRowAction).toHaveBeenCalledWith("whe_1");
  });

  it("repeats the column name per cell for the stacked layout, hidden from assistive tech", () => {
    render(<Table />);

    const label = screen.getAllByText("Destination", { selector: ".cn-data-table-cell-label" })[0];
    expect(label).toHaveAttribute("aria-hidden", "true");
  });
});

describe("ToastProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  type Variant = "info" | "success" | "danger";

  function Harness({ variant }: { variant?: Variant }) {
    const { toast } = useToast();
    return <Button onPress={() => toast({ title: "Endpoint created", variant })}>Notify</Button>;
  }

  function renderHarness(variant?: Variant) {
    return render(
      <ToastProvider>
        <Harness variant={variant} />
      </ToastProvider>,
    );
  }

  function notify() {
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("announces routine confirmations politely and failures assertively", async () => {
    const { unmount } = renderHarness("success");
    notify();
    expect(await screen.findByRole("status")).toHaveTextContent("Endpoint created");
    unmount();

    renderHarness("danger");
    notify();
    expect(await screen.findByRole("alert")).toHaveTextContent("Endpoint created");
  });

  it("exposes the queue as a labelled landmark", async () => {
    renderHarness();
    notify();
    await screen.findByRole("status");
    expect(screen.getByRole("region", { name: "Notifications" })).toBeInTheDocument();
  });

  it("dismisses on its own after the dwell time", async () => {
    renderHarness();
    notify();
    expect(await screen.findByRole("status")).toBeInTheDocument();

    await advance(7_000);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("pauses while hovered so a toast cannot vanish as the pointer arrives", async () => {
    renderHarness();
    notify();
    await screen.findByRole("status");
    const region = screen.getByRole("region", { name: "Notifications" });

    fireEvent.pointerEnter(region);
    await advance(9_000);
    expect(screen.getByRole("status")).toBeInTheDocument();

    fireEvent.pointerLeave(region);
    await advance(7_000);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("pauses while focus is inside, which is the keyboard half of the same rule", async () => {
    renderHarness();
    notify();
    await screen.findByRole("status");

    fireEvent.focus(screen.getByRole("region", { name: "Notifications" }));
    await advance(9_000);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("gives every toast an individually addressable dismiss control", async () => {
    renderHarness();
    notify();
    await screen.findByRole("status");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss: Endpoint created" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("bounds the queue instead of stacking over the page", async () => {
    function Burst() {
      const { toast } = useToast();
      return (
        <Button
          onPress={() => {
            for (let index = 0; index < 5; index += 1) toast({ title: `Message ${index}` });
          }}
        >
          Burst
        </Button>
      );
    }
    render(
      <ToastProvider>
        <Burst />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Burst" }));
    await waitFor(() => expect(screen.getAllByRole("status")).toHaveLength(3));
    // The newest survive; the oldest are dropped.
    expect(screen.getByText("Message 4")).toBeInTheDocument();
    expect(screen.queryByText("Message 0")).not.toBeInTheDocument();
  });

  it("keeps a toast until dismissed when it is given no duration", async () => {
    function Sticky() {
      const { toast } = useToast();
      return (
        <Button onPress={() => toast({ duration: null, title: "Secret shown once" })}>
          Notify
        </Button>
      );
    }
    render(
      <ToastProvider>
        <Sticky />
      </ToastProvider>,
    );

    notify();
    await screen.findByRole("status");
    await advance(30_000);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("refuses to be used outside its provider rather than silently doing nothing", () => {
    expect(() => renderHook(() => useToast())).toThrow(/must be used inside a ToastProvider/);
  });
});
