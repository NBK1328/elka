import { create } from "zustand";
import { getInitialAppearance } from "@/lib/appearance";
import type { AppearanceSettings } from "@/lib/appearance";
import { SIDEBAR_TRANSITION_MS } from "@/lib/sidebar";

export enum ViewType {
    Hosts = "hosts",
    Keys = "keys",
    Credentials = "credentials",
    Groups = "groups",
    Settings = "settings",
    Terminal = "terminal",
}

export type HostViewMode = "cards" | "list" | "tree";

let sidebarTransitionTimer: ReturnType<typeof setTimeout> | undefined;

function beginSidebarTransition() {
    if (sidebarTransitionTimer) clearTimeout(sidebarTransitionTimer);
    sidebarTransitionTimer = setTimeout(() => {
        sidebarTransitionTimer = undefined;
        useUIStore.setState({isSidebarTransitioning: false});
    }, SIDEBAR_TRANSITION_MS);

    return {isSidebarTransitioning: true};
}

interface UIState {
    activeView: ViewType;
    isSidebarVisible: boolean;
    isSidebarTransitioning: boolean;
    updateVersionReady: string | null;
    showHostGroups: boolean;
    showSidebarToggle: boolean;
    selectedHostGroup: string | null;
    hostViewMode: HostViewMode;
    groupViewMode: HostViewMode;
    appearance: AppearanceSettings;
    setActiveView: (view: ViewType) => void;
    setShowHostGroups: (show: boolean) => void;
    setShowSidebarToggle: (show: boolean) => void;
    setSelectedHostGroup: (group: string | null) => void;
    setHostViewMode: (mode: HostViewMode) => void;
    setGroupViewMode: (mode: HostViewMode) => void;
    setAppearance: (appearance: AppearanceSettings) => void;
    toggleSidebar: () => void;
    setUpdateVersionReady: (version: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
    activeView: ViewType.Hosts,
    isSidebarVisible: true,
    isSidebarTransitioning: false,
    updateVersionReady: null,
    showHostGroups: true,
    showSidebarToggle: true,
    selectedHostGroup: null,
    hostViewMode: "cards",
    groupViewMode: "tree",
    appearance: getInitialAppearance(),
    setActiveView: (view) => set({activeView: view}),
    setShowHostGroups: (show) => set({showHostGroups: show}),
    // Without the toggle button the sidebar has to stay visible, otherwise there is no way to bring it back.
    setShowSidebarToggle: (show) => set((state) => ({
        showSidebarToggle: show,
        isSidebarVisible: show ? state.isSidebarVisible : true,
    })),
    setSelectedHostGroup: (group) => set({selectedHostGroup: group}),
    setHostViewMode: (mode) => set({hostViewMode: mode}),
    setGroupViewMode: (mode) => set({groupViewMode: mode}),
    setAppearance: (appearance) => set({appearance}),
    toggleSidebar: () => set((state) => ({
        isSidebarVisible: !state.isSidebarVisible,
        ...beginSidebarTransition(),
    })),
    setUpdateVersionReady: (version) => set({ updateVersionReady: version }),
}));
