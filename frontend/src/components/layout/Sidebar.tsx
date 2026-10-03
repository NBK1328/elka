import { Server, Key, KeyRound, FolderTree, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUIStore, ViewType } from "@/store/uiStore";
import { SIDEBAR_WIDTH } from "@/lib/sidebar";
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
    const {t} = useTranslation(["hosts", "keys", "update", "credentials", "groups", "settings"]);
    const {activeView, setActiveView, isSidebarVisible, isSidebarTransitioning, setSelectedHostGroup} = useUIStore();
    const {status} = useSyncStore();

    const isCollapsed = !isSidebarVisible;

    let dotColor = "bg-muted-foreground";
    if (status === SyncStatus.SyncStatusSyncing) dotColor = "bg-info animate-pulse";
    if (status === SyncStatus.SyncStatusSuccess) dotColor = "bg-success";
    if (status === SyncStatus.SyncStatusError || status === SyncStatus.SyncStatusUnauthenticated) dotColor = "bg-destructive";

    return (
        <aside
            className="sidebar-transition wails-no-drag relative z-30 shrink-0"
            style={{width: isCollapsed ? 0 : SIDEBAR_WIDTH}}
        >
            <div
                className={cn(
                    "sidebar-transition pointer-events-none absolute inset-0 rounded-t-xl bg-sidebar",
                    isCollapsed && "opacity-0"
                )}
                aria-hidden="true"
            />

            {/*
                Holds the full rail width while the rail itself slides away, so the sections are not
                squeezed into it. Section tooltips hang outside the rail, so clipping is only safe while
                nothing in there can be hovered: closed or on the way there.
            */}
            <div
                className={cn(
                    "sidebar-transition relative z-10 flex h-full flex-col items-center justify-between pb-4 pt-2",
                    isCollapsed && "opacity-0",
                    (isCollapsed || isSidebarTransitioning) && "overflow-hidden"
                )}
                style={{width: SIDEBAR_WIDTH}}
                inert={isCollapsed}
            >
                <nav className="relative z-10 flex flex-col gap-2">
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
        </aside>
    );
}