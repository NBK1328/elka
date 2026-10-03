import { useMemo, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/store/sessionStore";
import type { TerminalSplitLayout } from "@/store/sessionStore";
import { TerminalInstance } from "@/components/terminal/TerminalInstance";
import { cn } from "@/lib/utils";

interface TerminalStackProps {
    isVisible: boolean;
}

// Must match the pane header height in TerminalInstance.
const PANE_HEADER_HEIGHT = 24;

interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface PositionedPane {
    sessionId: string;
    rect: Rect;
}

interface SplitDivider {
    path: string;
    axis: "columns" | "rows";
    position: number;
    crossStart: number;
    crossSize: number;
    regionSize: number;
    ratio: number;
}

interface ResizeDrag {
    pointerId: number;
    path: string;
    axis: "columns" | "rows";
    startCoordinate: number;
    startRatio: number;
    regionPixels: number;
}

function layoutPanes(
    layout: TerminalSplitLayout | null,
    rect: Rect = {left: 0, top: 0, width: 1, height: 1},
    path = "",
    panes: PositionedPane[] = [],
    dividers: SplitDivider[] = [],
) {
    if (!layout) return {panes, dividers};
    if (layout.type === "pane") {
        panes.push({sessionId: layout.sessionId, rect});
        return {panes, dividers};
    }

    if (layout.direction === "horizontal") {
        const firstWidth = rect.width * layout.ratio;
        dividers.push({
            path,
            axis: "columns",
            position: rect.left + firstWidth,
            crossStart: rect.top,
            crossSize: rect.height,
            regionSize: rect.width,
            ratio: layout.ratio,
        });
        layoutPanes(layout.first, {...rect, width: firstWidth}, `${path}L`, panes, dividers);
        layoutPanes(layout.second, {
            ...rect,
            left: rect.left + firstWidth,
            width: rect.width - firstWidth,
        }, `${path}R`, panes, dividers);
    } else {
        const firstHeight = rect.height * layout.ratio;
        dividers.push({
            path,
            axis: "rows",
            position: rect.top + firstHeight,
            crossStart: rect.left,
            crossSize: rect.width,
            regionSize: rect.height,
            ratio: layout.ratio,
        });
        layoutPanes(layout.first, {...rect, height: firstHeight}, `${path}L`, panes, dividers);
        layoutPanes(layout.second, {
            ...rect,
            top: rect.top + firstHeight,
            height: rect.height - firstHeight,
        }, `${path}R`, panes, dividers);
    }

    return {panes, dividers};
}

export function TerminalStack({isVisible}: TerminalStackProps) {
    const {t} = useTranslation("terminal");
    const {
        sessions,
        activeSessionId,
        workspaces,
        activeWorkspaceID,
        setActiveSession,
        setSplitRatio,
        placeSessionBeside,
        removeSessionFromSplit,
        removeSession,
    } = useSessionStore();
    const dragRef = useRef<ResizeDrag | null>(null);
    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceID);
    const layout = activeWorkspaceID
        ? activeWorkspace?.layout || null
        : activeSessionId ? {type: "pane" as const, sessionId: activeSessionId} : null;
    const splitWorkspaceActive = !!activeWorkspaceID;
    const {panes, dividers} = useMemo(() => layoutPanes(layout), [layout]);
    const paneBySession = useMemo(() => new Map(panes.map((pane) => [pane.sessionId, pane])), [panes]);

    const startResize = (divider: SplitDivider, event: ReactPointerEvent<HTMLDivElement>) => {
        const parent = event.currentTarget.parentElement;
        const bounds = parent?.getBoundingClientRect();
        if (!bounds || divider.regionSize === 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
            pointerId: event.pointerId,
            path: divider.path,
            axis: divider.axis,
            startCoordinate: divider.axis === "columns" ? event.clientX : event.clientY,
            startRatio: divider.ratio,
            regionPixels: (divider.axis === "columns" ? bounds.width : bounds.height) * divider.regionSize,
        };
        document.body.style.cursor = divider.axis === "columns" ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
    };

    const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId || drag.regionPixels <= 0) return;
        const coordinate = drag.axis === "columns" ? event.clientX : event.clientY;
        if (activeWorkspaceID) {
            setSplitRatio(activeWorkspaceID, drag.path, drag.startRatio + (coordinate - drag.startCoordinate) / drag.regionPixels);
        }
    };

    const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    };

    return (
        <div className={cn("absolute inset-0 overflow-hidden bg-background", isVisible ? "block" : "hidden")}>
            {splitWorkspaceActive && !activeWorkspace?.layout && isVisible && (
                <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-muted-foreground">
                    {t("empty_split_workspace")}
                </div>
            )}
            {/*
                Panes and dividers share this offset container: it becomes their containing block, so
                their percentages measure that region. Split panes start flush with the sidebar and step
                back from the right window edge, so their frames line up and stay visible; a lone
                terminal runs to the window edges and keeps only the padding inside the pane, so its top
                edge sits on the same line as the sidebar.
            */}
            <div className={cn(
                "absolute bottom-0 left-0 top-0",
                splitWorkspaceActive ? "right-1" : "right-0"
            )}>
            {sessions.map((session) => {
                const pane = paneBySession.get(session.id);
                // Panes fill their region exactly, so the black surface reaches the window edges and
                // the dividers ride on top of it instead of eating into the pane width.
                const layoutStyle: CSSProperties | undefined = pane ? {
                    position: "absolute",
                    left: `${pane.rect.left * 100}%`,
                    top: `${pane.rect.top * 100}%`,
                    width: `${pane.rect.width * 100}%`,
                    height: `${pane.rect.height * 100}%`,
                } : undefined;

                return (
                    <TerminalInstance
                        key={session.id}
                        sessionId={session.id}
                        config={session.config}
                        isActive={session.id === activeSessionId}
                        isVisible={isVisible && !!pane}
                        isSplitPane={splitWorkspaceActive && !!pane}
                        workspaceID={splitWorkspaceActive ? activeWorkspaceID || undefined : undefined}
                        paneTitle={session.title}
                        layoutStyle={layoutStyle}
                        onFocus={() => setActiveSession(session.id)}
                        onDetachPane={() => activeWorkspaceID && removeSessionFromSplit(activeWorkspaceID, session.id)}
                        onCloseSession={() => removeSession(session.id)}
                        onDropSession={(draggedID, targetID, placement) => {
                            if (activeWorkspaceID) placeSessionBeside(activeWorkspaceID, targetID, draggedID, placement);
                        }}
                    />
                );
            })}
            {splitWorkspaceActive && activeWorkspace?.layout && dividers.map((divider) => (
                <div
                    key={divider.path || "root"}
                    role="separator"
                    aria-orientation={divider.axis === "columns" ? "vertical" : "horizontal"}
                    aria-label={t("resize_split_pane")}
                    onPointerDown={(event) => startResize(divider, event)}
                    onPointerMove={moveResize}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    // Invisible handle: the seam between two black panes is the only grab affordance, and it starts
                    // below the pane header so it never covers the pane buttons. Hover tint stays white
                    // based because the seam always sits on the terminal background.
                    className={divider.axis === "columns"
                        ? "absolute z-30 w-1.5 -translate-x-1/2 cursor-col-resize touch-none hover:bg-white/25 active:bg-white/40"
                        : "absolute z-30 h-1.5 -translate-y-1/2 cursor-row-resize touch-none hover:bg-white/25 active:bg-white/40"}
                    style={divider.axis === "columns"
                        ? {
                            left: `${divider.position * 100}%`,
                            top: `calc(${divider.crossStart * 100}% + ${PANE_HEADER_HEIGHT}px)`,
                            height: `max(10px, calc(${divider.crossSize * 100}% - ${PANE_HEADER_HEIGHT}px))`,
                        }
                        : {top: `${divider.position * 100}%`, left: `${divider.crossStart * 100}%`, width: `${divider.crossSize * 100}%`}}
                />
            ))}
            </div>
        </div>
    );
}
