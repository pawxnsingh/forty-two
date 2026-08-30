"use client";

import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SidebarProvider,
  ToastProvider,
  useSidebar,
} from "@repo/ui-web";
import {
  ArrowUpRight,
  Bell,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  CircleUserRound,
  House,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button as AriaButton, Link as AriaLink } from "react-aria-components";

export interface ApplicationNavigationItem {
  href: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
  variant?: "default" | "recent";
}

export interface ApplicationNavigationSection {
  id: string;
  items: readonly ApplicationNavigationItem[];
  label?: string;
  pinnedToBottom?: boolean;
  scrollable?: boolean;
}

export interface ApplicationBreadcrumb {
  id: string;
  label: string;
  href?: string;
}

export interface ApplicationAccount {
  imageUrl?: string | null;
  name: string;
}

export interface ApplicationResourceCard {
  artworkUrl?: string;
  description: string;
  href: string;
  icons?: readonly {
    icon: ReactNode;
    label: string;
  }[];
  label: string;
  title: string;
}

export interface ApplicationShellProps {
  account?: ApplicationAccount | null;
  accountSettingsHref?: string;
  brand: ReactNode;
  brandHref?: string;
  brandLabel?: string;
  breadcrumbs?: readonly ApplicationBreadcrumb[];
  children: ReactNode;
  currentPath: string;
  defaultSidebarOpen?: boolean;
  navigation: readonly ApplicationNavigationSection[];
  onManageAccount?: () => void;
  onNotifications?: () => void;
  onSearch?: () => void;
  onSignOut?: () => void | Promise<void>;
  resourceCard?: ApplicationResourceCard;
  searchLabel?: string;
  topbarEnd?: ReactNode;
  workspaceLabel?: string;
}

export function accountInitials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function isCurrent(item: ApplicationNavigationItem, pathname: string) {
  if (item.href.includes("#") || /^https?:\/\//.test(item.href)) return false;
  if (item.href === "/") return pathname === "/";
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function BrandMark({
  children,
  href,
  label,
}: {
  children: ReactNode;
  href: string;
  label: string;
}) {
  return (
    <AriaLink aria-label={label} className="console-brand" href={href}>
      {children}
    </AriaLink>
  );
}

function ApplicationSearch({
  label,
  onSearch,
}: {
  label: string;
  onSearch?: () => void;
}) {
  return (
    <button
      aria-description={onSearch ? undefined : "Coming soon"}
      aria-label={label}
      className="console-search"
      disabled={!onSearch}
      onClick={onSearch}
      title={onSearch ? undefined : "Search is coming soon"}
      type="button"
    >
      <Search aria-hidden="true" size={16} strokeWidth={1.9} />
      <span className="console-search-placeholder">{label}</span>
      <kbd aria-hidden="true">⌘K</kbd>
    </button>
  );
}

function NavigationLink({
  item,
  pathname,
}: {
  item: ApplicationNavigationItem;
  pathname: string;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const active = isCurrent(item, pathname);
  const external = /^https?:\/\//.test(item.href);
  const Icon = item.icon;

  return (
    <AriaLink
      aria-current={active ? "page" : undefined}
      aria-label={item.label}
      className="console-nav-item"
      data-variant={item.variant}
      href={item.href}
      onPress={() => {
        if (isMobile) setOpenMobile(false);
      }}
      rel={external ? "noreferrer" : undefined}
      target={external ? "_blank" : undefined}
    >
      <Icon aria-hidden="true" size={18} strokeWidth={2} />
      <span>{item.label}</span>
    </AriaLink>
  );
}

function NavigationSection({
  pathname,
  section,
  withRule,
}: {
  pathname: string;
  section: ApplicationNavigationSection;
  withRule: boolean;
}) {
  return (
    <>
      {withRule ? <hr className="console-nav-rule" /> : null}
      <h2
        className={section.label ? "console-nav-group" : "visually-hidden"}
        id={`app-nav-${section.id}`}
      >
        {section.label ?? "Navigation"}
      </h2>
      {section.items.map((item) => (
        <NavigationLink
          item={item}
          key={`${section.id}-${item.href}`}
          pathname={pathname}
        />
      ))}
    </>
  );
}

function ResourceCard({ resource }: { resource: ApplicationResourceCard }) {
  const external = /^https?:\/\//.test(resource.href);
  return (
    <aside className="console-plan">
      <div className="console-plan-content">
        <div className="console-plan-top">
          {resource.artworkUrl ? (
            <img
              alt=""
              className="console-plan-art"
              src={resource.artworkUrl}
            />
          ) : null}
          <span aria-hidden="true" className="console-plan-scrim" />
          <span className="console-plan-badge">
            <Sparkles
              aria-hidden="true"
              color="#fff"
              size={14}
              strokeWidth={1.9}
            />
          </span>
          <p className="console-plan-title">{resource.title}</p>
          <p className="console-plan-copy">{resource.description}</p>
          {resource.icons?.length ? (
            <div
              aria-label="Available connector types"
              className="console-plan-icons"
            >
              {resource.icons.map(({ icon, label }) => (
                <span className="console-plan-icon" key={label} title={label}>
                  {icon}
                </span>
              ))}
              <AriaLink
                aria-label={resource.label}
                className="console-plan-icon console-plan-icon--action"
                href={resource.href}
                rel={external ? "noreferrer" : undefined}
                target={external ? "_blank" : undefined}
              >
                <Plus aria-hidden="true" size={13} strokeWidth={2} />
              </AriaLink>
            </div>
          ) : null}
        </div>
        {!resource.icons?.length ? (
          <AriaLink
            className="console-plan-cta"
            href={resource.href}
            rel={external ? "noreferrer" : undefined}
            target={external ? "_blank" : undefined}
          >
            <span>{resource.label}</span>
            <ArrowUpRight aria-hidden="true" size={15} strokeWidth={2} />
          </AriaLink>
        ) : null}
      </div>
    </aside>
  );
}

function ApplicationRail({
  brand,
  brandHref,
  brandLabel,
  currentPath,
  inDrawer = false,
  navigation,
  onSearch,
  resourceCard,
  searchLabel,
}: Pick<
  ApplicationShellProps,
  | "brand"
  | "brandHref"
  | "brandLabel"
  | "currentPath"
  | "navigation"
  | "onSearch"
  | "resourceCard"
  | "searchLabel"
> & { inDrawer?: boolean }) {
  const { isMobile, setOpenMobile, state, toggleSidebar } = useSidebar();
  const collapsed = !inDrawer && !isMobile && state === "collapsed";
  const regularSections = navigation.filter(
    (section) => !section.pinnedToBottom,
  );
  const fixedSections = regularSections.filter((section) => !section.scrollable);
  const scrollableSections = regularSections.filter(
    (section) => section.scrollable,
  );
  const footerSections = navigation.filter((section) => section.pinnedToBottom);
  let labelledSectionCount = 0;

  return (
    <nav aria-label="Application" className="console-sidebar">
      <div className="console-brand-row">
        <BrandMark
          href={brandHref ?? "/"}
          label={brandLabel ?? "Forty Two home"}
        >
          {brand}
        </BrandMark>
        <button
          aria-label={
            inDrawer
              ? "Close navigation"
              : collapsed
                ? "Expand sidebar"
                : "Collapse sidebar"
          }
          className="console-collapse"
          onClick={inDrawer ? () => setOpenMobile(false) : toggleSidebar}
          type="button"
        >
          {inDrawer ? (
            <X aria-hidden="true" size={14} strokeWidth={2} />
          ) : (
            <span aria-hidden="true" className="console-collapse-icons">
              <ChevronsLeft className="console-collapse-icon console-collapse-icon--close" />
              <ChevronsRight className="console-collapse-icon console-collapse-icon--open" />
            </span>
          )}
        </button>
      </div>

      {onSearch ? (
        <ApplicationSearch
          label={searchLabel ?? "Search anything…"}
          onSearch={onSearch}
        />
      ) : null}

      {fixedSections.map((section) => {
        const withRule =
          section.label !== undefined && labelledSectionCount++ > 0;
        return (
          <NavigationSection
            key={section.id}
            pathname={currentPath}
            section={section}
            withRule={withRule}
          />
        );
      })}

      {scrollableSections.map((section) => (
        <div className="console-nav-scroll-section" key={section.id}>
          <h2
            className={section.label ? "console-nav-group" : "visually-hidden"}
            id={`app-nav-${section.id}`}
          >
            {section.label ?? "Navigation"}
          </h2>
          <div className="console-nav-scroll">
            {section.items.map((item) => (
              <NavigationLink
                item={item}
                key={`${section.id}-${item.href}`}
                pathname={currentPath}
              />
            ))}
          </div>
        </div>
      ))}

      {footerSections.map((section) => (
        <NavigationSection
          key={section.id}
          pathname={currentPath}
          section={section}
          withRule={false}
        />
      ))}

      {resourceCard ? <ResourceCard resource={resourceCard} /> : null}
    </nav>
  );
}

function Breadcrumbs({
  breadcrumbs,
}: {
  breadcrumbs: readonly ApplicationBreadcrumb[];
}) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="console-crumb">
        {breadcrumbs.map((crumb, index) => {
          const last = index === breadcrumbs.length - 1;
          return (
            <li key={crumb.id}>
              {index ? (
                <span aria-hidden="true" className="console-crumb-sep">
                  /
                </span>
              ) : (
                <House aria-hidden="true" size={16} strokeWidth={1.8} />
              )}
              {last || !crumb.href ? (
                <span aria-current={last ? "page" : undefined}>
                  {crumb.label}
                </span>
              ) : (
                <AriaLink href={crumb.href}>{crumb.label}</AriaLink>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function AccountMenu({
  account,
  onManage,
  onSignOut,
  settingsHref,
}: {
  account: ApplicationAccount | null;
  onManage?: () => void;
  onSignOut?: () => void | Promise<void>;
  settingsHref: string;
}) {
  const displayName = account?.name ?? "Account";
  return (
    <DropdownMenuTrigger>
      <AriaButton
        aria-label={`Account menu for ${displayName}`}
        className="console-account"
      >
        <span aria-hidden="true" className="console-avatar">
          {account?.imageUrl ? (
            <img
              alt=""
              className="console-avatar-image"
              src={account.imageUrl}
            />
          ) : account ? (
            accountInitials(displayName)
          ) : (
            <CircleUserRound size={15} strokeWidth={1.8} />
          )}
        </span>
        <span className="console-account-name">{displayName}</span>
        <ChevronsUpDown aria-hidden="true" size={14} strokeWidth={2} />
      </AriaButton>
      <DropdownMenu
        aria-label="Account"
        className="z-[80] w-[min(18rem,calc(100vw-2rem))]"
        offset={8}
        placement="bottom end"
      >
        {onManage ? (
          <DropdownMenuItem
            id="manage-account"
            onAction={onManage}
            textValue="Manage account"
          >
            <CircleUserRound aria-hidden="true" className="size-4 shrink-0" />
            <span>Manage account</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          href={settingsHref}
          id="settings"
          textValue="Settings"
        >
          <Settings aria-hidden="true" className="size-4 shrink-0" />
          <span>Settings</span>
        </DropdownMenuItem>
        {onSignOut ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              id="sign-out"
              onAction={() => void onSignOut()}
              textValue="Sign out"
              variant="destructive"
            >
              <LogOut aria-hidden="true" className="size-4 shrink-0" />
              <span>Sign out</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}

function ApplicationFrame(
  props: Omit<ApplicationShellProps, "defaultSidebarOpen">,
) {
  const { isMobile, openMobile, setOpenMobile, state } = useSidebar();
  const [hydrated, setHydrated] = useState(false);
  const collapsed = !isMobile && state === "collapsed";
  const hasAccountMenu = Boolean(
    props.account || props.onManageAccount || props.onSignOut,
  );
  const hasTopbarActions = Boolean(
    props.topbarEnd || props.onNotifications || hasAccountMenu,
  );

  useEffect(() => setHydrated(true), []);

  return (
    <div
      className="console-shell"
      data-console-hydrated={hydrated}
      data-console-shell
      data-sidebar-state={collapsed ? "collapsed" : "expanded"}
    >
      <a className="console-skip" href="#application-content">
        Skip to application content
      </a>

      {isMobile ? (
        <Sheet
          className="console-drawer"
          isOpen={openMobile}
          onOpenChange={setOpenMobile}
          showCloseButton={false}
          side="left"
        >
          <SheetHeader className="visually-hidden">
            <SheetTitle>Application navigation</SheetTitle>
            <SheetDescription>
              Navigate the Forty Two workspace.
            </SheetDescription>
          </SheetHeader>
          <ApplicationRail {...props} inDrawer />
        </Sheet>
      ) : (
        <ApplicationRail {...props} />
      )}

      <main
        aria-label={props.workspaceLabel ?? "Application workspace"}
        className="console-workspace"
      >
        <header className="console-topbar">
          {isMobile ? (
            <button
              aria-label="Open navigation"
              className="console-icon-button"
              onClick={() => setOpenMobile(true)}
              type="button"
            >
              <Menu aria-hidden="true" size={17} strokeWidth={1.8} />
            </button>
          ) : null}
          <Breadcrumbs breadcrumbs={props.breadcrumbs ?? []} />
          {hasTopbarActions ? (
            <div className="console-topbar-actions">
              {props.topbarEnd ? (
                <span className="console-topbar-signature">
                  {props.topbarEnd}
                </span>
              ) : null}
              {props.onNotifications ? (
                <button
                  aria-label="Notifications"
                  className="console-icon-button"
                  onClick={props.onNotifications}
                  type="button"
                >
                  <Bell aria-hidden="true" size={17} strokeWidth={1.8} />
                </button>
              ) : null}
              {hasAccountMenu ? (
                <AccountMenu
                  account={props.account ?? null}
                  onManage={props.onManageAccount}
                  onSignOut={props.onSignOut}
                  settingsHref={props.accountSettingsHref ?? "/settings"}
                />
              ) : null}
            </div>
          ) : null}
        </header>
        <div className="console-page" id="application-content" tabIndex={-1}>
          {props.children}
        </div>
      </main>
    </div>
  );
}

export function ApplicationShell({
  defaultSidebarOpen = true,
  ...props
}: ApplicationShellProps) {
  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <ToastProvider>
        <ApplicationFrame {...props} />
      </ToastProvider>
    </SidebarProvider>
  );
}
