import { useState, useEffect, SyntheticEvent } from "react";
import {useTranslation} from "react-i18next";
import {ArrowDown, ArrowLeftRight, ArrowUp, Folder, Plus, Trash2} from "lucide-react";
import {Host, ItemType, JumpHopMode, JumpHostHop, PortForward, PortForwardMode, SavedCredential} from "../../../bindings/elka-desktop/backend/internal/services/blob";
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {PasswordInput} from "@/components/ui/password-input";
import {Switch} from "@/components/ui/switch";
import {Label} from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {SearchableSelect} from "@/components/ui/searchable-select";
import {credentialParts} from "@/lib/credentials";
import {cn} from "@/lib/utils";
import {useKeys} from "@/hooks/useKeys";
import {useCredentials} from "@/hooks/useCredentials";
import {useGroups} from "@/hooks/useGroups";
import {useHosts} from "@/hooks/useHosts";

const NO_GROUP_VALUE = "none";
const NO_JUMP_HOST_VALUE = "none";

/** Only an explicitly manual hop is an address typed by hand. */
const isManualHop = (hop: JumpHostHop) => hop.mode === JumpHopMode.JumpHopManual;

/** A hop is only saved once it names a saved host, or an address and a port it can be reached at. */
const hopIsComplete = (hop: JumpHostHop) => isManualHop(hop)
    ? !!hop.host?.trim() && (hop.port || 0) > 0 && (hop.port || 0) <= 65535
    : !!hop.hostId;

interface HostModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (host: Host) => void;
    initialData?: Host | null;
    isSaving: boolean;
}

const DEFAULT_HOST: Partial<Host> = {
    name: "",
    host: "",
    port: 22,
    username: "",
    password: "",
    passphrase: "",
    keyId: undefined,
    passwordCredentialId: undefined,
    passphraseCredentialId: undefined,
    privateKeyCredentialId: undefined,
    credentialId: undefined,
    jumpHostId: undefined,
    jumpHops: [],
    portForwards: [],
    usePasswordAsPassphrase: false,
    group: "",
};

export function HostModal({isOpen, onClose, onSave, initialData, isSaving}: HostModalProps) {
    const {t} = useTranslation(["hosts", "common", "credentials"]);
    const [formData, setFormData] = useState<Partial<Host>>(DEFAULT_HOST);
    const {data: keys} = useKeys();
    const {data: credentials} = useCredentials();
    const {data: groups} = useGroups();
    const {data: hosts} = useHosts();
    const jumpHosts = (hosts || []).filter((host) => host.id !== formData.id);
    const selectedGroup = groups?.find((group) => group.name.trim().toLocaleLowerCase() === formData.group?.trim().toLocaleLowerCase());
    const selectedCredential = credentials?.find((credential) => credential.id === (formData.credentialId || selectedGroup?.credentialId));
    const groupCredential = credentials?.find((credential) => credential.id === selectedGroup?.credentialId);
    const isGroupCredentialOverridden = !!groupCredential && !!formData.credentialId;

    /** Everything a saved credential holds, as the short list the group card prints. */
    const credentialDetails = (credential: SavedCredential) => [
        credential.username && `${t("username", {ns: "common"})}: ${credential.username}`,
        credentialParts(credential).password && t("password_kind", {ns: "credentials"}),
        credentialParts(credential).passphrase && t("passphrase_kind", {ns: "credentials"}),
        credentialParts(credential).privateKey && t("private_key_kind", {ns: "credentials"}),
    ].filter(Boolean).join(" · ");

    const groupCredentialSummary = groupCredential ? credentialDetails(groupCredential) : "";
    const legacyPasswordCredential = credentials?.find((credential) => credential.id === formData.passwordCredentialId);
    const inheritedUsername = legacyPasswordCredential?.username || selectedCredential?.username;

    /**
     * What the hop will actually authenticate with, spelled out where the hop is chosen.
     *
     * The chain resolves credentials in a fixed order and the form is the only place a user can see
     * it: credentials picked for the hop first, then the saved host's own, then the ones its group
     * inherits, and finally this host's credentials when the jump host has none of its own.
     */
    const jumpHopCredentialsHint = (hop: JumpHostHop) => {
        const selected = credentials?.find((credential) => credential.id === hop.credentialId);
        if (selected) {
            return [selected.name, credentialDetails(selected)].filter(Boolean).join(" · ");
        }

        if (isManualHop(hop)) {
            return t("jump_credentials_same_as_host", {ns: "hosts"});
        }
        // Nothing is known about a hop until the host behind it is picked.
        if (!hop.hostId) return "";

        const jumpHost = jumpHosts.find((host) => host.id === hop.hostId);
        if (!jumpHost) {
            return t("jump_credentials_fallback", {ns: "hosts"});
        }
        if (jumpHost.password || jumpHost.keyId || jumpHost.credentialId || jumpHost.passwordCredentialId ||
            jumpHost.passphraseCredentialId || jumpHost.privateKeyCredentialId) {
            return t("jump_credentials_from_jump_host", {ns: "hosts"});
        }

        const jumpHostGroup = groups?.find((group) =>
            group.name.trim().toLocaleLowerCase() === jumpHost.group?.trim().toLocaleLowerCase());
        const groupCredential = credentials?.find((credential) => credential.id === jumpHostGroup?.credentialId);
        if (groupCredential) {
            const details = credentialDetails(groupCredential);
            return t("jump_credentials_from_group", {
                ns: "hosts",
                name: jumpHostGroup?.name,
                credential: details ? ` · ${details}` : "",
            });
        }
        return t("jump_credentials_fallback", {ns: "hosts"});
    };

    useEffect(() => {
        if (isOpen) {
            if (initialData) {
                const jumpHops = initialData.jumpHops?.length
                    ? initialData.jumpHops
                    : initialData.jumpHostId
                        ? [new JumpHostHop({mode: JumpHopMode.JumpHopSavedHost, hostId: initialData.jumpHostId})]
                        : [];
                // A hop written before the mode existed carries none of it, and the connection reads
                // that as a server address typed by hand, which is empty. The saved host it points at
                // is what the hop was, so the mode is filled in before it reaches the form.
                setFormData({
                    ...initialData,
                    jumpHops: jumpHops.map((hop) =>
                        hop.mode ? hop : new JumpHostHop({
                            ...hop,
                            mode: hop.hostId ? JumpHopMode.JumpHopSavedHost : JumpHopMode.JumpHopManual,
                        })
                    ),
                });
            } else {
                setFormData(DEFAULT_HOST);
            }
        }
    }, [isOpen, initialData]);

    const handleSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
        e.preventDefault();

        const jumpHops = (formData.jumpHops || []).filter(hopIsComplete);

        const finalHost = new Host({
            ...formData,
            id: formData.id || "",
            type: ItemType.TypeHost,
            port: Number(formData.port) || 22,
            keyId: formData.keyId === "none" ? undefined : formData.keyId,
            passwordCredentialId: formData.credentialId ? undefined : formData.passwordCredentialId === "none" ? undefined : formData.passwordCredentialId,
            passphraseCredentialId: formData.credentialId ? undefined : formData.passphraseCredentialId === "none" ? undefined : formData.passphraseCredentialId,
            privateKeyCredentialId: formData.credentialId ? undefined : formData.privateKeyCredentialId === "none" ? undefined : formData.privateKeyCredentialId,
            credentialId: formData.credentialId === "none" ? undefined : formData.credentialId,
            jumpHostId: jumpHops.length === 0 && formData.jumpHostId !== "none" ? formData.jumpHostId : undefined,
            jumpHops,
            portForwards: (formData.portForwards || []).filter((forward) =>
                forward.listenPort > 0 && forward.listenPort <= 65535 &&
                forward.targetPort > 0 && forward.targetPort <= 65535 &&
                forward.targetAddress.trim() !== ""
            ),
            group: formData.group?.trim() || undefined,
        });

        onSave(finalHost);
    };

    const isEditing = !!initialData;

    const jumpHops = formData.jumpHops || [];
    const hasIncompleteJumpHop = jumpHops.some((hop) => !hopIsComplete(hop));

    const updateJumpHop = (index: number, update: Partial<JumpHostHop>) => {
        setFormData({
            ...formData,
            jumpHops: jumpHops.map((hop, currentIndex) =>
                currentIndex === index ? new JumpHostHop({...hop, ...update}) : hop
            ),
        });
    };

    const moveJumpHop = (index: number, offset: number) => {
        const destination = index + offset;
        if (destination < 0 || destination >= jumpHops.length) return;
        const updated = [...jumpHops];
        [updated[index], updated[destination]] = [updated[destination], updated[index]];
        setFormData({...formData, jumpHops: updated});
    };

    const addJumpHop = () => {
        setFormData({
            ...formData,
            jumpHops: [...jumpHops, new JumpHostHop({
                mode: JumpHopMode.JumpHopSavedHost,
                hostId: "",
                host: "",
                port: 22,
            })],
        });
    };

    const removeJumpHop = (index: number) => {
        setFormData({...formData, jumpHops: jumpHops.filter((_, currentIndex) => currentIndex !== index)});
    };

    const updatePortForward = (index: number, update: Partial<PortForward>) => {
        const forwards = formData.portForwards || [];
        setFormData({
            ...formData,
            portForwards: forwards.map((forward, currentIndex) =>
                currentIndex === index ? new PortForward({...forward, ...update}) : forward
            ),
        });
    };

    const addPortForward = () => {
        setFormData({
            ...formData,
            portForwards: [
                ...(formData.portForwards || []),
                new PortForward({
                    mode: PortForwardMode.PortForwardLocal,
                    listenAddress: "127.0.0.1",
                    listenPort: 0,
                    targetAddress: "127.0.0.1",
                    targetPort: 0,
                }),
            ],
        });
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{isEditing ? t("edit_title") : t("new_title")}</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="flex flex-col gap-4 py-4">
                    <div className="order-1 grid gap-2">
                        <Label htmlFor="name">{t("host_name_label", {ns: "hosts"})}</Label>
                        <Input
                            id="name"
                            value={formData.name || ""}
                            onChange={(e) =>
                                setFormData({...formData, name: e.target.value})}
                        />
                    </div>

                    <div className="order-3 grid grid-cols-4 gap-4">
                        <div className="col-span-3 grid gap-2">
                            <Label htmlFor="host">{t("host_ip", {ns: "common"})}</Label>
                            <Input
                                id="host"
                                required
                                value={formData.host || ""}
                                onChange={(e) =>
                                    setFormData({...formData, host: e.target.value})}
                            />
                        </div>
                        <div className="col-span-1 grid gap-2">
                            <Label htmlFor="port">{t("port", {ns: "common"})}</Label>
                            <Input
                                id="port"
                                type="number"
                                required
                                value={formData.port === undefined ? "" : formData.port}
                                onChange={(e) => {
                                    const val = parseInt(e.target.value);
                                    setFormData({...formData, port: isNaN(val) ? undefined : val});
                                }}
                            />
                        </div>
                    </div>

                    <div className="order-4 grid gap-2">
                        <Label htmlFor="username">{t("username", {ns: "common"})}</Label>
                        <Input
                            id="username"
                            required={!formData.username?.trim() && !inheritedUsername}
                            value={formData.username || ""}
                            onChange={(e) =>
                                setFormData({...formData, username: e.target.value})}
                        />
                    </div>

                    <div className="order-5 grid gap-2">
                        <Label htmlFor="password">{t("password_label", {ns: "hosts"})}</Label>
                        <PasswordInput
                            id="password"
                            value={formData.password || ""}
                            onChange={(e) =>
                                setFormData({...formData, password: e.target.value})}
                        />
                    </div>

                    <div className="order-6 grid gap-2">
                        <Label>{t("ssh_key_label", {ns: "hosts"})}</Label>
                        <Select
                            value={formData.keyId || "none"}
                            onValueChange={(val) => setFormData({
                                ...formData,
                                keyId: val === "none" ? undefined : val,
                                privateKeyCredentialId: undefined,
                            })}
                        >
                            <SelectTrigger>
                                <SelectValue placeholder={t("select_key_placeholder")}/>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">{t("none_use_password")}</SelectItem>
                                {keys?.map((key) => (
                                    <SelectItem key={key.id} value={key.id}>
                                        {key.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="order-9 grid gap-3 rounded-lg border border-border p-3">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex flex-col">
                                <Label>{t("jump_chain", {ns: "hosts"})}</Label>
                                <span className="text-xs text-muted-foreground">{t("jump_chain_help", {ns: "hosts"})}</span>
                            </div>
                            <Button type="button" variant="outline" size="sm" onClick={addJumpHop}>
                                <Plus className="mr-1 size-4"/>{t("add_jump_hop", {ns: "hosts"})}
                            </Button>
                        </div>
                        {jumpHops.map((hop, index) => (
                            <div key={index} className="grid gap-3 rounded-md bg-muted/30 p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-medium text-muted-foreground">
                                        {t("jump_hop_number", {ns: "hosts", number: index + 1})}
                                    </span>
                                    <div className="flex items-center">
                                        <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} title={t("move_jump_up", {ns: "hosts"})} onClick={() => moveJumpHop(index, -1)}>
                                            <ArrowUp className="size-4"/>
                                        </Button>
                                        <Button type="button" variant="ghost" size="icon-sm" disabled={index === jumpHops.length - 1} title={t("move_jump_down", {ns: "hosts"})} onClick={() => moveJumpHop(index, 1)}>
                                            <ArrowDown className="size-4"/>
                                        </Button>
                                        <Button type="button" variant="ghost" size="icon-sm" title={t("remove_jump_hop", {ns: "hosts"})} onClick={() => removeJumpHop(index)}>
                                            <Trash2 className="size-4"/>
                                        </Button>
                                    </div>
                                </div>
                                <Select
                                    value={hop.mode || JumpHopMode.JumpHopSavedHost}
                                    onValueChange={(value) => updateJumpHop(index, {
                                        mode: value as JumpHopMode,
                                        hostId: "",
                                        host: "",
                                        port: 22,
                                    })}
                                >
                                    <SelectTrigger><SelectValue/></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={JumpHopMode.JumpHopSavedHost}>{t("jump_saved_host", {ns: "hosts"})}</SelectItem>
                                        <SelectItem value={JumpHopMode.JumpHopManual}>{t("jump_manual_host", {ns: "hosts"})}</SelectItem>
                                    </SelectContent>
                                </Select>
                                {isManualHop(hop) ? (
                                    <div className="grid grid-cols-4 gap-3">
                                        <div className="col-span-3 grid gap-1">
                                            <Label>{t("jump_server_address", {ns: "hosts"})}</Label>
                                            <Input required value={hop.host || ""} onChange={(event) => updateJumpHop(index, {host: event.target.value})}/>
                                        </div>
                                        <div className="col-span-1 grid gap-1">
                                            <Label>{t("port", {ns: "common"})}</Label>
                                            <Input required type="number" min={1} max={65535} value={hop.port || ""} onChange={(event) => updateJumpHop(index, {port: Number(event.target.value) || 0})}/>
                                        </div>
                                    </div>
                                ) : (
                                    <SearchableSelect
                                        value={hop.hostId || NO_JUMP_HOST_VALUE}
                                        onValueChange={(hostId) => updateJumpHop(index, {hostId: hostId === NO_JUMP_HOST_VALUE ? "" : hostId})}
                                        options={[
                                            {value: NO_JUMP_HOST_VALUE, label: t("select_jump_host", {ns: "hosts"})},
                                            ...jumpHosts.map((host) => ({
                                                value: host.id,
                                                label: host.name || `${host.username}@${host.host}:${host.port}`,
                                                // A jump host is picked by whatever the user remembers it
                                                // by, and that is rarely the name shown in the list.
                                                searchTerms: [host.name, host.host, `${host.host}:${host.port}`, host.username, host.group || ""],
                                            })),
                                        ]}
                                        placeholder={t("select_jump_host", {ns: "hosts"})}
                                        searchPlaceholder={t("search_jump_host", {ns: "hosts"})}
                                        emptyLabel={t("no_jump_hosts_found", {ns: "hosts"})}
                                    />
                                )}
                                <div className="grid gap-1">
                                    <Label>{t("jump_credentials_label", {ns: "hosts"})}</Label>
                                    <Select
                                        value={hop.credentialId || "none"}
                                        onValueChange={(value) => updateJumpHop(index, {credentialId: value === "none" ? undefined : value})}
                                    >
                                        <SelectTrigger><SelectValue/></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="none">
                                                {isManualHop(hop)
                                                    ? t("jump_credentials_same_as_host", {ns: "hosts"})
                                                    : t("jump_credentials_from_jump_host", {ns: "hosts"})}
                                            </SelectItem>
                                            {credentials?.map((credential) => (
                                                <SelectItem key={credential.id} value={credential.id}>{credential.name}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">{jumpHopCredentialsHint(hop)}</p>
                                </div>
                            </div>
                        ))}
                        {hasIncompleteJumpHop && <p className="text-xs text-destructive">{t("complete_jump_hops", {ns: "hosts"})}</p>}
                    </div>

                    <div className="order-10 grid gap-3 rounded-lg border border-border p-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 text-sm font-medium">
                                <ArrowLeftRight className="size-4"/>
                                {t("port_forwarding", {ns: "hosts"})}
                            </div>
                            <Button type="button" variant="outline" size="sm" onClick={addPortForward}>
                                <Plus className="mr-1 size-4"/>{t("add_forward", {ns: "hosts"})}
                            </Button>
                        </div>
                        {(formData.portForwards || []).map((forward, index) => (
                            <div key={index} className="grid gap-3 rounded-md bg-muted/30 p-3">
                                <div className="flex items-center gap-2">
                                    <Select
                                        value={forward.mode}
                                        onValueChange={(value) => updatePortForward(index, {mode: value as PortForwardMode})}
                                    >
                                        <SelectTrigger><SelectValue/></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value={PortForwardMode.PortForwardLocal}>{t("local_forward", {ns: "hosts"})}</SelectItem>
                                            <SelectItem value={PortForwardMode.PortForwardRemote}>{t("remote_forward", {ns: "hosts"})}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        title={t("remove_forward", {ns: "hosts"})}
                                        onClick={() => setFormData({
                                            ...formData,
                                            portForwards: (formData.portForwards || []).filter((_, itemIndex) => itemIndex !== index),
                                        })}
                                    >
                                        <Trash2 className="size-4"/>
                                    </Button>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="grid gap-1">
                                        <Label>{forward.mode === PortForwardMode.PortForwardLocal
                                            ? t("local_listen_address", {ns: "hosts"})
                                            : t("remote_listen_address", {ns: "hosts"})}</Label>
                                        <Input value={forward.listenAddress} onChange={(event) => updatePortForward(index, {listenAddress: event.target.value})}/>
                                    </div>
                                    <div className="grid gap-1">
                                        <Label>{forward.mode === PortForwardMode.PortForwardLocal
                                            ? t("local_listen_port", {ns: "hosts"})
                                            : t("remote_listen_port", {ns: "hosts"})}</Label>
                                        <Input type="number" min={1} max={65535} required value={forward.listenPort || ""} onChange={(event) => updatePortForward(index, {listenPort: Number(event.target.value) || 0})}/>
                                    </div>
                                    <div className="grid gap-1">
                                        <Label>{forward.mode === PortForwardMode.PortForwardLocal
                                            ? t("remote_target_address", {ns: "hosts"})
                                            : t("local_target_address", {ns: "hosts"})}</Label>
                                        <Input required value={forward.targetAddress} onChange={(event) => updatePortForward(index, {targetAddress: event.target.value})}/>
                                    </div>
                                    <div className="grid gap-1">
                                        <Label>{forward.mode === PortForwardMode.PortForwardLocal
                                            ? t("remote_target_port", {ns: "hosts"})
                                            : t("local_target_port", {ns: "hosts"})}</Label>
                                        <Input type="number" min={1} max={65535} required value={forward.targetPort || ""} onChange={(event) => updatePortForward(index, {targetPort: Number(event.target.value) || 0})}/>
                                    </div>
                                </div>
                            </div>
                        ))}
                        <p className="text-xs text-muted-foreground">{t("forward_help", {ns: "hosts"})}</p>
                    </div>

                    <div className="order-8 grid gap-2">
                        <Label>{t("saved_credential_label", {ns: "credentials"})}</Label>
                        <Select
                            value={formData.credentialId || "none"}
                            onValueChange={(value) => setFormData({
                                ...formData,
                                credentialId: value === "none" ? undefined : value,
                                passwordCredentialId: undefined,
                                passphraseCredentialId: undefined,
                                privateKeyCredentialId: undefined,
                            })}
                        >
                            <SelectTrigger><SelectValue placeholder={t("select_credential", {ns: "credentials"})}/></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">{t("no_saved_credential", {ns: "credentials"})}</SelectItem>
                                {credentials?.map((credential) => (
                                    <SelectItem key={credential.id} value={credential.id}>{credential.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="order-7 grid gap-2">
                        <Label htmlFor="passphrase">{t("passphrase_label", {ns: "credentials"})}</Label>
                        <PasswordInput
                            id="passphrase"
                            value={formData.passphrase || ""}
                            onChange={(e) => setFormData({...formData, passphrase: e.target.value})}
                        />
                    </div>

                    <label htmlFor="use-password-as-passphrase"
                           className="order-7 flex cursor-pointer items-center justify-between gap-3 text-sm">
                        {t("use_password_as_passphrase", {ns: "credentials"})}
                        <Switch
                            id="use-password-as-passphrase"
                            checked={formData.usePasswordAsPassphrase || false}
                            onCheckedChange={(checked) => setFormData({...formData, usePasswordAsPassphrase: checked})}
                        />
                    </label>

                    <div className="order-2 grid gap-2">
                        <Label>{t("group_label", {ns: "hosts"})}</Label>
                        <SearchableSelect
                            value={formData.group || NO_GROUP_VALUE}
                            onValueChange={(value) => setFormData({
                                ...formData,
                                group: value === NO_GROUP_VALUE ? undefined : value,
                            })}
                            options={[
                                {value: NO_GROUP_VALUE, label: t("no_group", {ns: "hosts"})},
                                ...(groups || []).map((group) => ({value: group.name, label: group.name})),
                            ]}
                            placeholder={t("select_group", {ns: "hosts"})}
                            searchPlaceholder={t("search_group", {ns: "hosts"})}
                            emptyLabel={t("no_groups_found", {ns: "hosts"})}
                        />
                        {selectedGroup && groupCredential && (
                            <div className="grid gap-1 rounded-md border border-dashed border-border bg-muted/30 p-2.5 text-xs">
                                <div className="flex items-center gap-1.5 font-medium">
                                    <Folder className="size-3.5 shrink-0 text-muted-foreground"/>
                                    {t("group_credentials_title", {ns: "credentials", name: selectedGroup.name})}
                                </div>
                                {groupCredentialSummary && (
                                    <p className="text-muted-foreground">{groupCredentialSummary}</p>
                                )}
                                <p className={cn("text-muted-foreground", isGroupCredentialOverridden && "text-amber-600 dark:text-amber-400")}>
                                    {isGroupCredentialOverridden
                                        ? t("group_credentials_overridden", {ns: "credentials"})
                                        : t("group_credentials_precedence", {ns: "credentials"})}
                                </p>
                            </div>
                        )}
                    </div>

                    <div className="order-11 mt-4 flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
                            {t("cancel", {ns: "common"})}
                        </Button>
                        <Button type="submit" disabled={isSaving || hasIncompleteJumpHop}>
                            {isSaving ? t("saving", {ns: "common"}) : t("save_host")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
