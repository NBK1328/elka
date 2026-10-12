import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FolderPlus, FolderTree, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HostCard } from "@/components/views/HostCard";
import { HostModal } from "@/components/views/HostModal";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { useHosts, useSaveHost, useDeleteHost } from "@/hooks/useHosts";
import { useKeys } from "@/hooks/useKeys";
import { useCredentials } from "@/hooks/useCredentials";
import { useGroups, useSaveGroup } from "@/hooks/useGroups";
import { useSessionStore } from "@/store/sessionStore";
import { Host, HostGroup } from "../../../bindings/elka-desktop/backend/internal/services/blob";
import { GroupModal } from "@/components/views/GroupModal";
import { resolveHostAuthentication, resolveJumpHosts, resolvePortForwards } from "@/lib/sshConnection";
import { HostViewPicker } from "@/components/layout/HostViewPicker";
import { HostViewMode, useUIStore } from "@/store/uiStore";
import { saveHostViewPreference } from "@/lib/viewSettings";
import { handleAppError } from "@/lib/error";
import { cn } from "@/lib/utils";

export function HostsPage() {
    const {t} = useTranslation(["hosts", "common"]);
    const {data: hosts, isLoading} = useHosts();
    const {data: keys} = useKeys();
    const {data: credentials} = useCredentials();
    const {data: groups} = useGroups();

    const saveMutation = useSaveHost();
    const deleteMutation = useDeleteHost();
    const saveGroupMutation = useSaveGroup();
    const {addSession} = useSessionStore();
    const {selectedHostGroup, setSelectedHostGroup, showHostGroups, hostViewMode, setHostViewMode} = useUIStore();
    const displayedViewMode = hostViewMode === "tree" && !showHostGroups ? "list" : hostViewMode;

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
    const [editingHost, setEditingHost] = useState<Host | null>(null);
    const [editingGroup, setEditingGroup] = useState<HostGroup | null>(null);
    const [hostToDelete, setHostToDelete] = useState<Host | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [expandedTreeGroups, setExpandedTreeGroups] = useState<Set<string>>(new Set());

    const handleCreateNew = () => {
        setEditingHost(null);
        setIsModalOpen(true);
    };

    const handleEdit = (host: Host) => {
        setEditingHost(host);
        setIsModalOpen(true);
    };

    const handleDeletePrompt = (host: Host) => {
        setHostToDelete(host);
    };

    const handleConfirmDelete = () => {
        if (hostToDelete) deleteMutation.mutate(hostToDelete.id);
        setHostToDelete(null);
    };

    const handleSave = (host: Host) => {
        saveMutation.mutate(host, {onSuccess: () => setIsModalOpen(false)});
    };

    const handleSaveGroup = (group: HostGroup) => {
        saveGroupMutation.mutate(group, {onSuccess: () => setIsGroupModalOpen(false)});
    };

    const handleConnect = (host: Host) => {
        try {
            const auth = resolveHostAuthentication(host, keys || [], credentials || [], groups || []);
            addSession({
                host: host.host,
                port: host.port,
                ...auth,
                jumpHosts: resolveJumpHosts(host, hosts || [], keys || [], credentials || [], groups || []),
                portForwards: resolvePortForwards(host),
                title: host.name || host.host,
            });
        } catch (error) {
            handleAppError(error);
        }
    };

    const filteredHosts = useMemo(() => {
        const query = searchQuery.trim().toLocaleLowerCase();
        return hosts?.filter((h) =>
            (!showHostGroups || !selectedHostGroup || h.group?.trim() === selectedHostGroup) &&
            (
                h.name?.toLocaleLowerCase().includes(query) ||
                h.host.toLocaleLowerCase().includes(query) ||
                h.username.toLocaleLowerCase().includes(query) ||
                (showHostGroups && h.group?.toLocaleLowerCase().includes(query))
            )
        );
    }, [hosts, searchQuery, selectedHostGroup, showHostGroups]);

    const treeGroups = useMemo(() => {
        const grouped = new Map<string, Host[]>();
        for (const host of filteredHosts || []) {
            const groupName = host.group?.trim() || "";
            grouped.set(groupName, [...(grouped.get(groupName) || []), host]);
        }
        return Array.from(grouped.entries()).sort(([left], [right]) => {
            if (!left) return 1;
            if (!right) return -1;
            return left.localeCompare(right);
        });
    }, [filteredHosts]);

    const changeViewMode = (mode: HostViewMode) => {
        setHostViewMode(mode);
        saveHostViewPreference("hostViewMode", mode).catch(handleAppError);
    };

    return (
        <div className="app-scrollbar flex h-full w-full flex-col overflow-y-auto p-8">
            <div className="mb-8 flex w-full items-center gap-4">
                <h1 className="shrink-0 text-2xl font-bold tracking-tight text-foreground">
                    {t("page_title")}
                </h1>
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
                    <Input
                        placeholder={showHostGroups ? t("search_hosts_and_groups") : t("search_hosts")}
                        className="w-full border-border bg-input/50 pl-9"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>
                <Button onClick={handleCreateNew} className="shrink-0">
                    <Plus/>
                    {t("new_host")}
                </Button>
                {showHostGroups && (
                    <Button
                        variant="outline"
                        className="shrink-0"
                        onClick={() => {
                            setEditingGroup(null);
                            setIsGroupModalOpen(true);
                        }}
                    >
                        <FolderPlus/>
                        {t("new_group", {ns: "hosts"})}
                    </Button>
                )}
            </div>

            {showHostGroups && selectedHostGroup && (
                <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
                    <span>{t("filtered_group", {ns: "hosts", name: selectedHostGroup})}</span>
                    <Button size="icon-sm" variant="ghost" onClick={() => setSelectedHostGroup(null)} title={t("clear_group_filter", {ns: "hosts"})}>
                        <X className="size-4"/>
                    </Button>
                </div>
            )}

            <div className="mb-6 flex flex-wrap items-center gap-2">
                <HostViewPicker value={displayedViewMode} onChange={changeViewMode} allowTree={showHostGroups}/>
                {showHostGroups && groups && groups.length > 0 && (
                    <>
                    <Button
                        size="sm"
                        variant={selectedHostGroup === null ? "secondary" : "outline"}
                        onClick={() => setSelectedHostGroup(null)}
                    >
                        {t("all_groups", {ns: "hosts"})}
                    </Button>
                    {groups.map((group) => (
                        <Button
                            key={group.id}
                            size="sm"
                            variant={selectedHostGroup === group.name ? "secondary" : "outline"}
                            onClick={() => setSelectedHostGroup(group.name)}
                        >
                            {group.name}
                        </Button>
                    ))}
                    </>
                )}
            </div>

            {isLoading && <div className="text-sm text-muted-foreground">{t("loading_hosts")}</div>}

            {!isLoading && hosts?.length === 0 && (
                <div
                    className="flex flex-col items-center justify-center py-16 text-center
                               border-2 border-dashed border-border rounded-xl">
                    <h3 className="text-lg font-semibold text-foreground">{t("empty_title")}</h3>
                    <p className="mb-4 mt-2 text-sm text-muted-foreground">{t("empty_desc")}</p>
                    <Button variant="outline" onClick={handleCreateNew}>{t("add_first_host")}</Button>
                </div>
            )}

            {displayedViewMode === "cards" && (
                <div
                    className="grid w-full gap-4"
                    style={{gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))"}}
                >
                    {filteredHosts?.map((host) => (
                        <HostCard
                            key={host.id}
                            host={host}
                            showGroup={showHostGroups}
                            viewMode="cards"
                            onConnect={handleConnect}
                            onEdit={handleEdit}
                            onDelete={handleDeletePrompt}
                        />
                    ))}
                </div>
            )}
            {displayedViewMode === "list" && (
                <div className="flex w-full flex-col">
                    {filteredHosts?.map((host) => (
                        <HostCard
                            key={host.id}
                            host={host}
                            showGroup={showHostGroups}
                            viewMode="list"
                            onConnect={handleConnect}
                            onEdit={handleEdit}
                            onDelete={handleDeletePrompt}
                        />
                    ))}
                </div>
            )}
            {displayedViewMode === "tree" && (
                <div className="flex w-full flex-col gap-4">
                    {treeGroups.map(([groupName, groupHosts]) => {
                        const isExpanded = expandedTreeGroups.has(groupName);
                        return (
                            <section key={groupName || "ungrouped"}>
                                <button
                                    type="button"
                                    aria-expanded={isExpanded}
                                    onClick={() => setExpandedTreeGroups((current) => {
                                        const next = new Set(current);
                                        if (next.has(groupName)) next.delete(groupName);
                                        else next.add(groupName);
                                        return next;
                                    })}
                                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left font-medium text-foreground hover:bg-muted/50"
                                >
                                    <ChevronRight className={cn(
                                        "size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
                                        isExpanded && "rotate-90"
                                    )}/>
                                    <FolderTree className="size-4 text-muted-foreground"/>
                                    <span>{groupName || t("ungrouped_group", {ns: "hosts"})}</span>
                                    <span className="text-xs text-muted-foreground">{groupHosts.length}</span>
                                </button>
                                <div
                                    className={cn(
                                        "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
                                        isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                                    )}
                                >
                                    <div
                                        inert={!isExpanded}
                                        className={cn(
                                            "overflow-hidden transition-opacity duration-200 ease-out motion-reduce:transition-none",
                                            isExpanded ? "opacity-100" : "opacity-0"
                                        )}
                                    >
                                        <div className="ml-4 border-l border-border pl-3">
                                            {groupHosts.map((host) => (
                                                <HostCard
                                                    key={host.id}
                                                    host={host}
                                                    showGroup={false}
                                                    viewMode="tree"
                                                    onConnect={handleConnect}
                                                    onEdit={handleEdit}
                                                    onDelete={handleDeletePrompt}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </section>
                        );
                    })}
                </div>
            )}

            {!isLoading && hosts && hosts.length > 0 && filteredHosts?.length === 0 && (
                <p className="text-sm text-muted-foreground">{t("no_matches", {ns: "hosts"})}</p>
            )}

            <HostModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                onSave={handleSave}
                initialData={editingHost}
                isSaving={saveMutation.isPending}
            />

            <GroupModal
                isOpen={isGroupModalOpen}
                onClose={() => setIsGroupModalOpen(false)}
                onSave={handleSaveGroup}
                initialData={editingGroup}
                isSaving={saveGroupMutation.isPending}
            />

            <ConfirmModal
                isOpen={!!hostToDelete}
                onClose={() => setHostToDelete(null)}
                onConfirm={handleConfirmDelete}
                title={t("delete_title")}
                description={t("delete_desc", {name: hostToDelete?.name || hostToDelete?.host})}
                confirmText={t("delete", {ns: "common"})}
                isDestructive={true}
            />
        </div>
    );
}
