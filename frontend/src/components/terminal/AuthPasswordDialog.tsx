import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";

interface AuthPasswordDialogProps {
    open: boolean;
    /** The login the server refused, shown so a wrong username can be spotted before retrying. */
    username: string;
    /** Where the password will be used, phrased as "host:port". */
    target: string;
    isConnecting: boolean;
    onCancel: () => void;
    onSubmit: (password: string) => void;
}

/**
 * The password prompt an ssh client opens when the server turns the stored credentials away.
 *
 * Credentials inherited from a group, copied from a jump host or simply left over from an earlier
 * password are the usual reason, and none of that can be told apart from the outside: the terminal
 * only learns that the login was refused. Asking here is what turns that dead end into a working
 * session, and it mirrors what `ssh login@host` does on the same server.
 */
export function AuthPasswordDialog({open, username, target, isConnecting, onCancel, onSubmit}: AuthPasswordDialogProps) {
    const {t} = useTranslation(["terminal", "common"]);
    const [password, setPassword] = useState("");

    useEffect(() => {
        if (open) setPassword("");
    }, [open, username, target]);

    return (
        <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !isConnecting && onCancel()}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("auth_password_title")}</DialogTitle>
                </DialogHeader>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        // An empty password is not a guess, it is the same refusal one more time.
                        if (password) onSubmit(password);
                    }}
                    className="grid gap-4"
                >
                    <p className="text-sm text-muted-foreground">
                        {t("auth_password_desc", {target, username})}
                    </p>
                    <div className="grid gap-1.5">
                        <Label htmlFor="auth-password">{t("password", {ns: "common"})}</Label>
                        <PasswordInput
                            id="auth-password"
                            autoFocus
                            required
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onCancel} disabled={isConnecting}>
                            {t("cancel", {ns: "common"})}
                        </Button>
                        <Button type="submit" disabled={!password || isConnecting}>
                            {isConnecting ? t("connecting_to_host", {host: target}) : t("auth_password_connect")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}