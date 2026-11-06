import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { ContentView } from "@/components/layout/ContentView";
import { LockScreen } from "@/components/views/LockScreen";
import { Toaster } from "@/components/ui/sonner";
import { useAuthStore } from "@/store/authStore";
import { Events } from "@wailsio/runtime";
import { useEffect, useState } from "react";
import { SettingsService } from "../bindings/elka-desktop/backend/internal/services/settings";
import { useTranslation } from "react-i18next";
import { AppEvent } from "@/lib/events.ts";
import { useSessionStore } from "@/store/sessionStore.ts";
import { useUIStore } from "@/store/uiStore.ts";
import { applyAppAppearance, DEFAULT_APPEARANCE } from "@/lib/appearance";
import { DEFAULT_TERMINAL_SCROLLBACK } from "@/lib/terminalFont";
import { ensureAppFontReady, DEFAULT_APP_FONT_FAMILY } from "@/lib/fontLoader";
import { preloadTerminalFace } from "@/lib/terminalFont";
import { dismissSplash } from "@/lib/splash";
import { useSessionPersistence } from "@/hooks/useSessionPersistence";
import { useWindowResizeCursor } from "@/hooks/useWindowResizeCursor";

export default function App() {
    const {isUnlocked} = useAuthStore();
    useSessionPersistence();
    useWindowResizeCursor();
    const {markSessionClosed} = useSessionStore();
    const {setShowHostGroups, setShowSidebarToggle, setServerMetrics, setHostViewMode, setGroupViewMode, setAppearance} = useUIStore();
    const appearance = useUIStore((state) => state.appearance);
    const {i18n, t} = useTranslation();

    // The colour variables are applied at once, but the family is only named once its faces are in
    // the document: pointing the whole window at a family that has not been fetched yet would repaint
    // every label in the fallback and then repaint it again when the faces arrive.
    const [readyFont, setReadyFont] = useState<string>(DEFAULT_APP_FONT_FAMILY);

    useEffect(() => {
        SettingsService.GetSettings()
            .then((settings) => {
                if (settings.language && settings.language !== i18n.language) {
                    void i18n.changeLanguage(settings.language);
                }
                setShowHostGroups(settings.showHostGroups ?? true);
                setShowSidebarToggle(settings.showSidebarToggle ?? true);
                setServerMetrics(settings.serverMetrics ?? true);
                setHostViewMode(settings.hostViewMode === "list" || settings.hostViewMode === "tree" ? settings.hostViewMode : "cards");
                setGroupViewMode(settings.groupViewMode === "cards" || settings.groupViewMode === "list" ? settings.groupViewMode : "tree");
                setAppearance({
                    appBackgroundColor: settings.appBackgroundColor || DEFAULT_APPEARANCE.appBackgroundColor,
                    appForegroundColor: settings.appForegroundColor || DEFAULT_APPEARANCE.appForegroundColor,
                    appAccentColor: settings.appAccentColor || DEFAULT_APPEARANCE.appAccentColor,
                    appFontFamily: settings.appFontFamily || DEFAULT_APPEARANCE.appFontFamily,
                    terminalBackgroundColor: settings.terminalBackground || DEFAULT_APPEARANCE.terminalBackgroundColor,
                    terminalForegroundColor: settings.terminalForeground || DEFAULT_APPEARANCE.terminalForegroundColor,
                    terminalCursorColor: settings.terminalCursor || DEFAULT_APPEARANCE.terminalCursorColor,
                    terminalCursorStyle: settings.terminalCursorStyle === "underline" || settings.terminalCursorStyle === "bar"
                        ? settings.terminalCursorStyle
                        : DEFAULT_APPEARANCE.terminalCursorStyle,
                    terminalFontFamily: settings.terminalFontFamily || DEFAULT_APPEARANCE.terminalFontFamily,
                    terminalFontSize: settings.terminalFontSize || DEFAULT_APPEARANCE.terminalFontSize,
                    terminalScrollback: settings.terminalScrollback || DEFAULT_TERMINAL_SCROLLBACK,
                    splitPaneBorderColor: settings.splitPaneBorder || DEFAULT_APPEARANCE.splitPaneBorderColor,
                    splitPaneHeaderColor: settings.splitPaneHeaderColor || DEFAULT_APPEARANCE.splitPaneHeaderColor,
                    serverMetricsColor: settings.serverMetricsColor || DEFAULT_APPEARANCE.serverMetricsColor,
                    sidebarColor: settings.sidebarColor || DEFAULT_APPEARANCE.sidebarColor,
                    inputColor: settings.inputColor || DEFAULT_APPEARANCE.inputColor,
                    ringColor: settings.ringColor || DEFAULT_APPEARANCE.ringColor,
                });
            })
            .catch(console.error)
            .finally(dismissSplash);
    }, [i18n, setAppearance, setGroupViewMode, setHostViewMode, setServerMetrics, setShowHostGroups, setShowSidebarToggle]);

    useEffect(() => {
        let cancelled = false;
        // Only the family the user actually chose. Importing the whole catalogue up front left the
        // webview holding every face of every bundled family for the whole session.
        void ensureAppFontReady(appearance.appFontFamily).then(() => {
            if (!cancelled) setReadyFont(appearance.appFontFamily);
        });
        return () => {
            cancelled = true;
        };
    }, [appearance.appFontFamily]);

    useEffect(() => {
        // Warming the one face the terminal measures with, while the user is still on the hosts
        // screen, keeps the first terminal from having to wait for a download.
        preloadTerminalFace(appearance.terminalFontFamily, appearance.terminalFontSize);
    }, [appearance.terminalFontFamily, appearance.terminalFontSize]);

    useEffect(() => {
        applyAppAppearance({...appearance, appFontFamily: readyFont});
    }, [appearance, readyFont]);

    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshClosed, (event) => {
            // Сессия, которую оборвал сервер, не удаляется: вкладка остаётся с причиной и кнопкой
            // переподключения. Удаление здесь означало, что окно молча теряет вкладку вместе со всей
            // её историей, и отличить это от закрытия пользователем было нечем.
            const sessionID = event.data?.id;
            if (!sessionID) return;

            console.info("SSH session ended on the server:", sessionID);
            markSessionClosed(sessionID, t("session_ended", {ns: "terminal"}));
        });

        return () => unsubscribe();
    }, [markSessionClosed, t]);


    return (
        <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
            <TitleBar/>
            {/* Зазор от нижней границы вкладок до содержимого задан здесь, а не на терминале:
                боковая панель и сам терминал лежат рядом в одной строке, поэтому уезжают вниз
                на равную величину и остаются одной высоты без отдельной подгонки. */}
            <div className="relative flex flex-1 overflow-hidden pt-[var(--content-top-gap)]">

                {!isUnlocked ? (
                    <LockScreen/>
                ) : (
                    <>
                        <Sidebar/>
                        <ContentView/>
                    </>
                )}

            </div>
            <Toaster position="bottom-right" theme="dark" richColors/>
        </div>
    );
}
