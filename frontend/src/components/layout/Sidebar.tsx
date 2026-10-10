import { Server, Key, KeyRound, FolderTree, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUIStore, ViewType } from "@/store/uiStore";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { ServerMetricsPanel } from "@/components/layout/ServerMetricsPanel";
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
    const {t} = useTranslation(["hosts", "keys", "credentials", "groups", "settings"]);
    const {activeView, setActiveView, isSidebarVisible, setSelectedHostGroup} = useUIStore();

    return (
        // Only the width is animated: the content lives in an inner block of fixed width, so icons and
        // metrics never squeeze together with the panel, and tooltips can still stick out past its
        // edge while the panel is open. The content fades on the same duration as the panel and
        // slightly later, otherwise the icons vanish before the panel has finished collapsing.
        <aside
            className={cn(
                "wails-no-drag relative z-30 flex shrink-0 flex-col",
                "transition-[width] duration-200 ease-out motion-reduce:transition-none",
                isSidebarVisible ? "w-14" : "w-0 overflow-hidden border-r-0"
            )}
            aria-hidden={!isSidebarVisible}
        >
            <div className="pointer-events-none absolute inset-0 rounded-t-xl bg-sidebar" aria-hidden="true"/>

            {/* Bottom items keep the same offset from the bottom edge of the tab at any tab height: the value
                is derived from --tab-height in main.css. */}
            <div className={cn(
                "relative z-10 flex h-full w-14 shrink-0 flex-col items-center justify-between pb-[var(--sidebar-bottom)] pt-2",
                // Slides out to the left and fades on the same duration as the panel, with a delay on
                // the way out so the icons do not disappear before the panel has finished collapsing.
                "transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
                isSidebarVisible ? "opacity-100 delay-100" : "pointer-events-none -translate-x-full opacity-0 delay-0"
            )}>
            {/* Icons and metrics share one group, but their widths differ: the panel width must not
                    stretch the icon list, or the icons drift off centre. */}
                <div className="flex flex-col items-center gap-3">
                    <nav className="flex flex-col items-center gap-2">
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

                    {/* Metrics sit under the last icon rather than at the bottom edge, so they stay next to the tab
                        they belong to. */}
                    <ServerMetricsPanel/>
                </div>

                <nav className="flex flex-col items-center gap-2">
                    <SidebarItem
                        title={t("page_title", {ns: "settings"})}
                        active={activeView === ViewType.Settings}
                        onClick={() => setActiveView(ViewType.Settings)}
                    >
                        <Settings className="size-5"/>
                    </SidebarItem>
                </nav>
            </div>
        </aside>
    );
}
