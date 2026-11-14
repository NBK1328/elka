import { SyntheticEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useCredentials } from "@/hooks/useCredentials";
import { useGroups } from "@/hooks/useGroups";
import { useHosts } from "@/hooks/useHosts";
import { useKeys } from "@/hooks/useKeys";
import { credentialParts } from "@/lib/credentials";
import { resolveHostAuthentication } from "@/lib/sshConnection";
import { SSHJumpHostConfig } from "../../../bindings/elka-desktop/backend/internal/services/ssh";
import type { CreateSessionParams } from "@/store/sessionStore";

const NO_CREDENTIAL = "none";
const NO_JUMP_HOST = "none";
const DEFAULT_PORT = 22;

interface QuickConnectModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConnect: (params: CreateSessionParams) => void;
}

export function QuickConnectModal({isOpen, onClose, onConnect}: QuickConnectModalProps) {
    const {t} = useTranslation(["hosts", "common", "credentials"]);
    const {data: credentials} = useCredentials();
    const {data: hosts} = useHosts();
    const {data: keys} = useKeys();
    const {data: groups} = useGroups();
    const [host, setHost] = useState("");
    const [port, setPort] = useState<number | undefined>(DEFAULT_PORT);
    const [credentialId, setCredentialId] = useState(NO_CREDENTIAL);
    const [jumpHostId, setJumpHostId] = useState(NO_JUMP_HOST);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");

    useEffect(() => {
        if (!isOpen) return;
        setHost("");
        setPort(DEFAULT_PORT);
        setCredentialId(NO_CREDENTIAL);
        setJumpHostId(NO_JUMP_HOST);
        setUsername("");
        setPassword("");
    }, [isOpen]);

    const selectedCredential = credentials?.find((credential) => credential.id === credentialId);
    const selectedJumpHost = hosts?.find((savedHost) => savedHost.id === jumpHostId);
    const usesManualCredentials = credentialId === NO_CREDENTIAL;
    const portNumber = Number(port);
    const validPort = portNumber > 0 && portNumber <= 65535;
    const canConnect = host.trim().length > 0 && validPort && (!!selectedCredential || username.trim().length > 0);

    const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!canConnect) return;

        const target = host.trim();
        const targetAuth = selectedCredential
            ? (() => {
                const parts = credentialParts(selectedCredential);
                return {
                    username: selectedCredential.username || "",
                    password: parts.password,
                    privateKey: parts.privateKey,
                    privateKeyPassphrase: parts.passphrase,
                };
            })()
            : {
                username: username.trim(),
                password,
                privateKey: "",
                privateKeyPassphrase: "",
            };

        const jumpHosts = selectedJumpHost ? (() => {
            const ownAuth = resolveHostAuthentication(selectedJumpHost, keys || [], credentials || [], groups || []);
            // A jump host with no credentials of its own routes traffic with the target's login,
            // the same fallback a saved host's chain uses.
            const auth = ownAuth.password || ownAuth.privateKey ? ownAuth : {
                username: ownAuth.username || targetAuth.username,
                password: targetAuth.password,
                privateKey: targetAuth.privateKey,
                privateKeyPassphrase: targetAuth.privateKeyPassphrase,
            };
            return [new SSHJumpHostConfig({
                host: selectedJumpHost.host,
                port: selectedJumpHost.port,
                username: auth.username || targetAuth.username,
                password: auth.password,
                privateKey: auth.privateKey,
                privateKeyPassphrase: auth.privateKeyPassphrase,
            })];
        })() : undefined;

        onConnect({
            host: target,
            port: portNumber,
            title: target,
            ...targetAuth,
            jumpHosts,
        });
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("quick_connect", {ns: "hosts"})}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label htmlFor="quick-connect-host">{t("host_ip", {ns: "common"})}</Label>
                        <Input
                            id="quick-connect-host"
                            autoFocus
                            required
                            autoComplete="off"
                            spellCheck={false}
                            value={host}
                            onChange={(event) => setHost(event.target.value)}
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="quick-connect-port">{t("port", {ns: "common"})}</Label>
                        <Input
                            id="quick-connect-port"
                            type="number"
                            min={1}
                            max={65535}
                            required
                            value={port === undefined ? "" : port}
                            onChange={(event) => {
                                const value = parseInt(event.target.value, 10);
                                setPort(isNaN(value) ? undefined : value);
                            }}
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label>{t("saved_credential_label", {ns: "credentials"})}</Label>
                        <Select value={credentialId} onValueChange={setCredentialId}>
                            <SelectTrigger><SelectValue/></SelectTrigger>
                            <SelectContent>
                                <SelectItem value={NO_CREDENTIAL}>{t("quick_connect_no_credential", {ns: "hosts"})}</SelectItem>
                                {credentials?.map((credential) => (
                                    <SelectItem key={credential.id} value={credential.id}>{credential.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="grid gap-2">
                        <Label>{t("quick_connect_jump_host", {ns: "hosts"})}</Label>
                        <SearchableSelect
                            value={jumpHostId}
                            onValueChange={setJumpHostId}
                            options={[
                                {value: NO_JUMP_HOST, label: t("quick_connect_no_jump_host", {ns: "hosts"})},
                                ...(hosts || []).map((savedHost) => ({
                                    value: savedHost.id,
                                    label: savedHost.name || `${savedHost.username}@${savedHost.host}:${savedHost.port}`,
                                    searchTerms: [
                                        savedHost.name,
                                        savedHost.host,
                                        `${savedHost.host}:${savedHost.port}`,
                                        savedHost.username,
                                        savedHost.group || "",
                                    ],
                                })),
                            ]}
                            placeholder={t("quick_connect_jump_host", {ns: "hosts"})}
                            searchPlaceholder={t("search_jump_host", {ns: "hosts"})}
                            emptyLabel={t("no_jump_hosts_found", {ns: "hosts"})}
                        />
                    </div>
                    {usesManualCredentials && (
                        <>
                            <div className="grid gap-2">
                                <Label htmlFor="quick-connect-username">{t("username", {ns: "common"})}</Label>
                                <Input
                                    id="quick-connect-username"
                                    required
                                    autoComplete="username"
                                    value={username}
                                    onChange={(event) => setUsername(event.target.value)}
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="quick-connect-password">{t("password", {ns: "common"})}</Label>
                                <PasswordInput
                                    id="quick-connect-password"
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </div>
                        </>
                    )}
                    <div className="mt-2 flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={onClose}>
                            {t("cancel", {ns: "common"})}
                        </Button>
                        <Button type="submit" disabled={!canConnect}>
                            {t("connect", {ns: "common"})}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
