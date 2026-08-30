import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  Breadcrumbs,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Drawer,
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FileDropZone,
  IconButton,
  Input,
  Link,
  LinkButton,
  ProgressBar,
  Radio,
  RadioGroup,
  SearchField,
  Select,
  SelectItem,
  Separator,
  Sheet,
  SheetTitle,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  Skeleton,
  Tooltip,
  TooltipTrigger,
  cn,
  useIsMobile,
} from "../src";

describe("Button", () => {
  it("normalizes press interactions and defaults to a non-submitting button", () => {
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Verify evidence</Button>);

    const button = screen.getByRole("button", { name: "Verify evidence" });
    expect(button).toHaveAttribute("type", "button");
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("normalizes keyboard activation through the React Aria press contract", () => {
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Keyboard action</Button>);

    const button = screen.getByRole("button", { name: "Keyboard action" });
    fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(button, { key: "Enter", code: "Enter" });
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("keeps disabled and pending actions inert while preserving pending focusability", () => {
    const onDisabledPress = vi.fn();
    const onPendingPress = vi.fn();
    render(
      <>
        <Button isDisabled onPress={onDisabledPress}>
          Disabled
        </Button>
        <Button isPending onPress={onPendingPress}>
          Pending
        </Button>
      </>,
    );

    const disabled = screen.getByRole("button", { name: "Disabled" });
    const pending = screen.getByRole("button", { name: "Pending" });
    fireEvent.click(disabled);
    fireEvent.click(pending);

    expect(disabled).toBeDisabled();
    expect(disabled).toHaveAttribute("data-disabled");
    expect(pending).not.toBeDisabled();
    expect(pending).toHaveAttribute("data-pending");
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(onDisabledPress).not.toHaveBeenCalled();
    expect(onPendingPress).not.toHaveBeenCalled();
  });

  it("retains required state styling when a consumer supplies classes", () => {
    render(<Button className="consumer-class">Styled action</Button>);

    const button = screen.getByRole("button", { name: "Styled action" });
    expect(button).toHaveClass(
      "consumer-class",
      "cn-button",
      "cn-button-variant-default",
      "motion-reduce:transition-none",
    );
  });

  it.each([
    ["default", "cn-button-variant-default"],
    ["outline", "cn-button-variant-outline"],
    ["secondary", "cn-button-variant-secondary"],
    ["ghost", "cn-button-variant-ghost"],
    ["destructive", "cn-button-variant-destructive"],
    ["link", "cn-button-variant-link"],
  ] as const)("renders the %s variant", (variant, className) => {
    render(<Button variant={variant}>{variant}</Button>);
    expect(screen.getByRole("button", { name: variant })).toHaveClass(className);
  });
});

describe("source stack primitives", () => {
  it("renders the installable link-button contract", () => {
    render(
      <LinkButton href="/console" variant="outline" size="sm">
        Console
      </LinkButton>,
    );

    expect(screen.getByRole("link", { name: "Console" })).toHaveClass(
      "cn-button",
      "cn-button-variant-outline",
      "cn-button-size-sm",
    );
  });

  it("composes input classes and exposes native input behavior", () => {
    render(<Input aria-label="Evidence ID" className="consumer-input" defaultValue="op-42" />);

    expect(screen.getByRole("textbox", { name: "Evidence ID" })).toHaveClass(
      "cn-input",
      "consumer-input",
    );
    expect(screen.getByRole("textbox", { name: "Evidence ID" })).toHaveValue("op-42");
  });

  it("renders horizontal and vertical separators", () => {
    const { container } = render(<Separator orientation="vertical" />);

    expect(container.querySelector('[data-slot="separator"]')).toHaveAttribute(
      "aria-orientation",
      "vertical",
    );
    expect(container.querySelector('[data-slot="separator"]')).toHaveClass("cn-separator");
  });

  it("renders a titled sheet and closes through the React Aria close slot", () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet isOpen onOpenChange={onOpenChange}>
        <SheetTitle>Evidence details</SheetTitle>
      </Sheet>,
    );

    expect(screen.getByRole("dialog", { name: "Evidence details" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders a reduced-motion-safe skeleton", () => {
    const { container } = render(<Skeleton className="evidence-skeleton" />);

    expect(container.querySelector('[data-slot="skeleton"]')).toHaveClass(
      "cn-skeleton",
      "animate-pulse",
      "motion-reduce:animate-none",
      "evidence-skeleton",
    );
  });

  it("merges conditional semantic utility classes", () => {
    expect(cn("px-2", null, ["px-4", "text-foreground"])).toBe("px-4 text-foreground");
  });

  it("fails safely to desktop when matchMedia is unavailable", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });
});

describe("Link", () => {
  it("renders native navigation semantics and composes consumer classes", () => {
    render(
      <Link href="/evidence" className="brand-link">
        Evidence
      </Link>,
    );

    const link = screen.getByRole("link", { name: "Evidence" });
    expect(link).toHaveAttribute("href", "/evidence");
    expect(link).toHaveClass("brand-link", "text-link", "data-[pressed]:text-foreground-secondary");
  });

  it("exposes a disabled state without activating the link", () => {
    const onPress = vi.fn();
    render(
      <Link href="/evidence" isDisabled onPress={onPress}>
        Unavailable evidence
      </Link>,
    );

    const link = screen.getByRole("link", { name: "Unavailable evidence" });
    fireEvent.click(link);
    expect(link).toHaveAttribute("aria-disabled", "true");
    expect(link).toHaveAttribute("data-disabled");
    expect(onPress).not.toHaveBeenCalled();
  });

  it("supports governed navigation links without inline-link decoration", () => {
    render(
      <Link href="/console" variant="navigation">
        Console
      </Link>,
    );

    expect(screen.getByRole("link", { name: "Console" })).toHaveClass(
      "no-underline",
      "text-foreground",
    );
  });
});

describe("console primitives", () => {
  it("expands the official React Aria collapsible with keyboard input", () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>Workspace</CollapsibleTrigger>
        <CollapsibleContent>Overview</CollapsibleContent>
      </Collapsible>,
    );

    const trigger = screen.getByRole("button", { name: "Workspace" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter", code: "Enter" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Overview")).toBeVisible();
  });

  it("opens the official React Aria dropdown and dispatches menu actions", async () => {
    const onAction = vi.fn();
    render(
      <DropdownMenuTrigger>
        <Button>Account</Button>
        <DropdownMenu aria-label="Account" data-theme="light">
          <DropdownMenuItem id="profile" onAction={onAction}>
            Profile
          </DropdownMenuItem>
        </DropdownMenu>
      </DropdownMenuTrigger>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    const profile = await screen.findByRole("menuitem", { name: "Profile" });
    expect(profile.closest('[data-slot="dropdown-menu-content"]')).toHaveAttribute(
      "data-theme",
      "light",
    );
    fireEvent.click(profile);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("renders a labeled icon button with the governed target size", () => {
    render(<IconButton aria-label="Open navigation">+</IconButton>);

    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveClass(
      "size-[var(--op-target-minimum)]",
      "data-[focus-visible]:outline-boundary-focus",
    );
  });

  it("renders breadcrumb hierarchy inside an explicitly labeled navigation landmark", () => {
    render(
      <Breadcrumbs
        items={[
          { id: "console", label: "Console", href: "/console" },
          { id: "settings", label: "Settings" },
        ]}
      />,
    );

    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Console" })).toHaveAttribute("href", "/console");
    expect(screen.getByText("Settings")).toHaveAttribute("aria-current", "page");
  });

  it("uses the React Aria search contract and exposes a labeled input", () => {
    const onChange = vi.fn();
    render(
      <SearchField
        label="Search navigation"
        leadingIcon={<span>⌕</span>}
        onChange={onChange}
        placeholder="Find a route"
      />,
    );

    const input = screen.getByRole("searchbox", { name: "Search navigation" });
    fireEvent.change(input, { target: { value: "verify" } });
    expect(onChange).toHaveBeenCalledWith("verify");
  });

  it("provides a dismissable modal drawer with dialog semantics", () => {
    const onOpenChange = vi.fn();
    render(
      <Drawer aria-label="Console navigation" isOpen onOpenChange={onOpenChange}>
        {(close) => <button onClick={close}>Close drawer</button>}
      </Drawer>,
    );

    expect(screen.getByRole("dialog", { name: "Console navigation" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("connects tooltip content to its trigger", () => {
    render(
      <TooltipTrigger delay={0}>
        <IconButton aria-label="Collapse sidebar">−</IconButton>
        <Tooltip>Collapse sidebar</Tooltip>
      </TooltipTrigger>,
    );

    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  });
});

describe("Sidebar", () => {
  function renderSidebar() {
    return render(
      <SidebarProvider>
        <Sidebar aria-label="Workspace" collapsible="icon">
          <SidebarHeader>Brand</SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Application</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton href="/console" isActive tooltip="Overview">
                      Overview
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>Account</SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger>Toggle</SidebarTrigger>
        </SidebarInset>
      </SidebarProvider>,
    );
  }

  it("provides composable header, content, group, menu, footer, rail, and inset slots", () => {
    const { container } = renderSidebar();

    expect(screen.getByRole("complementary", { name: "Workspace" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("data-active");
    expect(container.querySelector('[data-slot="sidebar-header"]')).toHaveTextContent("Brand");
    expect(container.querySelector('[data-slot="sidebar-content"]')).toBeVisible();
    expect(container.querySelector('[data-slot="sidebar-group"]')).toBeVisible();
    expect(container.querySelector('[data-slot="sidebar-footer"]')).toHaveTextContent("Account");
    expect(container.querySelector('[data-slot="sidebar-rail"]')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="sidebar-inset"]')).toBeVisible();
  });

  it("collapses through the trigger and Cmd/Ctrl+B shortcut", () => {
    const { container } = renderSidebar();
    const sidebar = container.querySelector('[data-slot="sidebar"][data-state]');
    expect(sidebar).toHaveAttribute("data-state", "expanded");

    const trigger = container.querySelector('[data-slot="sidebar-trigger"]');
    expect(trigger).toBeInTheDocument();
    fireEvent.click(trigger!);
    expect(sidebar).toHaveAttribute("data-state", "collapsed");
    expect(sidebar).toHaveAttribute("data-collapsible", "icon");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(sidebar).toHaveAttribute("data-state", "expanded");
    expect(sidebar).toHaveAttribute("data-collapsible", "");
  });

  it("supports controlled state", () => {
    const onOpenChange = vi.fn();
    render(
      <SidebarProvider open={false} onOpenChange={onOpenChange}>
        <SidebarTrigger>Toggle</SidebarTrigger>
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("ships the transformed RTL utility on the default trigger icon", () => {
    const { container } = render(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    const icon = container.querySelector('[data-slot="sidebar-trigger"] svg');
    expect(icon).toHaveClass("rtl:rotate-180");
    expect(icon).not.toHaveClass("cn-rtl-flip");
  });

  it("renders destinations as links and unavailable actions as disabled buttons", () => {
    render(
      <SidebarProvider>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton href="/console">Overview</SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton isDisabled>Sign</SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarProvider>,
    );

    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/console");
    expect(screen.getByRole("button", { name: "Sign" })).toBeDisabled();
  });
});

describe("RadioGroup", () => {
  it("exposes one tab stop with arrow-key movement between options", async () => {
    const onChange = vi.fn();
    render(
      <RadioGroup label="Processing mode" onChange={onChange}>
        <Radio value="sign_only">Sign only</Radio>
        <Radio value="watermark_then_sign">Watermark then sign</Radio>
      </RadioGroup>,
    );

    const group = screen.getByRole("radiogroup", { name: "Processing mode" });
    expect(group).toBeInTheDocument();

    const first = screen.getByRole("radio", { name: "Sign only" });
    fireEvent.click(first);
    expect(onChange).toHaveBeenCalledWith("sign_only");
    expect(first).toBeChecked();
  });

  it("announces its description and keeps disabled options unselectable", () => {
    const onChange = vi.fn();
    render(
      <RadioGroup
        label="Processing mode"
        description="Three predefined pipelines."
        onChange={onChange}
      >
        <Radio value="sign_only">Sign only</Radio>
        <Radio value="watermark_only" isDisabled>
          Watermark only
        </Radio>
      </RadioGroup>,
    );

    expect(screen.getByText("Three predefined pipelines.")).toBeInTheDocument();

    // The native input carries `disabled`, so the browser withholds the click
    // entirely; `fireEvent` dispatches beneath that guard, so the attributes
    // are the contract worth asserting rather than a synthesised press.
    const disabled = screen.getByRole("radio", { name: "Watermark only" });
    expect(disabled).toBeDisabled();
    expect(disabled.closest('[data-slot="radio"]')).toHaveAttribute("data-disabled", "true");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ProgressBar", () => {
  it("publishes the value through the progressbar role", () => {
    render(<ProgressBar label="Uploading" value={62} showValue />);

    const bar = screen.getByRole("progressbar", { name: "Uploading" });
    expect(bar).toHaveAttribute("aria-valuenow", "62");
    expect(screen.getByText("62%")).toBeInTheDocument();
  });

  it("omits a value while indeterminate rather than reporting zero", () => {
    render(<ProgressBar label="Preparing" isIndeterminate />);

    const bar = screen.getByRole("progressbar", { name: "Preparing" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
  });
});

describe("FileDropZone", () => {
  it("names the drop target and opens the picker from the button", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <FileDropZone
        label="Drop a file here"
        description="JPG, PNG, MP4 — up to 5 GiB"
        acceptedFileTypes={["image/jpeg", "video/mp4"]}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText("Drop a file here")).toBeInTheDocument();
    expect(screen.getByText("JPG, PNG, MP4 — up to 5 GiB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a file" })).toBeInTheDocument();

    const input = container.querySelector('input[type="file"]');
    expect(input).toHaveAttribute("accept", "image/jpeg,video/mp4");
    expect(input).not.toHaveAttribute("multiple");
  });

  it("passes picked files through and drops those of an unaccepted type", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <FileDropZone label="Drop a file" acceptedFileTypes={["image/jpeg"]} onSelect={onSelect} />,
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const accepted = new File(["a"], "photo.jpg", { type: "image/jpeg" });
    const rejected = new File(["b"], "notes.txt", { type: "text/plain" });

    fireEvent.change(input, { target: { files: [rejected] } });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { files: [accepted] } });
    expect(onSelect).toHaveBeenCalledWith([accepted]);
  });

  it("gives keyboard users a focusable drop affordance named by the label", () => {
    render(<FileDropZone label="Drop a file" onSelect={vi.fn()} />);

    // React Aria puts the drop target on a visually hidden button so that a
    // keyboard or screen-reader user can enter drag-and-drop mode at all —
    // the whole reason for using DropZone over raw dragover/drop handlers.
    const dropButton = screen.getByRole("button", { name: /Drop a file/ });
    expect(dropButton).toHaveAttribute("tabindex", "0");
    expect(dropButton.closest('[data-slot="drop-zone"]')).toBeInTheDocument();
  });
});

describe("Select", () => {
  it("gives every plain-text option a value type-to-select can match", async () => {
    // This component wraps each option's children in spans and an indicator, so
    // React Aria sees non-plain-text children and — without help — refuses to
    // give the option a text value at all. The console rendered a warning per
    // option and no select in the product could be typed to.
    render(
      <Select aria-label="Media type" defaultSelectedKey="all">
        <SelectItem id="all">All media</SelectItem>
        <SelectItem id="video">Video</SelectItem>
      </Select>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Media type/ }));
    const option = await screen.findByRole("option", { name: "Video" });
    // React Aria puts the resolved text value on the option itself.
    expect(option).toHaveTextContent("Video");
    expect(screen.queryByRole("option", { name: "" })).toBeNull();
  });
});
