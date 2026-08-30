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
  IconButton,
  Input,
  Link,
  LinkButton,
  SearchField,
  Separator,
  Sheet,
  SheetTitle,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  Skeleton,
  Tooltip,
  TooltipTrigger,
} from "../src";

const typedButton = (
  <Button variant="secondary" onPress={(event) => event.continuePropagation()}>
    Continue
  </Button>
);
const typedCollapsible = (
  <Collapsible defaultExpanded>
    <CollapsibleTrigger>Workspace</CollapsibleTrigger>
    <CollapsibleContent>Overview</CollapsibleContent>
  </Collapsible>
);
const typedDropdownMenu = (
  <DropdownMenuTrigger>
    <Button>Account</Button>
    <DropdownMenu aria-label="Account" data-theme="light">
      <DropdownMenuItem id="profile">Profile</DropdownMenuItem>
    </DropdownMenu>
  </DropdownMenuTrigger>
);
const typedLink = <Link href="/evidence">Evidence</Link>;
const typedNavigationLink = (
  <Link href="/console" variant="navigation">
    Console
  </Link>
);
const typedIconButton = <IconButton aria-label="Menu">M</IconButton>;
const typedBreadcrumbs = <Breadcrumbs items={[{ id: "console", label: "Console" }]} />;
const typedDrawer = (
  <Drawer aria-label="Navigation" isOpen={false} onOpenChange={() => undefined}>
    Navigation
  </Drawer>
);
const typedSearch = <SearchField label="Search" />;
const typedInput = <Input aria-label="Evidence ID" />;
const typedSeparator = <Separator orientation="vertical" />;
const typedSheet = (
  <Sheet isOpen={false} onOpenChange={() => undefined}>
    <SheetTitle>Evidence</SheetTitle>
  </Sheet>
);
const typedSkeleton = <Skeleton />;
const typedLinkButton = <LinkButton href="/console">Console</LinkButton>;
const typedTooltip = (
  <TooltipTrigger>
    {typedIconButton}
    <Tooltip>Menu</Tooltip>
  </TooltipTrigger>
);
const typedSidebar = (
  <SidebarProvider
    style={
      {
        "--sidebar-width": "18rem",
        "--sidebar-width-icon": "5rem",
      } as React.CSSProperties
    }
  >
    <Sidebar collapsible="icon">
      <SidebarHeader>Header</SidebarHeader>
      <SidebarContent>
        <SidebarGroup>Group</SidebarGroup>
      </SidebarContent>
      <SidebarFooter>Footer</SidebarFooter>
      <SidebarRail />
    </Sidebar>
    <SidebarInset>
      <SidebarTrigger>Toggle</SidebarTrigger>
    </SidebarInset>
  </SidebarProvider>
);

// @ts-expect-error The pinned source stack has no "primary" alias.
const speculativeVariant = <Button variant="primary">Primary</Button>;

void typedButton;
void typedCollapsible;
void typedDropdownMenu;
void typedLink;
void typedNavigationLink;
void typedBreadcrumbs;
void typedDrawer;
void typedIconButton;
void typedSearch;
void typedInput;
void typedSeparator;
void typedSheet;
void typedSkeleton;
void typedLinkButton;
void typedTooltip;
void typedSidebar;
void speculativeVariant;
