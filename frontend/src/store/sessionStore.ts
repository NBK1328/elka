import { create } from "zustand";
import { SSHConnectionConfig, SSHJumpHostConfig, SSHPortForward, SshService } from "../../bindings/elka-desktop/backend/internal/services/ssh";
import { useUIStore, ViewType } from "@/store/uiStore";

export const TERMINAL_SESSION_DRAG_TYPE = "application/x-elka-session";

export function terminalSessionTabID(sessionID: string) {
    return `session:${sessionID}`;
}

export function splitWorkspaceTabID(workspaceID: string) {
    return `workspace:${workspaceID}`;
}

export function terminalTabGroupID(groupID: string) {
    return `group:${groupID}`;
}

export interface TerminalSession {
    id: string;
    title: string;
    config: SSHConnectionConfig;
    /** Bumped on reconnect: it changes the terminal instance key, which redials the session. */
    reconnectCount: number;
}

export interface CreateSessionParams {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    privateKeyPassphrase?: string;
    jumpHost?: SSHJumpHostConfig;
    jumpHosts?: SSHJumpHostConfig[];
    portForwards?: SSHPortForward[];
    title?: string;
}

export type SplitPlacement = "left" | "right" | "above" | "below";

export type TerminalSplitLayout =
    | {type: "pane"; sessionId: string}
    | {type: "split"; direction: "horizontal" | "vertical"; ratio: number; first: TerminalSplitLayout; second: TerminalSplitLayout};

export interface SplitWorkspace {
    id: string;
    title: string;
    layout: TerminalSplitLayout | null;
    activeSessionId: string | null;
}

export interface TerminalTabGroup {
    id: string;
    title: string;
    sessionIds: string[];
    activeSessionId: string | null;
}

interface SessionState {
    sessions: TerminalSession[];
    activeSessionId: string | null;
    workspaces: SplitWorkspace[];
    activeWorkspaceID: string | null;
    tabGroups: TerminalTabGroup[];
    topTabOrder: string[];
    addSession: (params: CreateSessionParams) => void;
    createSplitWorkspace: (title: string) => void;
    renameSplitWorkspace: (workspaceID: string, title: string) => void;
    setActiveWorkspace: (workspaceID: string) => void;
    addSessionToSplit: (id: string, workspaceID?: string, defaultWorkspaceTitle?: string) => void;
    placeSessionBeside: (workspaceID: string, referenceID: string, sessionID: string, placement: SplitPlacement) => void;
    removeSessionFromSplit: (workspaceID: string, id: string) => void;
    setSplitRatio: (workspaceID: string, path: string, ratio: number) => void;
    closeSplitWorkspace: (workspaceID: string) => void;
    reorderTopTab: (draggedID: string, targetID: string, insertAfter?: boolean) => void;
    createTabGroup: (sessionID: string, title: string) => void;
    renameTabGroup: (groupID: string, title: string) => void;
    moveSessionToGroup: (sessionID: string, groupID: string) => void;
    removeSessionFromGroup: (sessionID: string) => void;
    ungroupTabs: (groupID: string) => void;
    duplicateSession: (id: string) => void;
    reconnectSession: (id: string) => void;
    closeOtherSessions: (id: string) => void;
    removeSession: (id: string) => void;
    setActiveSession: (id: string) => void;
    clearSessions: () => void;
}

function paneIDs(layout: TerminalSplitLayout | null): string[] {
    if (!layout) return [];
    if (layout.type === "pane") return [layout.sessionId];
    return [...paneIDs(layout.first), ...paneIDs(layout.second)];
}

function removePane(layout: TerminalSplitLayout | null, id: string): {layout: TerminalSplitLayout | null; removed: boolean} {
    if (!layout) return {layout: null, removed: false};
    if (layout.type === "pane") {
        return layout.sessionId === id ? {layout: null, removed: true} : {layout, removed: false};
    }

    const first = removePane(layout.first, id);
    if (first.removed) {
        if (!first.layout) return {layout: layout.second, removed: true};
        return {layout: {...layout, first: first.layout}, removed: true};
    }
    const second = removePane(layout.second, id);
    if (second.removed) {
        if (!second.layout) return {layout: layout.first, removed: true};
        return {layout: {...layout, second: second.layout}, removed: true};
    }
    return {layout, removed: false};
}

function insertPane(
    layout: TerminalSplitLayout,
    referenceID: string,
    sessionID: string,
    placement: SplitPlacement,
): {layout: TerminalSplitLayout; inserted: boolean} {
    if (layout.type === "pane") {
        if (layout.sessionId !== referenceID) return {layout, inserted: false};
        const newPane: TerminalSplitLayout = {type: "pane", sessionId: sessionID};
        const referencePane: TerminalSplitLayout = layout;
        const placeFirst = placement === "left" || placement === "above";
        return {
            layout: {
                type: "split",
                direction: placement === "left" || placement === "right" ? "horizontal" : "vertical",
                ratio: 0.5,
                first: placeFirst ? newPane : referencePane,
                second: placeFirst ? referencePane : newPane,
            },
            inserted: true,
        };
    }

    const first = insertPane(layout.first, referenceID, sessionID, placement);
    if (first.inserted) return {layout: {...layout, first: first.layout}, inserted: true};
    const second = insertPane(layout.second, referenceID, sessionID, placement);
    if (second.inserted) return {layout: {...layout, second: second.layout}, inserted: true};
    return {layout, inserted: false};
}

function updateSplitRatio(layout: TerminalSplitLayout | null, path: string, ratio: number): TerminalSplitLayout | null {
    if (!layout || layout.type === "pane") return layout;
    if (path === "") return {...layout, ratio};
    const [branch, ...remaining] = path;
    const rest = remaining.join("");
    return branch === "L"
        ? {...layout, first: updateSplitRatio(layout.first, rest, ratio) || layout.first}
        : {...layout, second: updateSplitRatio(layout.second, rest, ratio) || layout.second};
}

function attachBeside(
    layout: TerminalSplitLayout | null,
    referenceID: string,
    sessionID: string,
    placement: SplitPlacement,
): TerminalSplitLayout | null {
    if (!layout) return {type: "pane", sessionId: sessionID};
    const withoutTarget = removePane(layout, sessionID);
    const base = withoutTarget.layout;
    if (!base) return {type: "pane", sessionId: sessionID};
    const remainingIDs = paneIDs(base);
    const reference = remainingIDs.includes(referenceID) ? referenceID : remainingIDs[0];
    if (!reference) return {type: "pane", sessionId: sessionID};
    return insertPane(base, reference, sessionID, placement).layout;
}

function removeSessionsFromWorkspaces(workspaces: SplitWorkspace[], sessionIDs: string[]) {
    return workspaces.map((workspace) => {
        let layout = workspace.layout;
        for (const sessionID of sessionIDs) layout = removePane(layout, sessionID).layout;
        const ids = paneIDs(layout);
        return {
            ...workspace,
            layout,
            activeSessionId: ids.includes(workspace.activeSessionId || "") ? workspace.activeSessionId : ids[0] || null,
        };
    });
}

function removeSessionsFromGroups(groups: TerminalTabGroup[], sessionIDs: string[]) {
    const removed = new Set(sessionIDs);
    return groups
        .map((group) => {
            const remaining = group.sessionIds.filter((id) => !removed.has(id));
            return {
                ...group,
                sessionIds: remaining,
                activeSessionId: remaining.includes(group.activeSessionId || "") ? group.activeSessionId : remaining[0] || null,
            };
        })
        .filter((group) => group.sessionIds.length > 0);
}

function cleanTabOrderForGroupChanges(
    order: string[],
    previousGroups: TerminalTabGroup[],
    nextGroups: TerminalTabGroup[],
    removedSessionIDs: string[],
) {
    const nextIDs = new Set(nextGroups.map((group) => group.id));
    const removedGroupTabIDs = new Set(previousGroups.filter((group) => !nextIDs.has(group.id)).map((group) => terminalTabGroupID(group.id)));
    const removedSessionTabIDs = new Set(removedSessionIDs.map(terminalSessionTabID));
    return order.filter((id) => !removedGroupTabIDs.has(id) && !removedSessionTabIDs.has(id));
}

export const useSessionStore = create<SessionState>((set, get) => ({
    sessions: [],
    activeSessionId: null,
    workspaces: [],
    activeWorkspaceID: null,
    tabGroups: [],
    topTabOrder: [],

    addSession: (params) => set((state) => {
        const newId = crypto.randomUUID();
        const fullConfig = new SSHConnectionConfig({
            id: newId,
            host: params.host,
            port: params.port,
            username: params.username,
            password: params.password,
            privateKey: params.privateKey,
            privateKeyPassphrase: params.privateKeyPassphrase,
            jumpHost: params.jumpHost,
            jumpHosts: params.jumpHosts,
            portForwards: params.portForwards,
        });
        const newSession: TerminalSession = {
            id: newId,
            title: params.title || params.host,
            config: fullConfig,
            reconnectCount: 0,
        };

        useUIStore.getState().setActiveView(ViewType.Terminal);
        return {
            sessions: [...state.sessions, newSession],
            activeSessionId: newId,
            activeWorkspaceID: null,
            topTabOrder: [...state.topTabOrder.filter((tabID) => tabID !== terminalSessionTabID(newId)), terminalSessionTabID(newId)],
        };
    }),

    duplicateSession: (id) => {
        const session = get().sessions.find((item) => item.id === id);
        if (!session) return;
        get().addSession({
            host: session.config.host,
            port: session.config.port,
            username: session.config.username,
            password: session.config.password,
            privateKey: session.config.privateKey,
            privateKeyPassphrase: session.config.privateKeyPassphrase,
            jumpHost: session.config.jumpHost || undefined,
            jumpHosts: session.config.jumpHosts,
            portForwards: session.config.portForwards,
            title: session.title,
        });
    },

    createSplitWorkspace: (title) => {
        const state = get();
        const id = crypto.randomUUID();
        const workspace: SplitWorkspace = {id, title, layout: null, activeSessionId: null};
        useUIStore.getState().setActiveView(ViewType.Terminal);
        set({
            workspaces: [...state.workspaces, workspace],
            activeWorkspaceID: id,
            activeSessionId: null,
            topTabOrder: [...state.topTabOrder, splitWorkspaceTabID(id)],
        });
    },

    renameSplitWorkspace: (workspaceID, title) => set((state) => ({
        workspaces: state.workspaces.map((workspace) => workspace.id === workspaceID ? {...workspace, title} : workspace),
    })),

    setActiveWorkspace: (workspaceID) => {
        const workspace = get().workspaces.find((item) => item.id === workspaceID);
        if (!workspace) return;
        const ids = paneIDs(workspace.layout);
        const activeSessionId = ids.includes(workspace.activeSessionId || "") ? workspace.activeSessionId : ids[0] || null;
        useUIStore.getState().setActiveView(ViewType.Terminal);
        set({activeWorkspaceID: workspaceID, activeSessionId});
    },

    addSessionToSplit: (id, requestedWorkspaceID, defaultWorkspaceTitle) => {
        const state = get();
        if (!state.sessions.some((session) => session.id === id)) return;

        const alreadyInWorkspace = state.workspaces.find((workspace) => paneIDs(workspace.layout).includes(id));
        let workspaceID = requestedWorkspaceID || state.activeWorkspaceID || alreadyInWorkspace?.id || state.workspaces[0]?.id;
        let workspaces = state.workspaces;
        let topTabOrder = state.topTabOrder;
        let targetWorkspace = workspaceID ? workspaces.find((workspace) => workspace.id === workspaceID) : undefined;
        let createdWorkspace = false;
        if (!targetWorkspace) {
            workspaceID = crypto.randomUUID();
            const defaultTitle = defaultWorkspaceTitle || `Split workspace ${state.workspaces.length + 1}`;
            targetWorkspace = {id: workspaceID, title: defaultTitle, layout: null, activeSessionId: null};
            workspaces = [...workspaces, targetWorkspace];
            topTabOrder = [...topTabOrder, splitWorkspaceTabID(workspaceID)];
            createdWorkspace = true;
        }

        const currentIDs = paneIDs(targetWorkspace.layout);
        if (currentIDs.includes(id)) {
            set({activeWorkspaceID: workspaceID, activeSessionId: id});
            useUIStore.getState().setActiveView(ViewType.Terminal);
            return;
        }
        if (currentIDs.length >= 6) return;

        let candidateID = targetWorkspace.activeSessionId && targetWorkspace.activeSessionId !== id
            ? targetWorkspace.activeSessionId
            : currentIDs.find((sessionID) => sessionID !== id);
        const activeSessionIsInWorkspace = state.workspaces.some((workspace) => paneIDs(workspace.layout).includes(state.activeSessionId || ""));
        if (!candidateID && createdWorkspace && !alreadyInWorkspace && !activeSessionIsInWorkspace && state.activeSessionId !== id) {
            candidateID = state.activeSessionId || undefined;
        }
        const movedIDs = candidateID && !currentIDs.includes(candidateID) ? [id, candidateID] : [id];
        const groups = removeSessionsFromGroups(state.tabGroups, movedIDs);
        topTabOrder = cleanTabOrderForGroupChanges(topTabOrder, state.tabGroups, groups, movedIDs);
        workspaces = removeSessionsFromWorkspaces(workspaces, [id]);

        let updatedWorkspace = workspaces.find((workspace) => workspace.id === workspaceID);
        if (!updatedWorkspace) return;
        let layout = updatedWorkspace.layout;
        if (candidateID && !paneIDs(layout).includes(candidateID)) {
            layout = attachBeside(layout, paneIDs(layout)[0] || candidateID, candidateID, "right");
        }
        const referenceID = updatedWorkspace.activeSessionId && paneIDs(layout).includes(updatedWorkspace.activeSessionId)
            ? updatedWorkspace.activeSessionId
            : paneIDs(layout)[0] || id;
        layout = attachBeside(layout, referenceID, id, "right");
        workspaces = workspaces.map((workspace) => workspace.id === workspaceID
            ? {...workspace, layout, activeSessionId: id}
            : workspace);

        useUIStore.getState().setActiveView(ViewType.Terminal);
        set({
            workspaces,
            tabGroups: groups,
            activeWorkspaceID: workspaceID,
            activeSessionId: id,
            topTabOrder,
        });
    },

    placeSessionBeside: (workspaceID, referenceID, sessionID, placement) => {
        const state = get();
        if (referenceID === sessionID || !state.sessions.some((session) => session.id === sessionID)) return;
        const targetWorkspace = state.workspaces.find((workspace) => workspace.id === workspaceID);
        if (!targetWorkspace) return;
        const currentIDs = paneIDs(targetWorkspace.layout);
        if (!currentIDs.includes(sessionID) && currentIDs.length >= 6) return;

        const baseLayout = removePane(targetWorkspace.layout, sessionID).layout;
        const baseIDs = paneIDs(baseLayout);
        const reference = baseIDs.includes(referenceID) ? referenceID : baseIDs[0];
        const layout = reference
            ? insertPane(baseLayout!, reference, sessionID, placement).layout
            : {type: "pane", sessionId: sessionID} as TerminalSplitLayout;
        const workspaces = removeSessionsFromWorkspaces(state.workspaces, [sessionID]).map((workspace) =>
            workspace.id === workspaceID ? {...workspace, layout, activeSessionId: sessionID} : workspace
        );
        const tabGroups = removeSessionsFromGroups(state.tabGroups, [sessionID]);
        const topTabOrder = cleanTabOrderForGroupChanges(state.topTabOrder, state.tabGroups, tabGroups, [sessionID]);
        useUIStore.getState().setActiveView(ViewType.Terminal);
        set({
            workspaces,
            tabGroups,
            activeWorkspaceID: workspaceID,
            activeSessionId: sessionID,
            topTabOrder,
        });
    },

    removeSessionFromSplit: (workspaceID, id) => set((state) => {
        const workspace = state.workspaces.find((item) => item.id === workspaceID);
        if (!workspace) return state;
        const result = removePane(workspace.layout, id);
        if (!result.removed) return state;
        const ids = paneIDs(result.layout);
        const workspaces = state.workspaces.map((item) => item.id === workspaceID
            ? {
                ...item,
                layout: result.layout,
                activeSessionId: ids.includes(item.activeSessionId || "") ? item.activeSessionId : ids[0] || null,
            }
            : item);
        const activeSessionId = state.activeWorkspaceID === workspaceID && state.activeSessionId === id
            ? ids[0] || null
            : state.activeSessionId;
        const order = [...state.topTabOrder];
        const workspaceIndex = order.indexOf(splitWorkspaceTabID(workspaceID));
        order.splice(workspaceIndex < 0 ? order.length : workspaceIndex + 1, 0, terminalSessionTabID(id));
        useUIStore.getState().setActiveView(ViewType.Terminal);
        return {
            workspaces,
            activeSessionId,
            topTabOrder: order,
        };
    }),

    setSplitRatio: (workspaceID, path, ratio) => set((state) => ({
        workspaces: state.workspaces.map((workspace) => workspace.id === workspaceID
            ? {...workspace, layout: updateSplitRatio(workspace.layout, path, Math.max(0.15, Math.min(0.85, ratio)))}
            : workspace),
    })),

    closeSplitWorkspace: (workspaceID) => set((state) => {
        const workspace = state.workspaces.find((item) => item.id === workspaceID);
        if (!workspace) return state;
        const releasedIDs = paneIDs(workspace.layout);
        const workspaces = state.workspaces.filter((item) => item.id !== workspaceID);
        const order = [...state.topTabOrder];
        const workspaceIndex = order.indexOf(splitWorkspaceTabID(workspaceID));
        if (workspaceIndex >= 0) order.splice(workspaceIndex, 1, ...releasedIDs.map(terminalSessionTabID));
        const activeWorkspaceID = state.activeWorkspaceID === workspaceID
            ? releasedIDs.length > 0 ? null : workspaces[0]?.id || null
            : state.activeWorkspaceID;
        const activeSessionId = releasedIDs.includes(state.activeSessionId || "")
            ? state.activeSessionId
            : activeWorkspaceID
                ? workspaces.find((item) => item.id === activeWorkspaceID)?.activeSessionId || null
                : state.sessions.find((session) => !workspaces.some((item) => paneIDs(item.layout).includes(session.id)))?.id || null;
        return {
            workspaces,
            activeWorkspaceID,
            activeSessionId,
            topTabOrder: order,
        };
    }),

    reorderTopTab: (draggedID, targetID, insertAfter = false) => set((state) => {
        if (draggedID === targetID) return state;
        const order = [...state.topTabOrder];
        const draggedIndex = order.indexOf(draggedID);
        if (draggedIndex < 0 || !order.includes(targetID)) return state;
        order.splice(draggedIndex, 1);
        const targetIndex = order.indexOf(targetID);
        order.splice(targetIndex + (insertAfter ? 1 : 0), 0, draggedID);
        if (order.every((id, index) => id === state.topTabOrder[index])) return state;
        return {topTabOrder: order};
    }),

    createTabGroup: (sessionID, title) => set((state) => {
        if (!state.sessions.some((session) => session.id === sessionID)
            || state.workspaces.some((workspace) => paneIDs(workspace.layout).includes(sessionID))) return state;
        const id = crypto.randomUUID();
        const group: TerminalTabGroup = {id, title, sessionIds: [sessionID], activeSessionId: sessionID};
        const sessionTabID = terminalSessionTabID(sessionID);
        const order = [...state.topTabOrder];
        const index = order.indexOf(sessionTabID);
        if (index < 0) order.push(terminalTabGroupID(id));
        else order.splice(index, 1, terminalTabGroupID(id));
        return {tabGroups: [...state.tabGroups, group], topTabOrder: order};
    }),

    renameTabGroup: (groupID, title) => set((state) => ({
        tabGroups: state.tabGroups.map((group) => group.id === groupID ? {...group, title} : group),
    })),

    moveSessionToGroup: (sessionID, groupID) => set((state) => {
        if (state.workspaces.some((workspace) => paneIDs(workspace.layout).includes(sessionID))) return state;
        const target = state.tabGroups.find((group) => group.id === groupID);
        if (!target || !state.sessions.some((session) => session.id === sessionID)) return state;
        if (target.sessionIds.includes(sessionID)) return state;
        const groups = state.tabGroups
            .map((group) => ({...group, sessionIds: group.sessionIds.filter((id) => id !== sessionID)}))
            .filter((group) => group.sessionIds.length > 0)
            .map((group) => {
                if (group.id !== groupID) return group;
                const sessionIds = [...group.sessionIds, sessionID];
                return {...group, sessionIds, activeSessionId: sessionID};
            });
        const order = cleanTabOrderForGroupChanges(state.topTabOrder, state.tabGroups, groups, [sessionID]);
        const sessionTabID = terminalSessionTabID(sessionID);
        const sessionIndex = order.indexOf(sessionTabID);
        const groupTabID = terminalTabGroupID(groupID);
        const cleanedOrder = order.filter((id) => id !== sessionTabID);
        if (!cleanedOrder.includes(groupTabID)) cleanedOrder.splice(sessionIndex < 0 ? cleanedOrder.length : Math.min(sessionIndex, cleanedOrder.length), 0, groupTabID);
        return {tabGroups: groups, topTabOrder: cleanedOrder};
    }),

    removeSessionFromGroup: (sessionID) => set((state) => {
        const group = state.tabGroups.find((item) => item.sessionIds.includes(sessionID));
        if (!group) return state;
        const remaining = group.sessionIds.filter((id) => id !== sessionID);
        const tabGroups = remaining.length
            ? state.tabGroups.map((item) => item.id === group.id
                ? {...item, sessionIds: remaining, activeSessionId: remaining.includes(item.activeSessionId || "") ? item.activeSessionId : remaining[0]}
                : item)
            : state.tabGroups.filter((item) => item.id !== group.id);
        const order = [...state.topTabOrder];
        const groupIndex = order.indexOf(terminalTabGroupID(group.id));
        if (remaining.length) order.splice(groupIndex < 0 ? order.length : groupIndex + 1, 0, terminalSessionTabID(sessionID));
        else if (groupIndex >= 0) order.splice(groupIndex, 1, terminalSessionTabID(sessionID));
        else order.push(terminalSessionTabID(sessionID));
        return {tabGroups, topTabOrder: order};
    }),

    ungroupTabs: (groupID) => set((state) => {
        const group = state.tabGroups.find((item) => item.id === groupID);
        if (!group) return state;
        const order = [...state.topTabOrder];
        const index = order.indexOf(terminalTabGroupID(groupID));
        if (index >= 0) order.splice(index, 1, ...group.sessionIds.map(terminalSessionTabID));
        else order.push(...group.sessionIds.map(terminalSessionTabID));
        return {
            tabGroups: state.tabGroups.filter((item) => item.id !== groupID),
            topTabOrder: order,
        };
    }),

    closeOtherSessions: (id) => {
        const {sessions} = get();
        const keep = sessions.find((session) => session.id === id);
        if (!keep) return;
        const toClose = sessions.filter((session) => session.id !== id);

        set({
            sessions: [keep], activeSessionId: id, workspaces: [], activeWorkspaceID: null, tabGroups: [],
            topTabOrder: [terminalSessionTabID(id)],
        });
        useUIStore.getState().setActiveView(ViewType.Terminal);
        toClose.forEach((session) => SshService.Disconnect(session.id).catch(console.error));
    },

    removeSession: (id) => set((state) => {
        const newSessions = state.sessions.filter((session) => session.id !== id);
        const group = state.tabGroups.find((item) => item.sessionIds.includes(id));
        const groupFallbackID = group?.sessionIds.find((sessionID) => sessionID !== id) || null;
        const workspaces = removeSessionsFromWorkspaces(state.workspaces, [id]);
        const tabGroups = removeSessionsFromGroups(state.tabGroups, [id]);
        const activeWorkspace = workspaces.find((workspace) => workspace.id === state.activeWorkspaceID);
        const activeWorkspaceIDs = paneIDs(activeWorkspace?.layout || null);
        let activeSessionId = state.activeSessionId;
        if (activeSessionId === id) {
            if (groupFallbackID) activeSessionId = groupFallbackID;
            else if (activeWorkspaceIDs.length > 0) activeSessionId = activeWorkspaceIDs[0];
            else activeSessionId = newSessions.find((session) => !workspaces.some((workspace) => paneIDs(workspace.layout).includes(session.id)))?.id || null;
        }

        if (newSessions.length === 0) useUIStore.getState().setActiveView(ViewType.Hosts);

        const topTabOrder = cleanTabOrderForGroupChanges(state.topTabOrder, state.tabGroups, tabGroups, [id]);

        return {
            sessions: newSessions,
            activeSessionId,
            workspaces,
            tabGroups,
            topTabOrder,
        };
    }),

    // Reconnect reuses the mount/cleanup cycle of the terminal: the current session is closed and a
    // new one is opened inside the same tab, which also retries a session that failed to connect.
    reconnectSession: (id) => {
        if (!get().sessions.some((session) => session.id === id)) return;

        get().setActiveSession(id);
        set((state) => ({
            sessions: state.sessions.map((session) => session.id === id
                ? {...session, reconnectCount: session.reconnectCount + 1}
                : session),
        }));
    },

    setActiveSession: (id) => {
        useUIStore.getState().setActiveView(ViewType.Terminal);
        const state = get();
        const workspace = state.workspaces.find((item) => paneIDs(item.layout).includes(id));
        set((state) => ({
            activeSessionId: id,
            activeWorkspaceID: workspace?.id || null,
            workspaces: state.workspaces.map((item) => item.id === workspace?.id ? {...item, activeSessionId: id} : item),
            tabGroups: state.tabGroups.map((group) => group.sessionIds.includes(id) ? {...group, activeSessionId: id} : group),
        }));
    },

    clearSessions: () => {
        const {sessions} = get();
        sessions.forEach((session) => SshService.Disconnect(session.id).catch(console.error));
        useUIStore.getState().setActiveView(ViewType.Hosts);
        set({
            sessions: [], activeSessionId: null, workspaces: [], activeWorkspaceID: null, tabGroups: [],
            topTabOrder: [],
        });
    },
}));
