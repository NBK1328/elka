import { useEffect, useRef, useState } from "react";
import type {
    CSSProperties,
    DragEvent as ReactDragEvent,
    MouseEvent as ReactMouseEvent,
    PointerEvent as ReactPointerEvent,
} from "react";
import type { IDisposable, Terminal as XtermTerminal } from "@xterm/xterm";
import { Events, Clipboard } from "@wailsio/runtime";
import { createTerminalOptions, normalizeScrollback } from "@/lib/terminalTheme";
import { ensureTerminalFontLoaded } from "@/lib/terminalFont";
import { parseAppError } from "@/lib/error";
import { ErrorCode } from "@/lib/errorCodes";
import { registerTerminalInput } from "@/lib/terminalInput";
import { attachSessionDragImage } from "@/lib/sessionDrag";
import { cn, decodeBase64ToUint8Array } from "@/lib/utils";
import { SSHConnectionConfig, SshService } from "../../../bindings/elka-desktop/backend/internal/services/ssh";
import { useTranslation } from "react-i18next";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { ContextMenuAction, ContextMenuPanel } from "@/components/layout/ContextMenuAction";
import { AuthPasswordDialog } from "@/components/terminal/AuthPasswordDialog";
import { AppEvent } from "@/lib/events.ts";
import { Columns2, CopyPlus, FolderOpen, LoaderCircle, PanelTopClose, PlugZap, RefreshCw, X } from "lucide-react";
import { SplitPlacement, TERMINAL_SESSION_DRAG_TYPE, paneDropPlacement, useSessionStore } from "@/store/sessionStore";
import { useUIStore } from "@/store/uiStore";

/**
 * The terminal itself is loaded only once a session is actually opened.
 *
 * xterm is most of the bundle, and the webview has to parse and compile all of it before the hosts
 * screen can be used — for a screen that shows a list of connections and no terminal at all. Splitting
 * it out keeps the work until the moment it pays for itself. The stylesheet rides along with the code
 * so the layout does not reflow when it arrives.
 *
 * The renderer is a separate chunk so that a session which never opens — a vault sitting on the lock
 * screen, a window left on the host list — does not download it either.
 */
async function loadTerminalModules() {
    const [xterm, fit, unicode, webgl] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-webgl"),
    ]);
    await import("@xterm/xterm/css/xterm.css");
    return {
        Terminal: xterm.Terminal,
        FitAddon: fit.FitAddon,
        Unicode11Addon: unicode.Unicode11Addon,
        WebglAddon: webgl.WebglAddon,
    };
}

type TerminalModules = Awaited<ReturnType<typeof loadTerminalModules>>;

/**
 * How long a session has to be out of sight before its canvases are handed back, in milliseconds.
 *
 * Long enough that switching a tab, splitting a pane or dragging a divider costs nothing at all, and
 * short enough that walking away from a screenful of terminals gives the memory back long before
 * anyone goes looking for where it went.
 */
const RENDERER_RELEASE_DELAY_MS = 30000;

/**
 * Whether this machine's WebGL is only a software rasteriser.
 *
 * A virtual machine, a remote desktop session without GPU passthrough, or Mesa's llvmpipe will hand
 * out a perfectly valid WebGL context that draws every glyph on the CPU. The accelerated renderer is
 * what keeps scrolling a long history flat, but on a software rasteriser it is slower and heavier
 * than the built in one, and there is no setting to undo that any more — so it is decided here,
 * once per session, from what the machine reports about itself. The probe canvas is thrown away
 * immediately; nothing is rendered into it.
 */
function isSoftwareWebGL(cache: {current: boolean | null}): boolean {
    if (cache.current !== null) return cache.current;
    let software = false;
    try {
        const probe = document.createElement("canvas");
        const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
        if (!gl) {
            software = true;
        } else {
            const info = gl.getExtension("WEBGL_debug_renderer_info");
            const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
            software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
            if (software) {
                console.info("WebGL is running in software here, using the built in terminal renderer");
            }
            gl.getExtension("WEBGL_lose_context")?.loseContext();
        }
    } catch {
        // A browser that will not answer the question gets the renderer that always works.
        software = false;
    }
    cache.current = software;
    return software;
}

type ConnectionState = "connecting" | "ready" | "failed";

// Счётчик имён дозвонов. Он общий на окно, потому что имя должно быть уникальным внутри сессии, а
// не внутри вкладки: разборка приходит от прошлого дозвона той же сессии.
let attemptCounter = 0;

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
    /** Why the server ended this session. Empty while the session is up. */
    closedReason?: string;
    /** Отложить первый дозвон: подъём вкладок идёт волнами, чтобы не упереться в лимит sshd. */
    connectDelayMs?: number;
    /**
     * Вкладка поднята из снимка и до неё ещё не обращались.
     *
     * Пока это так, терминал не создаётся вовсе и соединение не набирается: и то и другое — заметная
     * память на каждую вкладку, а поднимать двадцать соединений при запуске незачем. Переключение
     * флага и есть момент, когда вкладку открыли: по нему эффект создания терминала перезапускается.
     */
    waitsForActivation?: boolean;
}

// Split panes are rounded on every corner, wherever they sit in the layout.
const PANE_RADIUS = "rounded-xl";

/**
 * How much unparsed output may sit in front of the terminal before the history is squeezed.
 *
 * xterm refuses to queue more than fifty megabytes and throws the rest away
 * ("write data discarded, use flow control to avoid losing data"), which on a fast `cat` or a build
 * log arrives as missing lines and a stalled screen. Letting the queue grow to that point also means
 * growing it with the buffer attached. Shedding history while the flood lasts keeps the terminal
 * responsive and the memory flat; the full scrollback is put back as soon as the flood is over.
 */
const OUTPUT_PRESSURE_BYTES = 4 * 1024 * 1024;

/** The history a terminal falls back to while output is arriving faster than it can be parsed. */
const SCROLLBACK_UNDER_PRESSURE = 1000;

/**
 * A burst of resize events has to collapse into one grid change.
 *
 * Resizing a terminal reflows its entire scrollback: every line is rebuilt at the new width, which at
 * ten thousand lines is tens of megabytes of fresh buffers. Dragging a window edge or a pane divider
 * reports a resize per frame, and applying each one paid that price over and over for a size that was
 * still moving. Waiting for the events to stop collapses a burst into a single reflow, and because the
 * wait ends in a guaranteed callback the final size is always applied.
 */
const FIT_SETTLE_MS = 60;

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
    closedReason,
    connectDelayMs,
    waitsForActivation = false,
}: TerminalInstanceProps) {
    const {t} = useTranslation("terminal");
    const appearance = useUIStore((state) => state.appearance);
    const rounding = isSplitPane ? PANE_RADIUS : "rounded-t-xl";

    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<XtermTerminal | null>(null);
    const fitAddonRef = useRef<InstanceType<TerminalModules["FitAddon"]> | null>(null);
    const webglRef = useRef<InstanceType<NonNullable<TerminalModules["WebglAddon"]>> | null>(null);
    const hasConnectedRef = useRef(false);
    // Каким дозвоном открыта эта сессия. Переподключение берёт тот же ID, и разборка предыдущего
    // дозвона может прийти на сервис позже нового, поэтому снимать соединение надо с тем же именем,
    // которым оно было открыто, а не с ID сессии.
    const attemptRef = useRef("");
    const isReadyRef = useRef(false);
    const hasFailedRef = useRef(false);
    const lastSizeRef = useRef({rows: 0, cols: 0});
    // Output that has been handed to xterm but not parsed yet. xterm drops its queue past fifty
    // megabytes, so this is the number that decides when the history has to make room.
    const unparsedRef = useRef(0);
    const underPressureRef = useRef(false);
    const rendererInstalledRef = useRef(false);
    // What the machine said about its own WebGL, asked at most once per session.
    const softwareRendererRef = useRef<boolean | null>(null);
    const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
    // Set when the server turned the stored credentials away and the password can be typed in. The
    // error is kept with it: dismissing the prompt has to say in the terminal why the session is dead.
    const [authPrompt, setAuthPrompt] = useState<{
        username: string;
        target: string;
        error: unknown;
        config: SSHConnectionConfig;
    } | null>(null);
    const [isRetryingAuth, setIsRetryingAuth] = useState(false);
    // A password typed at the prompt, kept by the session so a reconnect starts from what the server
    // accepted rather than from the credentials it already turned down.
    const acceptedPassword = useSessionStore(
        (state) => state.sessions.find((session) => session.id === sessionId)?.acceptedPassword);
    const rememberSessionPassword = useSessionStore((state) => state.rememberSessionPassword);
    // HTML5 drags set this locally; a drag that starts in the tab bar writes the store instead, because
    // the pointer never crosses the pane as an HTML5 drag event. Both end up in the same highlight.
    const [dropPlacement, setDropPlacement] = useState<SplitPlacement | null>(null);
    // The pane dims for the duration of the drag: otherwise source and target look alike and the pane
    // drag is unreadable. The state is local, so only the pane header re-renders.
    const [isPaneDragging, setIsPaneDragging] = useState(false);
    const paneDropPreview = useUIStore((state) => state.paneDropPreview);
    const previewPlacement = isSplitPane && paneDropPreview?.paneID === sessionId ? paneDropPreview.placement : null;
    const shownDropPlacement = previewPlacement || dropPlacement;
    const isConnecting = connectionState === "connecting";
    const fitAndResizeRef = useRef<(forceResize?: boolean) => void>(() => {});
    // Output that arrives before xterm exists, because the font it has to measure was still loading.
    const pendingWritesRef = useRef<Uint8Array[]>([]);
    const appearanceRef = useRef(appearance);
    appearanceRef.current = appearance;
    const onFocusRef = useRef(onFocus);
    onFocusRef.current = onFocus;
    // The fit is deferred to requestAnimationFrame, so it must read the current flag instead of the
    // one captured when it was scheduled. A stale true would pull the focus back to this pane and undo
    // the pane the user just switched to.
    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;

    /** Set once per terminal instance, by the effect that owns creating it. */
    const installRendererRef = useRef<(term: XtermTerminal) => void>(() => {});
    // The renderer classes only exist once the split chunk has arrived, and the fit that installs the
    // renderer is scheduled separately from the load that brings them in.
    const webglClassRef = useRef<NonNullable<TerminalModules["WebglAddon"]> | null>(null);

    /**
     * Hands output to xterm and watches how far behind the parser is running.
     *
     * A terminal that cannot keep up is a terminal that grows: xterm's queue has a fifty megabyte
     * ceiling and past it the session is damaged instead of slowed. Squeezing the history while the
     * backlog lasts keeps the queue short and the memory flat, and the full history is put back the
     * moment the backlog clears.
     */
    const writeToTerminal = (terminal: XtermTerminal, bytes: Uint8Array) => {
        unparsedRef.current += bytes.length;
        if (unparsedRef.current > OUTPUT_PRESSURE_BYTES && !underPressureRef.current) {
            underPressureRef.current = true;
            terminal.options.scrollback = SCROLLBACK_UNDER_PRESSURE;
        }

        const settled = () => {
            unparsedRef.current = Math.max(0, unparsedRef.current - bytes.length);
            if (underPressureRef.current && unparsedRef.current === 0) {
                underPressureRef.current = false;
                terminal.options.scrollback = normalizeScrollback(appearanceRef.current.terminalScrollback);
            }
        };

        try {
            terminal.write(bytes, settled);
        } catch (error) {
            // xterm throws once its queue is past the limit; counting the chunk as settled keeps the
            // backlog honest so the pressure does not latch on for the rest of the session.
            settled();
            console.warn("terminal write rejected:", error);
        }
    };

    fitAndResizeRef.current = (forceResize = false) => {
        // A failed session still has to be fitted, otherwise the error printed into it stays invisible.
        if (!isVisible || (!isReadyRef.current && !hasFailedRef.current)) return;

        window.requestAnimationFrame(() => {
            const container = containerRef.current;
            const terminal = terminalRef.current;
            const fitAddon = fitAddonRef.current;
            if (!container || !terminal || !fitAddon || container.clientWidth === 0 || container.clientHeight === 0) return;

            try {
                const proposed = fitAddon.proposeDimensions();
                if (!proposed) return;

                // fit() only resizes when the grid really changed, and it already clears the renderer
                // and rebuilds the whole viewport itself. Calling refresh() on top of that threw the
                // visible rows away and rebuilt them a second time on every single resize event.
                const sizeChanged = terminal.cols !== proposed.cols || terminal.rows !== proposed.rows;
                if (sizeChanged) {
                    fitAddon.fit();
                } else if (forceResize) {
                    // Nothing to resize, but the first pass after the font landed still has to be
                    // measured against it.
                    terminal.refresh(0, terminal.rows - 1);
                }

                // Both renderers read the cell dimensions when they are created, so the swap waits for
                // a grid that is more than xterm's placeholder 80x24.
                if (!rendererInstalledRef.current && terminal.cols > 2 && terminal.rows > 1) {
                    rendererInstalledRef.current = true;
                    installRendererRef.current(terminal);
                }

                const sizeChangedForPeer = lastSizeRef.current.rows !== terminal.rows || lastSizeRef.current.cols !== terminal.cols;
                if (isReadyRef.current && (forceResize || sizeChangedForPeer)) {
                    lastSizeRef.current = {rows: terminal.rows, cols: terminal.cols};
                    SshService.Resize(sessionId, terminal.rows, terminal.cols).catch(printErrorToTerminal);
                    // Focusing the hidden helper textarea on every tick made WebKit chase the caret
                    // through the pane, so it follows the size change instead of the observer.
                    if (isActiveRef.current) terminal.focus();
                }
            } catch (error) {
                console.warn("xterm fit failed:", error);
            }
        });
    };

    // Момент, когда поднятую вкладку открыли. Флаг снимается один раз, и его смена перезапускает
    // эффект, создающий терминал.
    useEffect(() => {
        if (waitsForActivation && isVisible) {
            useSessionStore.getState().markSessionOpened(sessionId);
        }
    }, [waitsForActivation, isVisible, sessionId]);

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

    const connectionPeer = (host: string, port: number, username?: string) =>
        username ? `${username}@${host}:${port}` : `${host}:${port}`;

    const connectionRoute = (failedConfig: SSHConnectionConfig) => {
        const hops = failedConfig.jumpHosts?.length
            ? failedConfig.jumpHosts
            : failedConfig.jumpHost ? [failedConfig.jumpHost] : [];
        return [
            t("connection_route_local"),
            ...hops.map((hop) => connectionPeer(hop.host, hop.port, hop.username)),
            connectionPeer(failedConfig.host, failedConfig.port, failedConfig.username),
        ].join(" → ");
    };

    const connectionAuthentication = (failedConfig: SSHConnectionConfig) => {
        const methods: string[] = [];
        if (failedConfig.password) methods.push(t("connection_auth_password"));
        if (failedConfig.privateKey) {
            methods.push(failedConfig.privateKeyPassphrase
                ? t("connection_auth_key_passphrase")
                : t("connection_auth_key"));
        }
        return methods.length > 0 ? methods.join(" + ") : t("connection_auth_none");
    };

    const connectionForwards = (forwards: SSHConnectionConfig["portForwards"]) =>
        (forwards || []).map((forward) => {
            const mode = forward.mode === "remote"
                ? t("connection_forward_remote")
                : t("connection_forward_local");
            return `${mode} ${forward.listenAddress || "127.0.0.1"}:${forward.listenPort}` +
                ` → ${forward.targetAddress}:${forward.targetPort}`;
        }).join(", ");

    const printConnectionErrorToTerminal = (error: unknown, failedConfig: SSHConnectionConfig) => {
        if (!terminalRef.current) return;
        const appError = parseAppError(error);
        const forwards = connectionForwards(failedConfig.portForwards);
        const details = [
            t("connection_failed_target", {
                target: connectionPeer(failedConfig.host, failedConfig.port, failedConfig.username),
            }),
            t("connection_failed_route", { route: connectionRoute(failedConfig) }),
            t("connection_failed_auth", { authentication: connectionAuthentication(failedConfig) }),
            ...(forwards ? [t("connection_failed_forwards", { forwards })] : []),
            t("connection_failed_reason", {
                reason: appError.detailsString || appError.message || String(error),
            }),
        ];
        terminalRef.current.write(
            `\r\n\x1b[31m${t("connection_failed_title")}\x1b[0m\r\n${details.join("\r\n")}\r\n`,
        );
    };

    /**
     * Opens the session, and decides what a refusal of the login means.
     *
     * Everything but a rejected login is printed into the terminal and stops there. A rejected one is
     * asked about instead: the credentials that were sent may have been inherited from a group, copied
     * from a jump host or simply be out of date, and none of that can be seen from this side, so the
     * session is offered the password the user actually types. The original failure rides along to be
     * printed if the prompt is dismissed.
     */
    // Сессия, которую оборвал сервер, больше ничего не принимает: отметка снимает готовность, иначе
    // ввод и ресайз продолжали бы уходить в закрытый канал и сыпать ошибками поверх истории.
    useEffect(() => {
        if (closedReason) isReadyRef.current = false;
    }, [closedReason]);

    const connectWith = (nextConfig: SSHConnectionConfig) => {
        // Каждый дозвон получает своё имя: без него разборка предыдущего дозвона, дошедшая до сервиса
        // после нового, закрыла бы сессию, которая только что открылась.
        attemptRef.current = `${nextConfig.id}:${++attemptCounter}`;
        const dialing = new SSHConnectionConfig({...nextConfig, attempt: attemptRef.current});

        setConnectionState("connecting");
        return SshService.Connect(dialing)
            .then(() => {
                isReadyRef.current = true;
                hasFailedRef.current = false;
                setAuthPrompt(null);
                setConnectionState("ready");
            })
            .catch((error) => {
                hasFailedRef.current = true;
                setConnectionState("failed");

                if (parseAppError(error).code === ErrorCode.SSH_AUTHENTICATION_FAILED) {
                    setAuthPrompt({
                        username: nextConfig.username,
                        target: `${nextConfig.host}:${nextConfig.port}`,
                        error,
                        config: dialing,
                    });
                    return;
                }
                // Anything else explains itself in the terminal, and leaving the prompt over it would
                // only hide the explanation behind a field for a password that is not the problem.
                setAuthPrompt(null);
                printConnectionErrorToTerminal(error, dialing);
            });
    };

    const retryWithPassword = (password: string) => {
        setIsRetryingAuth(true);
        // A password the server accepted belongs to this session from now on: reconnecting or
        // duplicating the tab reuses it instead of walking into the same refusal again.
        rememberSessionPassword(sessionId, password);
        void connectWith(new SSHConnectionConfig({...config, password}))
            .finally(() => setIsRetryingAuth(false));
    };

    const dismissAuthPrompt = () => {
        const refused = authPrompt;
        setAuthPrompt(null);
        if (refused) printConnectionErrorToTerminal(refused.error, refused.config);
    };

    const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!isSplitPane || !event.dataTransfer.types.includes(TERMINAL_SESSION_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        // The drag image is set through setDragImage, but WebKit renders the drag from text/plain and
        // ignores setDragImage when that type is missing: the session title would then follow the
        // cursor. In Chromium setDragImage wins, so the text is only there as a fallback.
        event.dataTransfer.setData("text/plain", paneTitle || config.host);
        setDropPlacement(paneDropPlacement(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY));
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
        const placement = paneDropPlacement(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
        setDropPlacement(null);
        if (draggedSessionID !== sessionId) onDropSession?.(draggedSessionID, sessionId, placement);
    };

    useEffect(() => {
        const container = containerRef.current;
        if (!container || terminalRef.current) return;

        let cancelled = false;
        let onDataDisposable: IDisposable | null = null;
        let unregisterInput: (() => void) | null = null;
        const handleFocus = () => onFocusRef.current();
        container.addEventListener("focusin", handleFocus);

        const handleContextMenu = (e: MouseEvent) => {
            e.preventDefault();

            const selection = terminalRef.current?.getSelection();
            if (selection) {
                Clipboard.SetText(selection).catch(console.error);
                terminalRef.current?.clearSelection();
            } else {
                Clipboard.Text().then((text) => {
                    if (text && isReadyRef.current) {
                        SshService.Input(sessionId, text).catch(printErrorToTerminal);
                    }
                }).catch(console.error);
            }
        };
        container.addEventListener("contextmenu", handleContextMenu);

        /**
         * Hands the renderer over to the GPU, and gives it back if that turns out not to be possible.
         *
         * The built in DOM renderer builds a fresh set of elements for every visible row on every
         * repaint, and xterm repaints the whole viewport on every step of a scroll — so scrolling
         * through a long history threw away and rebuilt the entire screen dozens of times a second.
         * The WebGL renderer draws the same rows into one canvas and a glyph atlas instead, which is
         * what keeps the web content process flat while the scrollback is scrolled. A machine or a
         * webview without a usable WebGL context keeps the DOM renderer rather than a blank screen.
         */
        installRendererRef.current = (term: XtermTerminal) => {
            const WebglAddon = webglClassRef.current;
            if (!WebglAddon) return;
            // The renderer is the one choice this build does not put in settings, so the machine gets
            // to make it: a context that only exists in software is the one case where the built in
            // renderer is the better of the two.
            if (isSoftwareWebGL(softwareRendererRef)) return;
            try {
                const addon = new WebglAddon();
                // loadAddon, not activate: it registers the addon with the terminal so that disposing
                // the terminal disposes the renderer with it.
                term.loadAddon(addon);
                // The context can be lost later, for instance when the GPU process is reset. Disposing
                // the addon puts the DOM renderer back and repaints, which beats leaving a frozen
                // canvas on screen.
                addon.onContextLoss(() => {
                    if (webglRef.current !== addon) return;
                    webglRef.current = null;
                    addon.dispose();
                });
                webglRef.current = addon;
            } catch (error) {
                // No WebGL here: the DOM renderer stays, and the terminal works as it always has.
                console.warn("WebGL renderer unavailable, keeping the DOM renderer:", error);
            }
        };

        // xterm measures the character cell once, when it opens, and keeps that measurement for the
        // lifetime of the instance. A web font that is still downloading at that moment is measured
        // through the fallback face, so every glyph ends up drawn at the wrong pitch and the columns
        // stop lining up. Nothing in xterm waits for a font, so opening is deferred until the face is
        // really in use, and output that arrives meanwhile is buffered below.
        const start = async () => {
            // Поднятая из снимка вкладка не создаёт ничего: ни терминала, ни соединения, пока до неё
            // не дойдёт очередь. Снимок снимается эффектом выше, его смена перезапускает и этот тоже.
            if (waitsForActivation) return;

            const current = appearanceRef.current;
            // The font and the code are fetched together: neither is worth blocking the other for, and
            // the terminal cannot be measured before both have arrived.
            const [modules] = await Promise.all([
                loadTerminalModules(),
                ensureTerminalFontLoaded(current.terminalFontFamily, current.terminalFontSize),
            ]);
            if (cancelled || terminalRef.current) return;
            const {Terminal, FitAddon, Unicode11Addon} = modules;
            webglClassRef.current = modules.WebglAddon;

            const term = new Terminal(createTerminalOptions(current));
            const fitAddon = new FitAddon();
            // Without the Unicode 11 tables the built in ones misjudge the width of newer characters,
            // which shifts the rest of the line sideways.
            term.loadAddon(new Unicode11Addon());
            term.loadAddon(fitAddon);
            term.open(container);

            terminalRef.current = term;
            fitAddonRef.current = fitAddon;

            const buffered = pendingWritesRef.current;
            if (buffered.length > 0) {
                pendingWritesRef.current = [];
                for (const chunk of buffered) writeToTerminal(term, chunk);
            }

            // In the alternate screen xterm turns the wheel into Up/Down keys, which scrolls the
            // shell history instead of the output. Forward the wheel only to apps that asked for
            // mouse reports; the normal buffer keeps its own scrollback.
            term.attachCustomWheelEventHandler((event) => {
                if (term.buffer.active.type !== "alternate") return true;
                const mouseMode = term.modes.mouseTrackingMode;
                if (mouseMode === "vt200" || mouseMode === "drag" || mouseMode === "any") return true;
                event.preventDefault();
                return false;
            });

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

            // Both ordinary typing and the macOS shortcuts end up here, so the session only ever receives
            // what this terminal decided to send, and a sequence does not depend on which element holds
            // the DOM focus.
            const sendInput = (data: string) => {
                if (!isReadyRef.current) return;

                SshService.Input(sessionId, data).catch((err) => {
                    printErrorToTerminal(err);
                });
            };

            onDataDisposable = term.onData(sendInput);
            unregisterInput = registerTerminalInput(sessionId, sendInput);

            if (!hasConnectedRef.current) {
                const openAfter = connectDelayMs || 0;
                if (openAfter > 0) await new Promise((resolve) => setTimeout(resolve, openAfter));
                // Флаг ставится после ожидания, а не до: перезапуск эффекта во время паузы отменил бы
                // прежнюю попытку, и вкладка осталась бы без дозвона навсегда — следующая попытка
                // увидела бы занятый флаг.
                if (cancelled || hasConnectedRef.current) return;
                hasConnectedRef.current = true;

                void connectWith(acceptedPassword
                    ? new SSHConnectionConfig({...config, password: acceptedPassword})
                    : config);
            }

            fitAndResizeRef.current(true);
        };
        void start().catch((error) => {
            if (cancelled) return;
            // A terminal that cannot be created at all still has to say so where the user can read it.
            hasFailedRef.current = true;
            setConnectionState("failed");
            printErrorToTerminal(error);
        });

        return () => {
            cancelled = true;
            installRendererRef.current = () => {};
            container.removeEventListener("contextmenu", handleContextMenu);
            container.removeEventListener("focusin", handleFocus);
            unregisterInput?.();
            onDataDisposable?.dispose();
            // The renderer is owned by the terminal now, which disposes its addons on the way out.
            webglRef.current = null;
            webglClassRef.current = null;
            rendererInstalledRef.current = false;
            terminalRef.current?.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
            unparsedRef.current = 0;
            underPressureRef.current = false;
            // Разборка нужна только соединению, которое действительно было открыто: перезапуск
            // эффекта для ещё не тронутой вкладки не должен рвать ничего.
            if (hasConnectedRef.current) {
                SshService.Disconnect(sessionId, attemptRef.current).catch(() => {
                });
            }
        };
        // Флаг ожидания в зависимостях: он переключается один раз, когда вкладку наконец открыли, и
        // именно этим перезапускает эффект. Видимости здесь быть не должно: её смена на каждый
        // переход между вкладками обрывала бы соединение, которое и так живёт в фоне.
    }, [sessionId, config, waitsForActivation]);

    useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;

        let cancelled = false;
        const apply = async () => {
            // Same reason as on creation: the new face has to be in use before xterm measures it,
            // otherwise the grid keeps the pitch of whatever the browser had at that moment.
            await ensureTerminalFontLoaded(appearance.terminalFontFamily, appearance.terminalFontSize);
            if (cancelled) return;

            const options = createTerminalOptions(appearance);
            // Changing a font option is what makes xterm measure the cell again and rebuild its glyph
            // atlas, so these assignments are the whole fix once the face is available.
            terminal.options.fontFamily = options.fontFamily;
            terminal.options.fontSize = options.fontSize;
            terminal.options.theme = options.theme;
            // Lowering the history trims what is already buffered, which is the only way to give the
            // memory back without throwing the session away.
            terminal.options.scrollback = normalizeScrollback(options.scrollback);
            terminal.refresh(0, terminal.rows - 1);
            fitAndResizeRef.current(true);
        };
        void apply();

        return () => {
            cancelled = true;
        };
    }, [
        appearance.terminalBackgroundColor,
        appearance.terminalCursorColor,
        appearance.terminalFontFamily,
        appearance.terminalFontSize,
        appearance.terminalForegroundColor,
        appearance.terminalScrollback,
    ]);

    useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;

        let cancelled = false;
        const apply = async () => {
            // A session that has not been created yet picks the new renderer up on its own.
            if (cancelled || !terminalRef.current) return;
        };
        void apply();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshData, (event) => {
            if (event.data.id !== sessionId) return;

            const rawBytes = decodeBase64ToUint8Array(event.data.data);
            const terminal = terminalRef.current;
            if (terminal) {
                writeToTerminal(terminal, rawBytes);
            } else {
                // The terminal opens once its font is ready, and the handshake output has to survive
                // that wait instead of being dropped on the floor.
                pendingWritesRef.current.push(rawBytes);
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

    /**
     * Hands the renderer back while nobody is looking, and takes it again on the way back.
     *
     * The accelerated renderer draws into two canvases the size of the terminal and keeps them for as
     * long as the session exists: three sessions, two of them on other tabs, were measured holding six
     * canvases of 2624x1664 — thirty five megabytes a tab — while two of those terminals sat at a size
     * of zero. Disposing the addon is the whole of the fix. It puts the built in renderer back and
     * repaints, so the session keeps its buffer, its cursor and the modes the shell negotiated, and
     * putting the renderer back is the install path that the next fit already runs.
     *
     * Rendering itself is not the problem here and is not what this stops: xterm watches its own screen
     * with an IntersectionObserver, and a hidden pane is `display: none`, so it has already stopped
     * drawing. What it cannot do is give the canvases back.
     */
    useEffect(() => {
        // Nothing to hand back on the way in: the fit installs the renderer for a pane on screen.
        if (isVisible) return;
        const timer = window.setTimeout(() => {
            const addon = webglRef.current;
            if (!addon) return;
            webglRef.current = null;
            // Cleared so that the next fit installs the renderer again rather than assuming it is there.
            rendererInstalledRef.current = false;
            addon.dispose();
        }, RENDERER_RELEASE_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [isVisible]);

    // A pane that becomes the visible one takes the keyboard, whether it was just switched to or was
    // waiting behind another tab. The fit does the same for a pane that resized into place, which is
    // how it happened before; this covers the switch, which does not resize anything.
    useEffect(() => {
        if (!isVisible || !isActive) return;
        terminalRef.current?.focus();
    }, [isVisible, isActive]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !isVisible || isConnecting) return;

        // Collapsed into a single fit per burst: a window drag or a divider drag reports a resize per
        // frame, and every one of them used to reflow the whole scrollback on its own.
        let timer = 0;
        const resizeObserver = new ResizeObserver(() => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => fitAndResizeRef.current(), FIT_SETTLE_MS);
        });
        resizeObserver.observe(container);
        return () => {
            resizeObserver.disconnect();
            window.clearTimeout(timer);
        };
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
                {/* Левая часть шапки и есть зона перетаскивания терминала: от левого края панели
                    до кнопок справа. Отдельный значок захвата для этого не нужен, а роль перетаскивания
                    окна сюда приклеивать нельзя — на нём ловится и правая кнопка, из-за чего контекстное
                    меню по шапке переставало открываться и вместо него двигалось окно. */}
                <div
                    className="flex h-6 shrink-0 items-center justify-between gap-1 border-b border-white/15 pl-3 pr-1"
                    style={{backgroundColor: "var(--split-pane-header)"}}
                >
                    <div
                        draggable
                        onDragStart={(event) => {
                            event.dataTransfer.setData(TERMINAL_SESSION_DRAG_TYPE, sessionId);
                            event.dataTransfer.effectAllowed = "move";
                            // The native drag image is taken from the source node, and here the source is a 24px
                            // tall header, so dragging a pane would read as stray text selection.
                            attachSessionDragImage(event, paneTitle || config.host);
                            setIsPaneDragging(true);
                        }}
                        onDragEnd={() => setIsPaneDragging(false)}
                        title={t("drag_pane")}
                        aria-label={t("drag_pane")}
                        className={cn(
                            "flex min-w-0 flex-1 cursor-grab items-center active:cursor-grabbing",
                            isPaneDragging && "opacity-50"
                        )}
                    >
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
            {shownDropPlacement && (
                <div className={cn(
                    "pointer-events-none absolute z-10 rounded-md border-2 border-primary bg-primary/15",
                    shownDropPlacement === "left" && "inset-y-1 left-1 w-1/2",
                    shownDropPlacement === "right" && "inset-y-1 right-1 w-1/2",
                    shownDropPlacement === "above" && "inset-x-1 top-1 h-1/2",
                    shownDropPlacement === "below" && "inset-x-1 bottom-1 h-1/2",
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
                    the handshake is still running.

                    Отступ живёт на обёртке, а не на измеряемом элементе: xterm считает clientHeight
                    вместе с отступами, поэтому при p-2 на самом контейнере терминал влезал на строку
                    больше, чем помещается, и нижняя строка уходила под рамку. Снизу отступ больше,
                    чтобы последняя строка не липла к краю окна. */}
                <div className="h-full w-full px-2 pt-2 pb-3">
                    <div ref={containerRef} className="h-full w-full"/>
                </div>
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
                {closedReason && !isConnecting && (
                    /* Сессия, которую оборвал сервер, держит вкладку на месте: без этого окно теряло
                       её вместе со всей историей и молча переключалось на соседнюю. */
                    <div role="status"
                         className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/60 px-8 text-center"
                         style={{color: appearance.terminalForegroundColor}}>
                        <PlugZap className="size-5 opacity-70"/>
                        <p className="max-w-[80%] text-xs opacity-80">{closedReason}</p>
                        <Button variant="outline" size="sm" onClick={onReconnect}>
                            <RefreshCw className="size-4"/>{t("reconnect")}
                        </Button>
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
            <AuthPasswordDialog
                open={!!authPrompt}
                username={authPrompt?.username || ""}
                target={authPrompt?.target || ""}
                isConnecting={isRetryingAuth}
                onCancel={dismissAuthPrompt}
                onSubmit={retryWithPassword}
            />
        </div>
    );
}
