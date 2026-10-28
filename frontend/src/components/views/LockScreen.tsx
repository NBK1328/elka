import { useState, useEffect, SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Lock, Shield, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { AuthService } from "../../../bindings/elka-desktop/backend/internal/services/auth";
import { useAuthStore } from "@/store/authStore";
import { handleAppError } from "@/lib/error";
import { SettingsService } from "../../../bindings/elka-desktop/backend/internal/services/settings";

type Mode = "select" | "create" | "login";

export function LockScreen() {
    const {t} = useTranslation(["auth", "common", "settings"]);

    const {setHasUser, setUnlocked} = useAuthStore();
    const [mode, setMode] = useState<Mode>("select");
    const [isChecking, setIsChecking] = useState(true);

    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [vaultDirectory, setVaultDirectory] = useState("");

    useEffect(() => {
        AuthService.HasUser()
            .then((exists) => {
                setHasUser(exists);
                setMode(exists ? "login" : "select");
            })
            .catch(handleAppError)
            .finally(() => setIsChecking(false));
        SettingsService.GetSettings()
            .then((settings) => setVaultDirectory(settings.vaultDirectory || ""))
            .catch(handleAppError);
    }, [setHasUser]);

    const chooseVaultDirectory = async () => {
        try {
            const directory = await SettingsService.SelectVaultDirectory();
            if (!directory) return;
            await SettingsService.SwitchVaultDirectory(directory);
            setVaultDirectory(directory);
        } catch (error) {
            handleAppError(error);
        }
    };

    const handleLogin = async (e: SyntheticEvent) => {
        e.preventDefault();
        setIsLoading(true);
        try {
            await AuthService.Login(password);
            setUnlocked(true);
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateLocal = async (e: SyntheticEvent) => {
        e.preventDefault();
        setIsLoading(true);
        try {
            await AuthService.RegisterLocal(username, password);
            setHasUser(true);
            setUnlocked(true);
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsLoading(false);
        }
    };

    if (isChecking) return (
        <div className="flex h-full items-center justify-center bg-background text-muted-foreground">
            {t("initializing")}
        </div>
    );

    return (
        <div className="absolute inset-0 z-50 flex h-full w-full items-center justify-center bg-background">
            <div className="relative w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg">

                {mode !== "select" && mode !== "login" && (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                            setMode("select");
                            setPassword("");
                        }}
                        className="absolute left-4 top-4 text-muted-foreground"
                    >
                        <ArrowLeft className="size-4"/>
                    </Button>
                )}

                {mode === "login" && (
                    <form onSubmit={handleLogin} className="space-y-4">
                        <div className="mb-6 flex flex-col items-center text-center">
                            <div className="mb-4 flex size-12 items-center justify-center
                                            rounded-full bg-primary/10 text-primary">
                                <Lock className="size-6"/>
                            </div>
                            <h2 className="text-2xl font-bold tracking-tight">{t("vault_locked_title")}</h2>
                            <p className="mt-1 text-sm text-muted-foreground">{t("vault_locked_desc")}</p>
                        </div>
                        <div className="rounded-lg border border-border bg-background p-3">
                            <div className="mb-2 text-xs font-medium text-muted-foreground">{t("vault_location_title", {ns: "settings"})}</div>
                            <div className="flex items-center justify-between gap-3">
                                <span className="min-w-0 truncate text-xs text-foreground" title={vaultDirectory}>
                                    {vaultDirectory || t("vault_default_location", {ns: "settings"})}
                                </span>
                                <Button type="button" variant="outline" size="sm" disabled={isLoading} onClick={chooseVaultDirectory}>
                                    <FolderOpen className="mr-2 size-4"/>{t("switch_vault_location", {ns: "settings"})}
                                </Button>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="password-login">{t("master_password")}</Label>
                            <PasswordInput
                                id="password-login"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                            />
                        </div>
                        <Button type="submit" className="w-full" disabled={isLoading}>
                            {isLoading ? t("unlocking", {ns: "common"}) : t("unlock")}
                        </Button>
                    </form>
                )}

                {mode === "select" && (
                    <div className="space-y-4">
                        <div className="mb-6 text-center">
                            <h2 className="text-2xl font-bold tracking-tight">{t("welcome_title")}</h2>
                            <p className="mt-1 text-sm text-muted-foreground">{t("welcome_desc")}</p>
                        </div>

                        <Button
                            variant="outline"
                            onClick={() => setMode("create")}
                            className="flex h-auto w-full items-center justify-start gap-4 p-4
                                       whitespace-normal text-left"
                        >
                            <div className="flex size-10 shrink-0 items-center justify-center
                                            rounded-lg bg-primary/10 text-primary">
                                <Shield className="size-5"/>
                            </div>
                            <div>
                                <div className="font-medium text-foreground">{t("create_local_title")}</div>
                                <div className="text-xs text-muted-foreground">{t("create_local_desc")}</div>
                            </div>
                        </Button>

                        <div className="mt-3 rounded-lg border border-border bg-background p-4">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium text-foreground">{t("vault_location_title", {ns: "settings"})}</div>
                                    <div className="truncate text-xs text-muted-foreground" title={vaultDirectory}>
                                        {vaultDirectory || t("vault_default_location", {ns: "settings"})}
                                    </div>
                                </div>
                                <Button type="button" variant="outline" size="sm" onClick={chooseVaultDirectory}>
                                    <FolderOpen className="mr-2 size-4"/>{t("choose_vault_location", {ns: "settings"})}
                                </Button>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">{t("vault_location_restart", {ns: "settings"})}</p>
                        </div>
                    </div>
                )}

                {mode === "create" && (
                    <form onSubmit={handleCreateLocal} className="space-y-4">
                        <div className="mb-6 mt-2 px-12 text-center">
                            <h2 className="text-xl font-bold tracking-tight">{t("create_vault_title")}</h2>
                        </div>
                        <div className="space-y-2">
                            <Label>{t("username", {ns: "common"})}</Label>
                            <Input
                                value={username}
                                onChange={(e) =>
                                    setUsername(e.target.value)}
                                required
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>{t("master_password")}</Label>
                            <PasswordInput
                                value={password}
                                onChange={(e) =>
                                    setPassword(e.target.value)}
                                required
                            />
                        </div>
                        <Button type="submit" className="w-full" disabled={isLoading}>
                            {isLoading ? t("creating", {ns: "common"}) : t("create_unlock_btn")}
                        </Button>
                    </form>
                )}

            </div>
        </div>
    );
}
