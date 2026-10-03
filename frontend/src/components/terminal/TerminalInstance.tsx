import { useEffect, useRef, useState } from "react";
import type {
    CSSProperties,
    DragEvent as ReactDragEvent,
    MouseEvent as ReactMouseEvent,
    PointerEvent as ReactPointerEvent,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Events, Clipboard } from "@wailsio/runtime";
import { createTerminalOptions } from "@/lib/terminalTheme";
import { parseAppError } from "@/lib/error";
import { cn, decodeBase64ToUint8Array } from "@/lib/utils";
import "@xterm/xterm/css/xterm.css";
import { SSHConnectionConfig, SshService } from "../../../bindings/elka-desktop/backend/internal/services/ssh";
import { useTranslation } from "react-i18next";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { ContextMenuAction, ContextMenuPanel } from "@/components/layout/ContextMenuAction";
import { AppEvent } from "@/lib/events.ts";
import { Columns2, CopyPlus, FolderOpen, GripVertical, LoaderCircle, PanelTopClose, RefreshCw, X } from "lucide-react";
import { SplitPlacement, TERMINAL_SESSION_DRAG_TYPE } from "@/store/sessionStore";
import { useUIStore } from "@/store/uiStore";

type ConnectionState = "connecting" | "ready" | "failed";

interface TerminalInstanceProps {
    sessionId: string;
    isActive: boolean;
    isVisible: boolean;
    isSplitPane?: boolean;
    workspaceID?: string;
    paneTitle?: string;
    layoutStyle?: CSSProperties;
    onFocus: () => void;
    onDetachPane?: () => void;
    onCloseSession?: () => void;
    onReconnect?: () => void;
    onDuplicate?: () => void;
    onOpenSFTP?: () => void;
    onCloseOthers?: () => void;
    onDropSession?: (draggedSessionID: string, targetSessionID: string, placement: SplitPlacement) => void;
    config: SSHConnectionConfig;
}

// Split panes are rounded on every corner, wherever they sit in the layout.
const PANE_RADIUS = "rounded-xl";

export function TerminalInstance({
    sessionId,
    isActive,
    isVisible,
    isSplitPane = false,
    workspaceID,
    paneTitle,
    layoutStyle,
    onFocus,
    onDetachPane,
    onCloseSession,
    onReconnect,
    onDuplicate,
    onOpenSFTP,
    onCloseOthers,
    onDropSession,
    config,
}: TerminalInstanceProps) {
    const {t} = useTranslation("terminal");
    const appearance = useUIStore((state) => state.appearance);
    const isSidebarTransitioning = useUIStore((state) => state.isSidebarTransitioning);
    const rounding = isSplitPane ? PANE_RADIUS : "rounded-t-xl";

    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const hasConnectedRef = useRef(false);
    const isReadyRef = useRef(false);
    const hasFailedRef = useRef(false);
    const lastSizeRef = useRef({rows: 0, cols: 0});
    const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
    const [dropPlacement, setDropPlacement] = useState<SplitPlacement | null>(null);
    const isConnecting = connectionState === "connecting";
    const fitAndResizeRef = useRef<(forceResize?: boolean) => void>(() => {});
    const appearanceRef = useRef(appearance);
    appearanceRef.current = appearance;
    const onFocusRef = useRef(onFocus);
    onFocusRef.current = onFocus;
    // The fit is deferred to requestAnimationFrame, so it must read the current flag instead of the
    // one captured when it was scheduled. A stale true would pull the focus back to this pane and undo
    // the pane the user just switched to.
    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;

    fitAndResizeRef.current = (forceResize = false) => {
        // A failed session still has to be fitted, otherwise the error printed into it stays invisible.
        if (!isVisible || (!isReadyRef.current && !hasFailedRef.current)) return;

        window.requestAnimationFrame(() => {
            const container = containerRef.current;
            const terminal = terminalRef.current;
            const fitAddon = fitAddonRef.current;
            if (!container || !terminal || !fitAddon || container.clientWidth === 0 || container.clientHeight === 0) return;

            try {
                fitAddon.fit();
                terminal.refresh(0, terminal.rows - 1);
                if (isActiveRef.current) terminal.focus();

                const sizeChanged = lastSizeRef.current.rows !== terminal.rows || lastSizeRef.current.cols !== terminal.cols;
                if (isReadyRef.current && (forceResize || sizeChanged)) {
                    lastSizeRef.current = {rows: terminal.rows, cols: terminal.cols};
                    SshService.Resize(sessionId, terminal.rows, terminal.cols).catch(printErrorToTerminal);
                }
            } catch (error) {
                console.warn("xterm fit failed:", error);
            }
        });
    };

    const printErrorToTerminal = (error: unknown) => {
        if (!terminalRef.current) return;
        const appError = parseAppError(error);

        // TODO think of something better
        // \x1b[0m = reset formatting
        // \x1b[31m = red
        console.log(appError)
        const translated = t("error_message", { message: appError.message, error: appError.detailsString })
        terminalRef.current.write(`\r\n\x1b[31m${translated}\x1b[0m\r\n`)
    };

    const getDropPlacement = (event: ReactDragEvent<HTMLDivElement>): SplitPlacement => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width;
        const y = (event.clientY - bounds.top) / bounds.height;
        const distances: [SplitPlacement, number][] = [
            ["left", x],
            ["right", 1 - x],
            ["above", y],
            ["below", 1 - y],
        ];
        return distances.reduce((closest, candidate) => candidate[1] < closest[1] ? candidate : closest)[0];
    };

    const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!isSplitPane || !event.dataTransfer.types.includes(TERMINAL_SESSION_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropPlacement(getDropPlacement(event));
    };

    // xterm only takes focus when the click lands on its own canvas, which leaves the inner padding and
    // the frame overlay as dead zones. The pane owns the focus instead, so a click anywhere on a pane
    // makes it the active one and routes the keyboard there.
    const handlePanePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest("button")) return;

        onFocusRef.current();
    };

    const handlePaneClick = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest("button")) return;

        // Runs after the mousedown default action, so the focus is not reset right afterwards.
        terminalRef.current?.focus();
    };

    const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!isSplitPane) return;
        const draggedSessionID = event.dataTransfer.getData(TERMINAL_SESSION_DRAG_TYPE);
        if (!draggedSessionID) return;
        event.preventDefault();
        const placement = getDropPlacement(event);
        setDropPlacement(null);
        if (draggedSessionID !== sessionId) onDropSession?.(draggedSessionID, sessionId, placement);
    };

    useEffect(() => {
        if (!containerRef.current || terminalRef.current) return;
        const container = containerRef.current;

        const term = new Terminal(createTerminalOptions(appearanceRef.current));
        const fitAddon = new FitAddon();

        term.loadAddon(fitAddon);
        term.open(containerRef.current);

        terminalRef.current = term;
        fitAddonRef.current = fitAddon;
        const handleFocus = () => onFocusRef.current();
        container.addEventListener("focusin", handleFocus);

        term.attachCustomKeyEventHandler((arg) => {
            if (arg.type === "keydown") {
                if (arg.ctrlKey && arg.shiftKey && arg.code === "KeyC") {
                    arg.preventDefault();
                    const selection = term.getSelection();
                    if (selection) {
                        Clipboard.SetText(selection).catch(console.error);
                    }
                    return false;
                }

                if (arg.ctrlKey && arg.shiftKey && arg.code === "KeyV") {
                    arg.preventDefault();
                    Clipboard.Text().then((text) => {
                        if (text && isReadyRef.current) {
                            term.paste(text);
                        }
                    }).catch(console.error);
                    return false;
                }
            }
            return true;
        });

        const handleContextMenu = (e: MouseEvent) => {
            e.preventDefault();

            const selection = term.getSelection();
            if (selection) {
                Clipboard.SetText(selection).catch(console.error);
                term.clearSelection();
            } else {
                Clipboard.Text().then((text) => {
                    if (text && isReadyRef.current) {
                        SshService.Input(sessionId, text).catch(printErrorToTerminal);
                    }
                }).catch(console.error);
            }
        };
        containerRef.current.addEventListener("contextmenu", handleContextMenu);

        if (!hasConnectedRef.current) {
            hasConnectedRef.current = true;
            SshService.Connect(config)
                .then(() => {
                    isReadyRef.current = true;
                    setConnectionState("ready");
                })
                .catch((err) => {
                    // The error is printed into the terminal, so the overlay has to give way to it.
                    hasFailedRef.current = true;
                    setConnectionState("failed");
                    printErrorToTerminal(err);
                });
        }

        const onDataDisposable = term.onData((data) => {
            if (!isReadyRef.current) return;

            SshService.Input(sessionId, data).catch((err) => {
                printErrorToTerminal(err);
            });
        });

        return () => {
            container.removeEventListener("contextmenu", handleContextMenu);
            container.removeEventListener("focusin", handleFocus);
            onDataDisposable.dispose();
            term.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
            SshService.Disconnect(sessionId).catch(() => {
            });
        };
    }, [sessionId, config]);

    useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        const options = createTerminalOptions(appearance);
        terminal.options.fontFamily = options.fontFamily;
        terminal.options.fontSize = options.fontSize;
        terminal.options.theme = options.theme;
        terminal.refresh(0, terminal.rows - 1);
        fitAndResizeRef.current(true);
    }, [
        appearance.terminalBackgroundColor,
        appearance.terminalCursorColor,
        appearance.terminalFontFamily,
        appearance.terminalFontSize,
        appearance.terminalForegroundColor,
    ]);

    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshData, (event) => {
            if (event.data.id === sessionId && terminalRef.current) {
                const rawBytes = decodeBase64ToUint8Array(event.data.data);

                terminalRef.current.write(rawBytes);
            }
        });
        return () => unsubscribe();
    }, [sessionId]);

    useEffect(() => {
        if (!isVisible || isConnecting) return;

        const frameIds: number[] = [];
        const firstFrame = window.requestAnimationFrame(() => {
            const secondFrame = window.requestAnimationFrame(() => fitAndResizeRef.current(true));
            frameIds.push(secondFrame);
        });
        frameIds.push(firstFrame);
        return () => frameIds.forEach((frame) => window.cancelAnimationFrame(frame));
    }, [isActive, isConnecting, isVisible, sessionId]);

    useEffect(() => {
        if (isSidebarTransitioning) return;
        fitAndResizeRef.current(true);
    }, [isSidebarTransitioning]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !isVisible || isConnecting) return;

        const resizeObserver = new ResizeObserver(() => {
            if (useUIStore.getState().isSidebarTransitioning) return;
            fitAndResizeRef.current();
        });
        resizeObserver.observe(container);
        return () => resizeObserver.disconnect();
    }, [isActive, isConnecting, isVisible, sessionId]);

    return (
        <div
            style={layoutStyle}
            data-split-pane-id={isSplitPane ? sessionId : undefined}
            data-workspace-id={isSplitPane ? workspaceID : undefined}
            onDragOver={handleDragOver}
            onPointerDown={handlePanePointerDown}
            onClick={handlePaneClick}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPlacement(null);
            }}
            onDrop={handleDrop}
            className={cn(
                "group relative h-full w-full min-h-0 min-w-0 bg-background",
                // `block` must not be added here: tailwind-merge resolves display clashes by keeping the
                // last class, which would silently drop `flex` and let the surface size itself by content.
                isSplitPane ? cn("flex flex-col overflow-hidden", rounding) : undefined,
                isVisible ? undefined : "hidden"
            )}
        >
            {isSplitPane && (
                <ContextMenuPrimitive.Root>
                <ContextMenuPrimitive.Trigger asChild>
                <div className={cn(
                    "flex h-6 shrink-0 items-center justify-between gap-1 border-b border-white/15 px-1",
                    isActive && "bg-white/[0.035]"
                )}>
                    <div className="flex min-w-0 items-center gap-1.5">
                    <button
                        type="button"
                        draggable
                        onDragStart={(event) => {
                            event.dataTransfer.setData(TERMINAL_SESSION_DRAG_TYPE, sessionId);
                            event.dataTransfer.effectAllowed = "move";
                        }}
                        title={t("drag_pane")}
                        aria-label={t("drag_pane")}
                        className="flex size-5 shrink-0 cursor-grab items-center justify-center rounded hover:bg-muted active:cursor-grabbing"
                    >
                        <GripVertical className="size-3.5"/>
                    </button>
                    <span className="truncate text-xs font-medium text-foreground">{paneTitle || config.host}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                    <button
                        type="button"
                        title={t("detach_pane")}
                        aria-label={t("detach_pane")}
                        onClick={onDetachPane}
                        className="flex size-5 items-center justify-center rounded hover:bg-muted"
                    >
                        <PanelTopClose className="size-3.5"/>
                    </button>
                    <button
                        type="button"
                        title={t("close_tab")}
                        aria-label={t("close_named_tab", {name: paneTitle || config.host})}
                        onClick={onCloseSession}
                        className="flex size-5 items-center justify-center rounded hover:bg-destructive/20 hover:text-destructive"
                    >
                        <X className="size-3.5"/>
                    </button>
                    </div>
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
                    <ContextMenuAction onSelect={onDetachPane} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">
                        <Columns2 className="size-4"/>{t("remove_from_split")}
                    </ContextMenuAction>
                    <ContextMenuAction onSelect={onOpenSFTP} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">
                        <FolderOpen className="size-4"/>{t("open_sftp")}
                    </ContextMenuAction>
                    <ContextMenuPrimitive.Separator className="my-1 h-px bg-border"/>
                    <ContextMenuAction onSelect={onCloseSession} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">
                        <X className="size-4"/>{t("close_named_tab", {name: paneTitle || config.host})}
                    </ContextMenuAction>
                    <ContextMenuPrimitive.Separator className="my-1 h-px bg-border"/>
                    <ContextMenuAction onSelect={onCloseOthers} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">
                        <X className="size-4"/>{t("close_other_tabs")}
                    </ContextMenuAction>
                </ContextMenuPanel>
                </ContextMenuPrimitive.Portal>
                </ContextMenuPrimitive.Root>
            )}
            {dropPlacement && (
                <div className={cn(
                    "pointer-events-none absolute z-10 rounded-md border-2 border-primary bg-primary/15",
                    dropPlacement === "left" && "inset-y-1 left-1 w-1/2",
                    dropPlacement === "right" && "inset-y-1 right-1 w-1/2",
                    dropPlacement === "above" && "inset-x-1 top-1 h-1/2",
                    dropPlacement === "below" && "inset-x-1 bottom-1 h-1/2",
                )}/>
            )}
            {/* The terminal surface carries the terminal background colour, so a terminal can bleed to
                the window edges while its inner padding keeps the text off them. */}
            <div
                className={cn("relative overflow-hidden", isSplitPane ? "min-h-0 flex-1" : cn("h-full", rounding))}
                style={{backgroundColor: appearance.terminalBackgroundColor}}
            >
                {/* The canvas paints the terminal background itself, so it needs no placeholder treatment
                    and stays interactive: hiding it would block focus switching and the context menu while
                    the handshake is still running. */}
                <div ref={containerRef} className="h-full w-full p-2"/>
                {isConnecting && (
                    <div role="status"
                         className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3"
                         style={{color: appearance.terminalForegroundColor}}>
                        <LoaderCircle className="size-5 animate-spin opacity-70"/>
                        <div className="max-w-[80%] truncate text-xs opacity-70">
                            {t("connecting_to_host", {host: config.host})}
                        </div>
                    </div>
                )}
            </div>
            {isSplitPane && (
                /* Drawn last so the frame sits above the header and the terminal on every side.
                   An inset shadow cannot do this: the pane children would cover it. */
                <div
                    aria-hidden="true"
                    className={cn("pointer-events-none absolute inset-0 border", rounding)}
                    style={{borderColor: isActive ? "var(--split-pane-border-active)" : "var(--split-pane-border)"}}
                />
            )}
        </div>
    );
}
