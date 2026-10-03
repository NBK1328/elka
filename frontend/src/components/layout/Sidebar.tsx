import { Server, Key, KeyRound, FolderTree, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUIStore, ViewType } from "@/store/uiStore";
import { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from "@/lib/sidebar";
import { cn } from "@/lib/utils";
import { SyncStatus } from "../../../bindings/elka-desktop/backend/internal/services/sync";
import { useSyncStore } from "@/store/syncStore.ts";
import { useTranslation } from "react-i18next";
import { UpdatePopover } from "@/components/layout/UpdatePopover.tsx";
import type { ReactNode } from "react";
import { useState } from "react";

interface SidebarItemProps {
    title: string;
    active: boolean;
    onClick: () => void;
    children: ReactNode;
    indicatorClassName?: string;
}

function SidebarItem({title, active, onClick, children, indicatorClassName}: SidebarItemProps) {
    const [isHovered, setIsHovered] = useState(false);

    return (
        <div
            className="sidebar-tooltip-parent group relative"
            onPointerEnter={() => setIsHovered(true)}
            onPointerLeave={() => setIsHovered(false)}
            onFocusCapture={() => setIsHovered(true)}
            onBlurCapture={() => setIsHovered(false)}
        >
            <Button
                variant={active ? "secondary" : "ghost"}
                size="icon"
                onClick={onClick}
                className="wails-no-drag"
                title={title}
                aria-label={title}
            >
                {children}
                {indicatorClassName && (
                    <span className={cn("absolute right-1 top-1 size-2 rounded-full border border-sidebar", indicatorClassName)}/>
                )}
            </Button>
            <span
                role="tooltip"
                className="sidebar-tooltip pointer-events-none absolute left-full top-1/2 z-[100] ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md transition-opacity"
                style={{opacity: isHovered ? 1 : 0}}
            >
                {title}
            </span>
        </div>
    );
}

export function Sidebar() {
    const {t} = useTranslation(["hosts", "keys", "update", "credentials", "groups", "settings", "common"]);
    const {activeView, setActiveView, isSidebarVisible, isSidebarTransitioning, showSidebarToggle, toggleSidebar, setSelectedHostGroup} = useUIStore();
    const {status} = useSyncStore();

    const isCollapsed = !isSidebarVisible;
    const railWidth = isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH;
    const toggleLabel = isCollapsed
        ? t("show_sidebar", {ns: "common"})
        : t("hide_sidebar", {ns: "common"});

    let dotColor = "bg-muted-foreground";
    if (status === SyncStatus.SyncStatusSyncing) dotColor = "bg-info animate-pulse";
    if (status === SyncStatus.SyncStatusSuccess) dotColor = "bg-success";
    if (status === SyncStatus.SyncStatusError || status === SyncStatus.SyncStatusUnauthenticated) dotColor = "bg-destructive";

    return (
        <aside
            className="sidebar-transition wails-no-drag relative z-30 shrink-0"
            style={{width: railWidth}}
        >
            <div className="pointer-events-none absolute inset-0 rounded-t-xl bg-sidebar" aria-hidden="true"/>

            <div className="relative z-10 flex h-full flex-col items-center pb-4 pt-2" style={{width: railWidth}}>
                {/*
                    The toggle is the first control of the rail: it belongs to the sidebar rather than to
                    the window, and staying here is what keeps it reachable once the sections are gone.
                */}
                {showSidebarToggle && (
                    <>
                        <SidebarItem title={toggleLabel} active={false} onClick={toggleSidebar}>
                            <span className="relative block size-5">
                                <PanelLeftClose
                                    className={cn("sidebar-transition absolute inset-0 size-5", isCollapsed && "scale-90 opacity-0")}
                                />
                                <PanelLeftOpen
                                    className={cn("sidebar-transition absolute inset-0 size-5", !isCollapsed && "scale-90 opacity-0")}
                                />
                            </span>
                        </SidebarItem>
                        <div className="my-2 h-px w-8 shrink-0 bg-sidebar-border" aria-hidden="true"/>
                    </>
                )}

                {/*
                    Holds the open width while the rail narrows down to the toggle, so the sections are not
                    squeezed into it. Section tooltips hang outside the rail, so clipping is only safe while
                    nothing in there can be hovered: closed or on the way there.
                */}
                <div
                    className={cn(
                        "sidebar-transition relative z-10 flex w-14 flex-1 flex-col items-center justify-between",
                        isCollapsed && "opacity-0",
                        (isCollapsed || isSidebarTransitioning) && "overflow-hidden"
                    )}
                    inert={isCollapsed}
                >
                    <nav className="relative z-10 flex flex-col gap-2 pt-2">
                        <SidebarItem
                            title={t("page_title", {ns: "hosts"})}
                            active={activeView === ViewType.Hosts}
                            onClick={() => {
                                setSelectedHostGroup(null);
                                setActiveView(ViewType.Hosts);
                            }}
                        >
                            <Server className="size-5"/>
                        </SidebarItem>

                        <SidebarItem
                            title={t("page_title", {ns: "groups"})}
                            active={activeView === ViewType.Groups}
                            onClick={() => setActiveView(ViewType.Groups)}
                        >
                            <FolderTree className="size-5"/>
                        </SidebarItem>

                        <SidebarItem
                            title={t("page_title", {ns: "keys"})}
                            active={activeView === ViewType.Keys}
                            onClick={() => setActiveView(ViewType.Keys)}
                        >
                            <Key className="size-5"/>
                        </SidebarItem>

                        <SidebarItem
                            title={t("page_title", {ns: "credentials"})}
                            active={activeView === ViewType.Credentials}
                            onClick={() => setActiveView(ViewType.Credentials)}
                        >
                            <KeyRound className="size-5"/>
                        </SidebarItem>

                    </nav>

                    <nav className="relative z-10 flex flex-col gap-2">
                        <UpdatePopover/>

                        <SidebarItem
                            title={t("page_title", {ns: "settings"})}
                            active={activeView === ViewType.Settings}
                            onClick={() => setActiveView(ViewType.Settings)}
                            indicatorClassName={dotColor}
                        >
                            <Settings className="size-5"/>
                        </SidebarItem>
                    </nav>
                </div>
            </div>
        </aside>
    );
}
