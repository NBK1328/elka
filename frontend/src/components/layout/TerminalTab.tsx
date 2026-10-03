import { Columns2, CopyPlus, FolderOpen, RefreshCw, SquareSplitHorizontal, X } from "lucide-react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import {
    TerminalSession,
    TerminalTabGroup,
    terminalSessionTabID,
} from "@/store/sessionStore";
import { useTranslation } from "react-i18next";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { ContextMenuAction, ContextMenuPanel } from "@/components/layout/ContextMenuAction";

const tabStyles = cva(
    "wails-no-drag group my-1 mt-2 flex h-8 min-w-30 max-w-50 cursor-pointer items-center " +
    "justify-between rounded-md border px-3 text-xs font-medium transition-colors",
    {
        variants: {
            state: {
                active: "border-border bg-card text-foreground",
                inactive: "border-border border-muted text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            },
        },
        defaultVariants: {
            state: "inactive",
        },
    }
);

const closeButtonStyles = cva(
    "ml-2 flex size-5 items-center justify-center rounded-sm transition-all hover:bg-muted",
    {
        variants: {
            state: {
                active: "opacity-100",
                inactive: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            },
        },
        defaultVariants: {
            state: "inactive",
        },
    }
);

interface TerminalTabProps {
    session: TerminalSession;
    isActive: boolean;
    onClick: () => void;
    onClose: () => void;
    onDuplicate: () => void;
    onReconnect: () => void;
    onCloseOthers: () => void;
    canCloseOthers: boolean;
    isInSplit: boolean;
    canAddToSplit: boolean;
    onCreateSplit: () => void;
    onToggleSplit: () => void;
    dropEdge: "before" | "after" | null;
    isDropTarget: boolean;
    groups: TerminalTabGroup[];
    onCreateGroup: () => void;
    onMoveToGroup: (groupID: string) => void;
    onOpenSFTP: () => void;
}

export function TerminalTab({session, isActive, onClick, onClose, onDuplicate, onReconnect, onCloseOthers, canCloseOthers, isInSplit, canAddToSplit, onCreateSplit, onToggleSplit, dropEdge, isDropTarget, groups, onCreateGroup, onMoveToGroup, onOpenSFTP}: TerminalTabProps) {
    const {t} = useTranslation("terminal");
    const state = isActive ? "active" : "inactive";

    return (
        <ContextMenuPrimitive.Root>
            <ContextMenuPrimitive.Trigger asChild>
                <div onClick={onClick}
                     data-top-tab-id={terminalSessionTabID(session.id)}
                     data-session-id={session.id}
                     tabIndex={0}
                     role="tab"
                     aria-selected={isActive}
                     onKeyDown={(e) => {
                         if (e.key === "Enter" || e.key === " ") {
                             e.preventDefault();
                             onClick();
                         }
                     }}
                     className={cn("relative", tabStyles({state}), isDropTarget && "ring-2 ring-primary")}>
                    {dropEdge === "before" && <span className="pointer-events-none absolute -left-1 top-0 z-20 h-full w-0.5 rounded-full bg-primary"/>}
                    {dropEdge === "after" && <span className="pointer-events-none absolute -right-1 top-0 z-20 h-full w-0.5 rounded-full bg-primary"/>}
                    <span className="truncate">{session.title}</span>
                    <button
                        type="button"
                        title={t("close_tab")}
                        aria-label={t("close_named_tab", {name: session.title})}
                        onClick={(e) => {
                            e.stopPropagation();
                            onClose();
                        }}
                        className={cn(closeButtonStyles({state}))}
                    >
                        <X className="size-3"/>
                    </button>
                </div>
            </ContextMenuPrimitive.Trigger>
            <ContextMenuPrimitive.Portal>
                <ContextMenuPanel className="z-50 min-w-48 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
                    <ContextMenuAction onSelect={onReconnect} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">
                        <RefreshCw className="size-4"/>{t("reconnect")}
                    </ContextMenuAction>
                    <ContextMenuAction onSelect={onDuplicate} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">
                        <CopyPlus className="size-4"/>{t("duplicate_tab")}
                    </ContextMenuAction>
                    <ContextMenuAction onSelect={onCreateGroup} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">
                        {t("create_tab_group")}
                    </ContextMenuAction>
                    {groups.filter((group) => !group.sessionIds.includes(session.id)).map((group) => (
                        <ContextMenuAction
                            key={group.id}
                            onSelect={() => onMoveToGroup(group.id)}
                            className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                        >
                            {t("move_tab_to_group", {name: group.title})}
                        </ContextMenuAction>
                    ))}
                    <ContextMenuAction
                        disabled={!canAddToSplit}
                        onSelect={onCreateSplit}
                        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                    >
                        <SquareSplitHorizontal className="size-4"/>{t("new_split_workspace")}
                    </ContextMenuAction>
                    <ContextMenuAction
                        disabled={!isInSplit && !canAddToSplit}
                        onSelect={onToggleSplit}
                        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                    >
                        <Columns2 className="size-4"/>{t(isInSplit ? "remove_from_split" : "add_to_split")}
                    </ContextMenuAction>
                    <ContextMenuAction onSelect={onOpenSFTP} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">
                        <FolderOpen className="size-4"/>{t("open_sftp")}
                    </ContextMenuAction>
                    <ContextMenuPrimitive.Separator className="my-1 h-px bg-border"/>
                    <ContextMenuAction onSelect={onClose} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">
                        <X className="size-4"/>{t("close_tab")}
                    </ContextMenuAction>
                    <ContextMenuPrimitive.Separator className="my-1 h-px bg-border"/>
                    <ContextMenuAction
                        disabled={!canCloseOthers}
                        onSelect={onCloseOthers}
                        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                    >
                        <X className="size-4"/>{t("close_other_tabs")}
                    </ContextMenuAction>
                </ContextMenuPanel>
            </ContextMenuPrimitive.Portal>
        </ContextMenuPrimitive.Root>
    );
}
