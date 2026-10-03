import { Plus } from "lucide-react";
import {
    splitWorkspaceTabID,
    terminalSessionTabID,
    terminalTabGroupID,
    useSessionStore,
} from "@/store/sessionStore";
import { useUIStore, ViewType } from "@/store/uiStore";
import { WindowControls } from "@/components/layout/WindowControls";
import { TerminalTab } from "@/components/layout/TerminalTab";
import { SplitWorkspaceTab } from "@/components/layout/SplitWorkspaceTab";
import { TabGroupTab } from "@/components/layout/TabGroupTab";
import { NameDialog } from "@/components/layout/NameDialog";
import { SFTPBrowser } from "@/components/terminal/SFTPBrowser";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MACOS_TRAFFIC_LIGHTS_WIDTH, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from "@/lib/sidebar";
import { useAuthStore } from "@/store/authStore.ts";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TerminalSplitLayout } from "@/store/sessionStore";

function splitPaneCount(layout: TerminalSplitLayout | null): number {
    if (!layout) return 0;
    if (layout.type === "pane") return 1;
    return splitPaneCount(layout.first) + splitPaneCount(layout.second);
}

interface PointerTabDrag {
    pointerID: number;
    tabID: string;
    sessionID?: string;
    startX: number;
    startY: number;
    moved: boolean;
    cleanUp: () => void;
}

interface PointerDropPreview {
    tabID: string;
    after: boolean;
    kind: "reorder" | "move";
}

export function TitleBar() {
    const {
        sessions,
        activeSessionId,
        workspaces,
        activeWorkspaceID,
        tabGroups,
        topTabOrder,
        setActiveSession,
        removeSession,
        duplicateSession,
        closeOtherSessions,
        addSessionToSplit,
        placeSessionBeside,
        createSplitWorkspace,
        renameSplitWorkspace,
        setActiveWorkspace,
        closeSplitWorkspace,
        reorderTopTab,
        createTabGroup,
        renameTabGroup,
        moveSessionToGroup,
        removeSessionFromGroup,
        ungroupTabs,
    } = useSessionStore();
    const {activeView, isSidebarVisible, setActiveView, setSelectedHostGroup} = useUIStore();

    const isTerminalView = activeView === ViewType.Terminal;
    const isMacOS = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

    const {isUnlocked} = useAuthStore();
    const {t} = useTranslation(["hosts", "common"]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const [groupDialogOpen, setGroupDialogOpen] = useState(false);
    const [groupSessionID, setGroupSessionID] = useState<string | null>(null);
    const [sftpSessionID, setSftpSessionID] = useState<string | null>(null);
    const pointerTabDragRef = useRef<PointerTabDrag | null>(null);
    const paneDropTargetRef = useRef<HTMLElement | null>(null);
    const suppressClickUntilRef = useRef(0);
    const [pointerDropPreview, setPointerDropPreview] = useState<PointerDropPreview | null>(null);

    useEffect(() => () => {
        pointerTabDragRef.current?.cleanUp();
        paneDropTargetRef.current?.removeAttribute("data-top-tab-drop-target");
    }, []);

    const handleTabPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || pointerTabDragRef.current) return;
        const target = event.target as HTMLElement;
        if (target.closest("button,[data-no-tab-drag]")) return;
        const tab = target.closest<HTMLElement>("[data-top-tab-id]");
        const tabID = tab?.dataset.topTabId;
        if (!tab || !tabID) return;

        const drag: PointerTabDrag = {
            pointerID: event.pointerId,
            tabID,
            sessionID: tab.dataset.sessionId,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            cleanUp: () => {},
        };

        const clearPreview = () => {
            paneDropTargetRef.current?.removeAttribute("data-top-tab-drop-target");
            paneDropTargetRef.current = null;
            setPointerDropPreview(null);
        };

        const handlePointerMove = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== drag.pointerID) return;
            if (!drag.moved && Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY) < 5) return;
            drag.moved = true;
            moveEvent.preventDefault();

            const hovered = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null;
            const targetTab = hovered?.closest<HTMLElement>("[data-top-tab-id]");
            if (targetTab && targetTab.dataset.topTabId !== drag.tabID) {
                clearPreview();
                const after = moveEvent.clientX >= targetTab.getBoundingClientRect().left + targetTab.getBoundingClientRect().width / 2;
                const kind = drag.sessionID && (targetTab.dataset.workspaceId || targetTab.dataset.groupId) ? "move" : "reorder";
                setPointerDropPreview((current) => current && current.tabID === targetTab.dataset.topTabId && current.after === after && current.kind === kind
                    ? current
                    : {tabID: targetTab.dataset.topTabId!, after, kind});
                return;
            }

            const pane = hovered?.closest<HTMLElement>("[data-split-pane-id]");
            if (pane && drag.sessionID) {
                if (paneDropTargetRef.current !== pane) {
                    clearPreview();
                    paneDropTargetRef.current = pane;
                }
                pane.setAttribute("data-top-tab-drop-target", "true");
                setPointerDropPreview(null);
                return;
            }
            clearPreview();
        };

        const finishDrag = (finishEvent: PointerEvent) => {
            if (finishEvent.pointerId !== drag.pointerID) return;
            drag.cleanUp();
            pointerTabDragRef.current = null;

            if (drag.moved && finishEvent.type !== "pointercancel") {
                finishEvent.preventDefault();
                const hovered = document.elementFromPoint(finishEvent.clientX, finishEvent.clientY) as HTMLElement | null;
                const targetTab = hovered?.closest<HTMLElement>("[data-top-tab-id]");
                suppressClickUntilRef.current = targetTab && scrollRef.current?.contains(targetTab) ? Date.now() + 180 : 0;
                if (drag.sessionID && targetTab?.dataset.workspaceId) {
                    addSessionToSplit(drag.sessionID, targetTab.dataset.workspaceId);
                } else if (drag.sessionID && targetTab?.dataset.groupId) {
                    moveSessionToGroup(drag.sessionID, targetTab.dataset.groupId);
                } else if (targetTab?.dataset.topTabId) {
                    const after = finishEvent.clientX >= targetTab.getBoundingClientRect().left + targetTab.getBoundingClientRect().width / 2;
                    reorderTopTab(drag.tabID, targetTab.dataset.topTabId, after);
                } else {
                    const pane = hovered?.closest<HTMLElement>("[data-split-pane-id]");
                    const workspaceID = pane?.dataset.workspaceId;
                    const targetSessionID = pane?.dataset.splitPaneId;
                    if (drag.sessionID && pane && workspaceID && targetSessionID && targetSessionID !== drag.sessionID) {
                        const bounds = pane.getBoundingClientRect();
                        const x = (finishEvent.clientX - bounds.left) / bounds.width;
                        const y = (finishEvent.clientY - bounds.top) / bounds.height;
                        const candidates: ["left" | "right" | "above" | "below", number][] = [
                            ["left", x], ["right", 1 - x], ["above", y], ["below", 1 - y],
                        ];
                        const placement = candidates.reduce((closest, candidate) => candidate[1] < closest[1] ? candidate : closest)[0];
                        placeSessionBeside(workspaceID, targetSessionID, drag.sessionID, placement);
                    }
                }
            }

            clearPreview();
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", finishDrag);
            window.removeEventListener("pointercancel", finishDrag);
        };

        drag.cleanUp = () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", finishDrag);
            window.removeEventListener("pointercancel", finishDrag);
        };
        pointerTabDragRef.current = drag;
        window.addEventListener("pointermove", handlePointerMove, {passive: false});
        window.addEventListener("pointerup", finishDrag);
        window.addEventListener("pointercancel", finishDrag);
    };

    const handleTabClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
        if (Date.now() >= suppressClickUntilRef.current) return;
        suppressClickUntilRef.current = 0;
        event.preventDefault();
        event.stopPropagation();
    };

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        if (scrollRef.current && e.deltaY !== 0) {
            const scrollAmount = e.deltaY;
            scrollRef.current.scrollLeft += scrollAmount;
        }
    };

    const workspaceSessionIDs = new Set(workspaces.flatMap((workspace) => {
        const collect = (layout: typeof workspace.layout): string[] => {
            if (!layout) return [];
            if (layout.type === "pane") return [layout.sessionId];
            return [...collect(layout.first), ...collect(layout.second)];
        };
        return collect(workspace.layout);
    }));
    const visibleSessions = sessions.filter((session) => !workspaceSessionIDs.has(session.id));
    const groupedSessionIDs = new Set(tabGroups.flatMap((group) => group.sessionIds));
    const visibleStandaloneSessions = visibleSessions.filter((session) => !groupedSessionIDs.has(session.id));
    const visibleTabIDs = [
        ...visibleStandaloneSessions.map((session) => terminalSessionTabID(session.id)),
        ...tabGroups.map((group) => terminalTabGroupID(group.id)),
        ...workspaces.map((workspace) => splitWorkspaceTabID(workspace.id)),
    ];
    const orderedTabIDs = [
        ...topTabOrder.filter((tabID) => visibleTabIDs.includes(tabID)),
        ...visibleTabIDs.filter((tabID) => !topTabOrder.includes(tabID)),
    ];
    const sessionByTabID = new Map(visibleStandaloneSessions.map((session) => [terminalSessionTabID(session.id), session]));
    const groupByTabID = new Map(tabGroups.map((group) => [terminalTabGroupID(group.id), group]));
    const workspaceByTabID = new Map(workspaces.map((workspace) => [splitWorkspaceTabID(workspace.id), workspace]));
    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceID);
    // Column the tab bar keeps free on its left: the sidebar rail below it, or on macOS the traffic lights
    // the system draws there, which stay put while the rail slides. The strip and the drag handle read it,
    // so both travel with the rail instead of leaving the tab bar stranded at a fixed offset.
    const railWidth = isMacOS
        ? MACOS_TRAFFIC_LIGHTS_WIDTH
        : (isSidebarVisible ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH);

    return (
        <header className="wails-no-drag relative flex h-14 shrink-0 items-end justify-between bg-background pr-0">
            <div className="sidebar-transition wails-drag absolute top-0 right-0 z-20 h-4" style={{left: railWidth}} aria-hidden="true"/>

            {/* The rail never leaves the frame for good: closed, it still holds the toggle button, so its
                background stays put and only the width moves. */}
            <div
                className={cn(
                    "sidebar-transition relative flex h-full shrink-0 items-center justify-center overflow-hidden",
                    isMacOS ? "bg-background" : "border-r bg-sidebar"
                )}
                style={{width: railWidth}}
                aria-hidden={isMacOS ? "true" : undefined}
            >
                {!isMacOS && <div className="absolute bottom-0 h-px w-8 bg-border"/>}
            </div>

            <div ref={scrollRef}
                  onWheel={handleWheel}
                  onPointerDownCapture={handleTabPointerDown}
                  onClickCapture={handleTabClickCapture}
                  className="wails-no-drag relative z-10 flex h-full flex-1 translate-y-1 items-center gap-1 pl-2
                             overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden"
            >
                {orderedTabIDs.map((tabID) => {
                    const workspace = workspaceByTabID.get(tabID);
                    if (workspace) {
                        return (
                            <SplitWorkspaceTab
                                key={tabID}
                                workspace={workspace}
                                isActive={isTerminalView && activeWorkspaceID === workspace.id}
                                dropEdge={pointerDropPreview?.tabID === tabID && pointerDropPreview.kind === "reorder" ? pointerDropPreview.after ? "after" : "before" : null}
                                isDropTarget={pointerDropPreview?.tabID === tabID && pointerDropPreview.kind === "move"}
                                onClick={() => setActiveWorkspace(workspace.id)}
                                onClose={() => closeSplitWorkspace(workspace.id)}
                                onCreate={createSplitWorkspace}
                                onRename={(title) => renameSplitWorkspace(workspace.id, title)}
                                onDropSession={addSessionToSplit}
                                nextWorkspaceNumber={workspaces.length + 1}
                            />
                        );
                    }
                    const group = groupByTabID.get(tabID);
                    if (group) {
                        return (
                            <TabGroupTab
                                key={tabID}
                                group={group}
                                sessions={sessions}
                                activeSessionId={activeSessionId}
                                isActive={isTerminalView && !activeWorkspaceID && group.sessionIds.includes(activeSessionId || "")}
                                dropEdge={pointerDropPreview?.tabID === tabID && pointerDropPreview.kind === "reorder" ? pointerDropPreview.after ? "after" : "before" : null}
                                isDropTarget={pointerDropPreview?.tabID === tabID && pointerDropPreview.kind === "move"}
                                onSelect={setActiveSession}
                                onCloseSession={removeSession}
                                onRename={(title) => renameTabGroup(group.id, title)}
                                onRemoveFromGroup={removeSessionFromGroup}
                                onUngroup={() => ungroupTabs(group.id)}
                                onDropSession={moveSessionToGroup}
                            />
                        );
                    }
                    const session = sessionByTabID.get(tabID);
                    if (!session) return null;
                    return (
                        <TerminalTab
                            key={session.id}
                            session={session}
                            isActive={isTerminalView && !activeWorkspaceID && session.id === activeSessionId}
                            dropEdge={pointerDropPreview?.tabID === terminalSessionTabID(session.id) && pointerDropPreview.kind === "reorder" ? pointerDropPreview.after ? "after" : "before" : null}
                            isDropTarget={pointerDropPreview?.tabID === terminalSessionTabID(session.id) && pointerDropPreview.kind === "move"}
                            onClick={() => setActiveSession(session.id)}
                            onClose={() => removeSession(session.id)}
                            onDuplicate={() => duplicateSession(session.id)}
                            onCloseOthers={() => closeOtherSessions(session.id)}
                            canCloseOthers={sessions.length > 1}
                            isInSplit={false}
                            canAddToSplit={!activeWorkspace || splitPaneCount(activeWorkspace.layout) < 6}
                            onToggleSplit={() => addSessionToSplit(
                                session.id,
                                activeWorkspaceID || undefined,
                                t("split_workspace_default_title", {ns: "terminal", number: workspaces.length + 1})
                            )}
                            groups={tabGroups}
                            onCreateGroup={() => {
                                setGroupSessionID(session.id);
                                setGroupDialogOpen(true);
                            }}
                            onMoveToGroup={(groupID) => moveSessionToGroup(session.id, groupID)}
                            onOpenSFTP={() => setSftpSessionID(session.id)}
                        />
                    );
                })}
                {isUnlocked && sessions.length > 0 && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="wails-no-drag my-1 mt-2 shrink-0"
                        title={t("new_tab")}
                        aria-label={t("new_tab")}
                        onClick={() => {
                            setSelectedHostGroup(null);
                            setActiveView(ViewType.Hosts);
                        }}
                    >
                        <Plus className="size-4"/>
                    </Button>
                )}
            </div>

            <WindowControls/>
            <NameDialog
                open={groupDialogOpen}
                title={t("new_tab_group_name", {ns: "terminal"})}
                initialName={t("tab_group_default_name", {ns: "terminal"})}
                onCancel={() => setGroupDialogOpen(false)}
                onSubmit={(title) => {
                    if (groupSessionID) createTabGroup(groupSessionID, title);
                    setGroupDialogOpen(false);
                    setGroupSessionID(null);
                }}
            />
            <SFTPBrowser
                open={!!sftpSessionID}
                session={sessions.find((session) => session.id === sftpSessionID) || null}
                onClose={() => setSftpSessionID(null)}
            />

        </header>
    );
}
