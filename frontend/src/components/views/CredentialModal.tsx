import { SyntheticEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { CredentialKind, ItemType, SavedCredential } from "../../../bindings/elka-desktop/backend/internal/services/blob";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Textarea } from "@/components/ui/textarea";

interface CredentialModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (credential: SavedCredential) => void;
    initialData?: SavedCredential | null;
    isSaving: boolean;
}

export function CredentialModal({isOpen, onClose, onSave, initialData, isSaving}: CredentialModalProps) {
    const {t} = useTranslation(["credentials", "common", "keys"]);
    const [name, setName] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [passphrase, setPassphrase] = useState("");
    const [privateKey, setPrivateKey] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!isOpen) return;
        setName(initialData?.name || "");
        setUsername(initialData?.username || "");
        setPassword(initialData?.password || (initialData?.kind === CredentialKind.CredentialKindPassword ? initialData.secret || "" : ""));
        setPassphrase(initialData?.passphrase || (initialData?.kind === CredentialKind.CredentialKindPassphrase ? initialData.secret || "" : ""));
        setPrivateKey(initialData?.privateKey || (initialData?.kind === CredentialKind.CredentialKindPrivateKey ? initialData.secret || "" : ""));
    }, [isOpen, initialData]);

    const handleFileRead = (file: File) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            if (typeof event.target?.result === "string") setPrivateKey(event.target.result);
        };
        reader.readAsText(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const hasSecret = Boolean(password || passphrase || privateKey);

    const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSave(new SavedCredential({
            id: initialData?.id || "",
            type: ItemType.TypeCredential,
            name: name.trim(),
            username: username.trim(),
            password,
            passphrase,
            privateKey,
        }));
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{initialData ? t("edit_title") : t("new_title")}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label htmlFor="credential-name">{t("name_label")}</Label>
                        <Input
                            id="credential-name"
                            required
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="credential-username">{t("username_label")}</Label>
                        <Input
                            id="credential-username"
                            autoComplete="username"
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="credential-password">{t("password_kind")}</Label>
                        <PasswordInput
                            id="credential-password"
                            autoComplete="new-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="credential-passphrase">{t("passphrase_kind")}</Label>
                        <PasswordInput
                            id="credential-passphrase"
                            autoComplete="new-password"
                            value={passphrase}
                            onChange={(event) => setPassphrase(event.target.value)}
                        />
                    </div>
                    <div className="grid gap-2">
                        <div className="flex items-center justify-between">
                            <Label htmlFor="credential-private-key">{t("private_key_label")}</Label>
                            <Button type="button" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                                <FileText className="mr-2 size-3"/>{t("load_from_file", {ns: "keys"})}
                            </Button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                className="hidden"
                                onChange={(event) => event.target.files?.[0] && handleFileRead(event.target.files[0])}
                            />
                        </div>
                        <Textarea
                            id="credential-private-key"
                            className="min-h-37.5 max-h-64 overflow-y-auto font-mono text-xs"
                            value={privateKey}
                            onChange={(event) => setPrivateKey(event.target.value)}
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                        />
                    </div>
                    <div className="mt-2 flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
                            {t("cancel", {ns: "common"})}
                        </Button>
                        <Button type="submit" disabled={isSaving || !name.trim() || !hasSecret}>
                            {isSaving ? t("saving", {ns: "common"}) : t("save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
