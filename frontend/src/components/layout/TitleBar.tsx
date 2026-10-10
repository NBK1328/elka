import { PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import {
    splitWorkspaceTabID,
    terminalSessionTabID,
    MAX_SPLIT_PANES,
    terminalTabGroupID,
    useSessionStore,
    paneDropPlacement,
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
import { isMac } from "@/lib/platform";
import { useAuthStore } from "@/store/authStore.ts";
import { hideSessionDragGhost, moveSessionDragGhost, showSessionDragGhost } from "@/lib/sessionDrag";
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
        reconnectSession,
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
    const {activeView, isSidebarVisible, showSidebarToggle, toggleSidebar, setActiveView, setSelectedHostGroup, setPaneDropPreview} = useUIStore();

    const isTerminalView = activeView === ViewType.Terminal;
    const isMacOS = isMac();

    const {isUnlocked} = useAuthStore();
    const showSidebarButtonVisible = isUnlocked && showSidebarToggle;
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
        hideSessionDragGhost();
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
            setPaneDropPreview(null);
        };

        const handlePointerMove = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== drag.pointerID) return;
            if (!drag.moved && Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY) < 5) return;
            if (!drag.moved) {
                drag.moved = true;
                // The tab drag runs on pointer events, so the native drag image never shows up
                // here: without a ghost of our own the drag looks like plain mouse movement and it
                // is unclear the tab can be carried anywhere at all.
                if (drag.sessionID) {
                    const session = sessions.find((item) => item.id === drag.sessionID);
                    showSessionDragGhost(session?.title || drag.tabID);
                    tab.setAttribute("data-top-tab-dragging", "true");
                }
            }
            moveEvent.preventDefault();
            if (drag.sessionID) moveSessionDragGhost(moveEvent.clientX, moveEvent.clientY);

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

                // Превью того, куда встанет сессия. Раньше здесь только вешался атрибут, и при
                // переносе вкладки из общей полосы пользователь не видел, сторона выбиралась
                // молча — в отличие от перетаскивания внутри самой полосы, где превью было.
                const paneSessionID = pane.dataset.splitPaneId;
                if (paneSessionID && paneSessionID !== drag.sessionID) {
                    const placement = paneDropPlacement(pane.getBoundingClientRect(), moveEvent.clientX, moveEvent.clientY);
                    setPaneDropPreview((current) =>
                        current && current.paneID === paneSessionID && current.placement === placement
                            ? current
                            : {sessionID: drag.sessionID!, paneID: paneSessionID, placement});
                } else {
                    setPaneDropPreview(null);
                }
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
                        placeSessionBeside(
                            workspaceID,
                            targetSessionID,
                            drag.sessionID,
                            paneDropPlacement(pane.getBoundingClientRect(), finishEvent.clientX, finishEvent.clientY),
                        );
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
            window.removeEventListener("blur", cancelDrag);
            // Cleared here and not only on a successful drop: an interrupted drag (Esc, window
            // losing focus) would otherwise leave the ghost floating over the interface.
            tab.removeAttribute("data-top-tab-dragging");
            hideSessionDragGhost();
        };
        // A button released outside the window never delivers pointerup, and the drag would
        // otherwise hang along with the ghost until the user comes back to the app.
        const cancelDrag = () => {
            drag.cleanUp();
            clearPreview();
            pointerTabDragRef.current = null;
        };

        pointerTabDragRef.current = drag;
        window.addEventListener("pointermove", handlePointerMove, {passive: false});
        window.addEventListener("pointerup", finishDrag);
        window.addEventListener("pointercancel", finishDrag);
        window.addEventListener("blur", cancelDrag);
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

    return (
        <header className="wails-no-drag relative flex h-[var(--titlebar-height)] shrink-0 items-end justify-between bg-background pr-0">
            {/* Высота заголовка и отступ боковой панели выведены из --tab-height в main.css, поэтому
                увеличение или уменьшение вкладки тянет за собой и их. Раньше четыре числа приходилось
                менять вручную и они разъезжались. */}
            {/* Пустое место слева в заголовке: на Windows и Linux здесь раньше рисовалось пятно цвета
                боковой панели с границей, которое выглядело квадратом на фоне заголовка, теперь полоса
                везде остаётся фоном приложения, как на macOS. На macOS эта ширина уходит под
                системные кнопки, которые рисует система, и она задаётся --mac-window-buttons в
                main.css: измерить их из вебвью нельзя, они нативные и в DOM их нет. */}
            <div
                className={cn("relative flex h-full shrink-0 items-center justify-center", isMacOS ? "w-[var(--mac-window-buttons)]" : "w-14")}
                aria-hidden={isMacOS ? "true" : undefined}
            />

            <div ref={scrollRef}
                  onWheel={handleWheel}
                  onPointerDownCapture={handleTabPointerDown}
                  onClickCapture={handleTabClickCapture}
                  className={cn(
                      "wails-no-drag relative z-10 flex h-full min-w-0 flex-initial items-center gap-1 pl-2 overflow-x-auto",
                      "overflow-y-hidden [&::-webkit-scrollbar]:hidden",
                      // На macOS центр системных кнопок ниже центра вкладки, поэтому полоса
                      // опускается на --mac-tab-drop. Guard обязателен: переменная задана в :root и
                      // на других платформах её значение не вычитается. Величина — в main.css.
                      isMacOS && "translate-y-[var(--mac-tab-drop)]",
                  )}
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
                                onCreate={(title) => createSplitWorkspace(title, splitWorkspaceTabID(workspace.id))}
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
                            onReconnect={() => reconnectSession(session.id)}
                            onCloseOthers={() => closeOtherSessions(session.id)}
                            canCloseOthers={sessions.length > 1}
                            isInSplit={false}
                            canAddToSplit={!activeWorkspace || splitPaneCount(activeWorkspace.layout) < MAX_SPLIT_PANES}
                            onCreateSplit={() => {
                                createSplitWorkspace(
                                    t("split_workspace_default_title", {ns: "terminal", number: workspaces.length + 1}),
                                    terminalSessionTabID(session.id),
                                );
                                addSessionToSplit(session.id);
                            }}
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
            </div>

            {/* Знак «+» стоит вне прокручиваемой полосы: он остаётся видимым при любом числе вкладок,
                и его правая граница становится точной левой границей зоны перетаскивания. Сдвиг
                тот же, что у вкладок, иначе он с ними разойдётся по вертикали. */}
            {isUnlocked && sessions.length > 0 && (
                <div className={cn("flex h-full shrink-0 items-center", isMacOS && "translate-y-[var(--mac-tab-drop)]")}>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="wails-no-drag my-1 shrink-0"
                        title={t("new_tab")}
                        aria-label={t("new_tab")}
                        onClick={() => {
                            setSelectedHostGroup(null);
                            setActiveView(ViewType.Hosts);
                        }}
                    >
                        <Plus className="size-4"/>
                    </Button>
                </div>
            )}

            {/* Зона перетаскивания окна начинается строго за знаком «+» и тянется до системных кнопок.
                Полоса вкладок не растёт, поэтому зона занимает всю свободную ширину: с одной вкладкой
                она широкая, с десятком схлопывается до минимума. Над самими вкладками перетаскивания
                нет — их полоса помечена как wails-no-drag. */}
            <div className="wails-drag h-full min-w-8 flex-1" aria-hidden="true"/>

            {/* Кнопка панели центрируется в заголовке так же, как вкладки, поэтому на macOS получает тот же
                сдвиг --mac-tab-drop. Без него она осталась бы на 8px выше вкладок, потому что
                сдвиг есть только у тех, кто его получил. */}
            {showSidebarButtonVisible && (
                <div className={cn("flex h-full shrink-0 items-center pr-1", isMacOS && "translate-y-[var(--mac-tab-drop)]")}>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleSidebar}
                        className="wails-no-drag text-muted-foreground hover:text-foreground"
                        aria-label={isSidebarVisible ? t("hide_sidebar", {ns: "common"}) : t("show_sidebar", {ns: "common"})}
                        title={isSidebarVisible ? t("hide_sidebar", {ns: "common"}) : t("show_sidebar", {ns: "common"})}
                    >
                        {isSidebarVisible ? <PanelLeftClose className="size-5"/> : <PanelLeftOpen className="size-5"/>}
                    </Button>
                </div>
            )}

            <WindowControls className={showSidebarButtonVisible ? "" : "ml-12"}/>
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
