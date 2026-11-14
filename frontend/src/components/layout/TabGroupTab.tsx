import { Check, ChevronDown, FolderOpen, X } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { NameDialog } from "@/components/layout/NameDialog";
import { ContextMenuAction, ContextMenuPanel } from "@/components/layout/ContextMenuAction";
import { hideTabTooltip, scheduleTabTooltip, sshAddressText, sshAddressesText } from "@/lib/tabTooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
    TERMINAL_SESSION_DRAG_TYPE,
    TerminalSession,
    TerminalTabGroup,
    terminalTabGroupID,
} from "@/store/sessionStore";

interface TabGroupTabProps {
    group: TerminalTabGroup;
    sessions: TerminalSession[];
    activeSessionId: string | null;
    isActive: boolean;
    onSelect: (sessionID: string) => void;
    onCloseSession: (sessionID: string) => void;
    onRename: (title: string) => void;
    onRemoveFromGroup: (sessionID: string) => void;
    onUngroup: () => void;
    onDropSession: (sessionID: string, groupID: string) => void;
    dropEdge: "before" | "after" | null;
    isDropTarget: boolean;
}

export function TabGroupTab({
    group,
    sessions,
    activeSessionId,
    isActive,
    onSelect,
    onCloseSession,
    onRename,
    onRemoveFromGroup,
    onUngroup,
    onDropSession,
    dropEdge,
    isDropTarget,
}: TabGroupTabProps) {
    const {t} = useTranslation("terminal");
    const [isSessionDropTarget, setIsSessionDropTarget] = useState(false);
    const [isRenameOpen, setIsRenameOpen] = useState(false);
    const [isGroupMenuOpen, setIsGroupMenuOpen] = useState(false);
    const groupID = terminalTabGroupID(group.id);
    const memberSessions = group.sessionIds
        .map((sessionID) => sessions.find((session) => session.id === sessionID))
        .filter((session): session is TerminalSession => !!session);
    const selectedSessionID = group.sessionIds.includes(activeSessionId || "")
        ? activeSessionId
        : group.activeSessionId || group.sessionIds[0];
    const selectedSession = sessions.find((session) => session.id === selectedSessionID);

    // Built on hover, not on every render, for the same reason as the split tab.
    const addressText = () => sshAddressesText(memberSessions
        .map((session) => sshAddressText(session.config.host, session.config.port)));

    return (
        <>
            <ContextMenuPrimitive.Root>
                <ContextMenuPrimitive.Trigger asChild>
                <div
                    role="tab"
                    tabIndex={0}
                    aria-selected={isActive}
                    data-top-tab-id={groupID}
                    data-group-id={group.id}
                    onPointerEnter={(event) => scheduleTabTooltip(event.currentTarget, addressText())}
                    onPointerLeave={hideTabTooltip}
                    onClick={() => selectedSessionID && onSelect(selectedSessionID)}
                    onKeyDown={(event) => {
                        if ((event.key === "Enter" || event.key === " ") && selectedSessionID) {
                            event.preventDefault();
                            onSelect(selectedSessionID);
                        }
                    }}
                    onDragOver={(event) => {
                        if (event.dataTransfer.types.includes(TERMINAL_SESSION_DRAG_TYPE)) {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            setIsSessionDropTarget(true);
                        }
                    }}
                    onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsSessionDropTarget(false);
                    }}
                    onDrop={(event) => {
                        const sessionID = event.dataTransfer.getData(TERMINAL_SESSION_DRAG_TYPE);
                        if (sessionID) {
                            event.preventDefault();
                            event.stopPropagation();
                            onDropSession(sessionID, group.id);
                        }
                        setIsSessionDropTarget(false);
                    }}
                    className={cn(
                        "wails-no-drag group relative my-[var(--tab-margin)] flex h-[var(--tab-height)] min-w-36 max-w-56 cursor-pointer items-center justify-between rounded-md border px-3 text-xs font-medium transition-colors",
                        isActive ? "border-primary/60 bg-card text-foreground" : "border-muted text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                        (isDropTarget || isSessionDropTarget) && "ring-2 ring-primary"
                    )}
                >
                    {dropEdge === "before" && <span className="pointer-events-none absolute -left-1 top-0 z-20 h-full w-0.5 rounded-full bg-primary"/>}
                    {dropEdge === "after" && <span className="pointer-events-none absolute -right-1 top-0 z-20 h-full w-0.5 rounded-full bg-primary"/>}
                    <span className="flex min-w-0 items-center gap-2 truncate">
                        <FolderOpen className="size-4 shrink-0"/>
                        <span className="truncate">{group.title}</span>
                        <span className="text-[10px] text-muted-foreground">{group.sessionIds.length}</span>
                        {selectedSession && <span className="max-w-24 truncate text-muted-foreground">{selectedSession.title}</span>}
                    </span>
                    <span className="ml-1 flex shrink-0 items-center gap-0.5">
                        <Popover open={isGroupMenuOpen} onOpenChange={setIsGroupMenuOpen}>
                            <PopoverTrigger asChild>
                                <button
                                    type="button"
                                    data-no-tab-drag
                                    aria-expanded={isGroupMenuOpen}
                                    aria-label={t("show_group_tabs", {name: group.title})}
                                    title={t("show_group_tabs", {name: group.title})}
                                    onClick={(event) => event.stopPropagation()}
                                    className="flex size-5 items-center justify-center rounded-sm hover:bg-muted"
                                >
                                    <ChevronDown className="size-3"/>
                                </button>
                            </PopoverTrigger>
                            <PopoverContent align="end" side="bottom" avoidCollisions={false} className="max-h-(--radix-popover-content-available-height) w-52 overflow-y-auto p-1">
                                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{group.title}</div>
                                {memberSessions.map((session) => (
                                    <button
                                        key={session.id}
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            onSelect(session.id);
                                            setIsGroupMenuOpen(false);
                                        }}
                                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                                    >
                                        <span className="truncate">{session.title}</span>
                                        {session.id === selectedSessionID && <Check className="size-4 shrink-0"/>}
                                    </button>
                                ))}
                            </PopoverContent>
                        </Popover>
                        <button
                            type="button"
                            data-no-tab-drag
                            title={t("close_tab")}
                            aria-label={t("close_named_tab", {name: selectedSession?.title || group.title})}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (selectedSessionID) onCloseSession(selectedSessionID);
                            }}
                            className="flex size-5 items-center justify-center rounded-sm opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
                        >
                            <X className="size-3"/>
                        </button>
                    </span>
                </div>
                </ContextMenuPrimitive.Trigger>
                <ContextMenuPrimitive.Portal>
                <ContextMenuPanel className="z-50 min-w-52 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
                    <ContextMenuPrimitive.Label className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                        {group.title}
                    </ContextMenuPrimitive.Label>
                    {memberSessions.map((session) => (
                        <ContextMenuAction
                            key={session.id}
                            onSelect={() => onSelect(session.id)}
                            className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                        >
                            <span className="truncate">{session.title}</span>
                            <span className="text-xs text-muted-foreground">{t("select_group_tab")}</span>
                        </ContextMenuAction>
                    ))}
                    {memberSessions.length > 0 && <ContextMenuPrimitive.Separator className="my-1 h-px bg-border"/>}
                    {selectedSessionID && (
                        <ContextMenuAction
                            onSelect={() => onRemoveFromGroup(selectedSessionID)}
                            className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                        >
                            {t("move_active_tab_out_of_group")}
                        </ContextMenuAction>
                    )}
                    <ContextMenuAction
                        onSelect={() => setIsRenameOpen(true)}
                        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                    >
                        {t("rename_tab_group")}
                    </ContextMenuAction>
                    <ContextMenuAction
                        onSelect={onUngroup}
                        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                    >
                        {t("ungroup_tabs")}
                    </ContextMenuAction>
                </ContextMenuPanel>
                </ContextMenuPrimitive.Portal>
            </ContextMenuPrimitive.Root>
            <NameDialog
                open={isRenameOpen}
                title={t("rename_tab_group")}
                initialName={group.title}
                onCancel={() => setIsRenameOpen(false)}
                onSubmit={(title) => {
                    onRename(title);
                    setIsRenameOpen(false);
                }}
            />
        </>
    );
}
