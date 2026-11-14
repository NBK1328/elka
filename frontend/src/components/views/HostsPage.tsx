import { useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, FolderTree, Plus, Search, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CARD_HEIGHT, HostCard, LIST_ROW_HEIGHT } from "@/components/views/HostCard";
import { VirtualizedList } from "@/components/views/VirtualizedList";
import { HostModal } from "@/components/views/HostModal";
import { DeleteHostDialog } from "@/components/views/DeleteHostDialog";
import { useHosts, useSaveHost, useDeleteHost } from "@/hooks/useHosts";
import { useKeys } from "@/hooks/useKeys";
import { useCredentials } from "@/hooks/useCredentials";
import { useGroups } from "@/hooks/useGroups";
import { useSessionStore, type CreateSessionParams } from "@/store/sessionStore";
import { toast } from "sonner";
import { Host } from "../../../bindings/elka-desktop/backend/internal/services/blob";
import { QuickConnectModal } from "@/components/views/QuickConnectModal";
import { jumpHostDependents, resolveHostAuthentication, resolveJumpHosts, resolvePortForwards } from "@/lib/sshConnection";
import { HostViewPicker } from "@/components/layout/HostViewPicker";
import { HostViewMode, useUIStore } from "@/store/uiStore";
import { saveHostViewPreference } from "@/lib/viewSettings";
import { handleAppError } from "@/lib/error";

/**
 * Vertical pitch of one card row: the card itself, plus the gap the grid puts under it.
 *
 * This is the number the virtual list divides by, so it has to include the gap — a card measured
 * without it would make the list drift a sixteenth of a pixel per row and be visibly out by the
 * time the last row came into view. The card height itself lives with the card, in HostCard, where
 * it is also applied as a style so the two cannot drift apart.
 */
const CARD_GRID_GAP = 16;
const CARD_PITCH = CARD_HEIGHT + CARD_GRID_GAP;

/**
 * The narrowest column the cards grid accepts, in CSS pixels.
 *
 * The host rows handed to the virtual list are whole single lines of cards, so the chunking needs
 * to know how many columns the grid has. This is the `20rem` the old auto-fit grid asked for, and
 * the column count is derived exactly the way auto-fit counts its tracks: with the column-min and
 * the gap, a track only fits when its width plus its share of the gaps stays inside the row.
 */
const CARD_MIN_COLUMN = 320;

export function HostsPage() {
    const {t} = useTranslation(["hosts", "common"]);
    const {data: hosts, isLoading} = useHosts();
    const {data: keys} = useKeys();
    const {data: credentials} = useCredentials();
    const {data: groups} = useGroups();

    const saveMutation = useSaveHost();
    const deleteMutation = useDeleteHost();
    const {addSession} = useSessionStore();
    const {selectedHostGroup, setSelectedHostGroup, showHostGroups, hostViewMode, setHostViewMode} = useUIStore();
    const displayedViewMode = hostViewMode === "tree" && !showHostGroups ? "list" : hostViewMode;

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isQuickConnectOpen, setIsQuickConnectOpen] = useState(false);
    const [editingHost, setEditingHost] = useState<Host | null>(null);
    const [hostToDelete, setHostToDelete] = useState<Host | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [expandedTreeGroups, setExpandedTreeGroups] = useState<Set<string>>(new Set());
    // What the virtual list currently has on screen, for the "1-40 of 400" line below it. Only the
    // flat views report it: a tree shows a slice per open group, and there is no single range to name.
    const [visibleRange, setVisibleRange] = useState<{from: number; to: number}>({from: 0, to: 0});
    const setReportedRange = useCallback((from: number, to: number) => {
        setVisibleRange((current) => (current.from === from && current.to === to ? current : {from, to}));
    }, []);

    // The cards grid is virtualised one full line of cards at a time, and the line has to know how
    // many cards it holds. The width is read off a wrapper the moment the view mounts and on every
    // resize after that; a ref callback rather than an effect, because only the cards view mounts
    // the wrapper and a callback travels with it.
    const [cardsWidth, setCardsWidth] = useState(0);
    const bindCardsArea = useCallback((element: HTMLDivElement | null) => {
        if (!element) return;
        const observer = new ResizeObserver(() => setCardsWidth(element.clientWidth));
        observer.observe(element);
        setCardsWidth(element.clientWidth);
        return () => observer.disconnect();
    }, []);
    const cardColumns = Math.max(1, Math.floor((cardsWidth + CARD_GRID_GAP) / (CARD_MIN_COLUMN + CARD_GRID_GAP)));

    const handleCreateNew = () => {
        setEditingHost(null);
        setIsModalOpen(true);
    };

    const handleEdit = useCallback((host: Host) => {
        setEditingHost(host);
        setIsModalOpen(true);
    }, []);

    const handleDeletePrompt = useCallback((host: Host) => {
        setHostToDelete(host);
    }, []);

    const handleConfirmDelete = () => {
        if (!hostToDelete) return;
        // Список цепочек, в которых хост стоит шагом, снимается здесь: после удаления хостов в
        // хранилище уже нет, а сообщить о том, что шаги отвязаны, нужно по факту.
        const dependents = jumpHostDependents(hostToDelete.id, hosts || []);
        deleteMutation.mutate(hostToDelete.id, {
            onSuccess: () => {
                if (dependents.length > 0) {
                    toast.success(t("delete_jump_unlinked", {count: dependents.length}));
                }
            },
        });
        setHostToDelete(null);
    };

    const handleSave = (host: Host) => {
        saveMutation.mutate(host, {onSuccess: () => setIsModalOpen(false)});
    };

    const handleConnect = useCallback((host: Host) => {
        try {
            const auth = resolveHostAuthentication(host, keys || [], credentials || [], groups || []);
            addSession({
                hostID: host.id,
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
    }, [keys, credentials, groups, hosts, addSession]);

    const handleQuickConnect = useCallback((params: CreateSessionParams) => {
        addSession(params);
    }, [addSession]);

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

    const matchedHostCount = filteredHosts?.length || 0;

    // The virtual list turns a scroll offset into a row number by dividing by one row height, so
    // it has to be handed whole lines of cards: one item is one visual row of the grid. Feeding it
    // cards and letting CSS wrap them counted every column as a full row — a spacer columns times
    // longer than the grid, a slice that scrolled out of view within a screenful, and past that
    // only empty distance, which is the dark stretch the long vaults scrolled into.
    const cardRows = useMemo(() => {
        const rows: Host[][] = [];
        for (let i = 0; i < matchedHostCount; i += cardColumns) {
            rows.push((filteredHosts ?? []).slice(i, i + cardColumns));
        }
        return rows;
    }, [filteredHosts, matchedHostCount, cardColumns]);

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
                <Button
                    variant="outline"
                    className="shrink-0"
                    onClick={() => setIsQuickConnectOpen(true)}
                >
                    <Zap/>
                    {t("quick_connect", {ns: "hosts"})}
                </Button>
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
                <div ref={bindCardsArea}>
                    <VirtualizedList
                        items={cardRows}
                        itemHeight={CARD_PITCH}
                        renderItem={(row) => (
                            <div
                                className="grid"
                                style={{gridTemplateColumns: `repeat(${cardColumns}, minmax(0, 1fr))`, gap: `${CARD_GRID_GAP}px`}}
                            >
                                {row.map((host, index) => (
                                    <HostCard
                                        key={index}
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
                        onRangeChange={setReportedRange}
                    />
                </div>
            )}
            {displayedViewMode === "list" && (
                <VirtualizedList
                    key="rows"
                    items={filteredHosts || []}
                    itemHeight={LIST_ROW_HEIGHT}
                    renderItem={(host) => (
                        <HostCard
                            host={host}
                            showGroup={showHostGroups}
                            viewMode="list"
                            onConnect={handleConnect}
                            onEdit={handleEdit}
                            onDelete={handleDeletePrompt}
                        />
                    )}
                    onRangeChange={setReportedRange}
                />
            )}
            {displayedViewMode === "tree" && (
                <div className="flex w-full flex-col gap-4">
                    {treeGroups.map(([groupName, groupHosts]) => (
                        <section key={groupName || "ungrouped"}>
                            <button
                                type="button"
                                aria-expanded={expandedTreeGroups.has(groupName)}
                                onClick={() => setExpandedTreeGroups((current) => {
                                    const next = new Set(current);
                                    if (next.has(groupName)) next.delete(groupName);
                                    else next.add(groupName);
                                    return next;
                                })}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left font-medium text-foreground hover:bg-muted/50"
                            >
                                {expandedTreeGroups.has(groupName)
                                    ? <ChevronDown className="size-4 text-muted-foreground"/>
                                    : <ChevronRight className="size-4 text-muted-foreground"/>}
                                <FolderTree className="size-4 text-muted-foreground"/>
                                <span>{groupName || t("ungrouped_group", {ns: "hosts"})}</span>
                                <span className="text-xs text-muted-foreground">{groupHosts.length}</span>
                            </button>
                            {expandedTreeGroups.has(groupName) && (
                                <div className="ml-4 border-l border-border pl-3">
                                    {/* A group can hold hundreds of hosts, so opening it has to stay as
                                        cheap as the flat list rather than mounting all of them. */}
                                    <VirtualizedList
                                        items={groupHosts}
                                        itemHeight={LIST_ROW_HEIGHT}
                                        renderItem={(host) => (
                                            <HostCard
                                                host={host}
                                                showGroup={false}
                                                viewMode="tree"
                                                onConnect={handleConnect}
                                                onEdit={handleEdit}
                                                onDelete={handleDeletePrompt}
                                            />
                                        )}
                                    />
                                </div>
                            )}
                        </section>
                    ))}
                </div>
            )}

            {displayedViewMode !== "tree" && matchedHostCount > 0 && (
                // The cards slice counts rows; each row carries cardColumns hosts, so the line
                // translates back to host numbers before it is shown.
                <p className="mb-3 text-xs text-muted-foreground">
                    {t("showing_range", {
                        ns: "hosts",
                        from: (displayedViewMode === "cards" ? visibleRange.from * cardColumns : visibleRange.from) + 1,
                        to: Math.min(
                            displayedViewMode === "cards" ? visibleRange.to * cardColumns : visibleRange.to,
                            matchedHostCount
                        ),
                        total: matchedHostCount,
                    })}
                </p>
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

            <QuickConnectModal
                isOpen={isQuickConnectOpen}
                onClose={() => setIsQuickConnectOpen(false)}
                onConnect={handleQuickConnect}
            />

            <DeleteHostDialog
                host={hostToDelete}
                hosts={hosts || []}
                onClose={() => setHostToDelete(null)}
                onConfirm={handleConfirmDelete}
            />
        </div>
    );
}
