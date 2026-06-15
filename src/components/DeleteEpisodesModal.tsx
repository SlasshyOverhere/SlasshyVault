import { useState, useEffect, useMemo } from "react";
import { Trash2, Check, X, AlertTriangle, Loader2, FolderX } from "lucide-react";
import { LazyMotion, domAnimation, m, AnimatePresence } from "framer-motion";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EpisodeDeleteInfo, getEpisodesForDelete, deleteMediaFiles, deleteSeriesCloudFolder } from "@/services/api";

import { formatFileSize } from "@/utils/format";

interface DeleteEpisodesModalProps {
    isOpen: boolean;
    onClose: () => void;
    seriesId: number;
    seriesTitle: string;
    onDeleteComplete: (message?: string) => void;
}

export function DeleteEpisodesModal({
    isOpen,
    onClose,
    seriesId,
    seriesTitle,
    onDeleteComplete,
}: DeleteEpisodesModalProps) {
    const [episodes, setEpisodes] = useState<EpisodeDeleteInfo[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [isLoading, setIsLoading] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isDeletingFolder, setIsDeletingFolder] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const allZipArchiveTargets = useMemo(
        () => episodes.length > 0 && episodes.every((ep) => ep.delete_kind === "zip_archive"),
        [episodes]
    );

    const allDdlTargets = useMemo(
        () => episodes.length > 0 && episodes.every((ep) => ep.delete_kind === "ddl_source"),
        [episodes]
    );

    const hasZipArchiveTargets = useMemo(
        () => episodes.some((ep) => ep.delete_kind === "zip_archive"),
        [episodes]
    );

    const hasDdlTargets = useMemo(
        () => episodes.some((ep) => ep.delete_kind === "ddl_source"),
        [episodes]
    );

    const selectedZipArchiveCount = useMemo(
        () => episodes.filter((ep) => selectedIds.has(ep.id) && ep.delete_kind === "zip_archive").length,
        [episodes, selectedIds]
    );

    const selectedDdlCount = useMemo(
        () => episodes.filter((ep) => selectedIds.has(ep.id) && ep.delete_kind === "ddl_source").length,
        [episodes, selectedIds]
    );

    const selectedEpisodeCount = selectedIds.size - selectedZipArchiveCount - selectedDdlCount;

    // Load episodes when modal opens
    useEffect(() => {
        if (!isOpen || !seriesId) return;

        let cancelled = false;
        setIsLoading(true);
        setError(null);

        getEpisodesForDelete(seriesId)
            .then((eps) => {
                if (cancelled) return;
                setEpisodes(eps);
                setSelectedIds(new Set());
            })
            .catch((err) => {
                if (cancelled) return;
                setError("Failed to load episodes");
                console.error(err);
            })
            .finally(() => {
                if (cancelled) return;
                setIsLoading(false);
            });

        return () => { cancelled = true; };
    }, [isOpen, seriesId]);

    const toggleEpisode = (id: number) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const selectAll = () => {
        setSelectedIds(new Set(episodes.map((ep) => ep.id)));
    };

    const deselectAll = () => {
        setSelectedIds(new Set());
    };

    const handleDelete = async () => {
        if (selectedIds.size === 0) return;

        setIsDeleting(true);
        setError(null);

        try {
            const idsToDelete = Array.from(selectedIds);
            const result = await deleteMediaFiles(idsToDelete);

            if (result.success) {
                onDeleteComplete(result.message);
                onClose();
            } else {
                setError(result.message);
            }
        } catch (err) {
            setError("Failed to delete files");
            console.error(err);
        } finally {
            setIsDeleting(false);
        }
    };

    const handleDeleteFolder = async () => {
        setIsDeletingFolder(true);
        setError(null);

        try {
            await deleteSeriesCloudFolder(seriesId);
            onDeleteComplete(`Series folder for "${seriesTitle}" was removed.`);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to delete cloud folder");
            console.error(err);
        } finally {
            setIsDeletingFolder(false);
        }
    };

    // Group episodes by season
    const episodesBySeason = useMemo(() => {
        return episodes.reduce((acc, ep) => {
            const season = ep.season_number ?? 0;
            if (!acc[season]) {
                acc[season] = [];
            }
            acc[season].push(ep);
            return acc;
        }, {} as Record<number, EpisodeDeleteInfo[]>);
    }, [episodes]);

    const sortedSeasons = useMemo(() => {
        return Object.keys(episodesBySeason)
            .map(Number)
            .sort((a, b) => a - b);
    }, [episodesBySeason]);

    // Pre-sort episodes within each season to avoid sorting on every render
    const sortedEpisodesBySeason = useMemo(() => {
        const sorted = { ...episodesBySeason };
        Object.keys(sorted).forEach(seasonStr => {
            const season = Number(seasonStr);
            sorted[season] = sorted[season].toSorted((a, b) => (a.episode_number ?? 0) - (b.episode_number ?? 0));
        });
        return sorted;
    }, [episodesBySeason]);

    return (
        <LazyMotion features={domAnimation}>
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-2xl bg-background/95 backdrop-blur-xl border-white/10 flex h-[min(90vh,720px)] flex-col p-0 gap-0">
                <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
                    <DialogTitle className="flex items-center gap-2 text-xl">
                        <Trash2 className="size-5 text-red-500" />
                        {allZipArchiveTargets ? "Delete ZIP Archives" : allDdlTargets ? "Delete Direct-Link Items" : hasZipArchiveTargets || hasDdlTargets ? "Delete Items" : "Delete Episodes"} - {seriesTitle}
                    </DialogTitle>
                    <DialogDescription className="text-muted-foreground">
                        {hasDdlTargets ? (
                            <span className="flex items-center gap-2 text-amber-500">
                                <AlertTriangle className="size-4" />
                                Direct-link items are indexed from remote archives. Deleting removes them from your library (no cloud file to delete).
                            </span>
                        ) : hasZipArchiveTargets ? (
                            <span className="flex items-center gap-2 text-amber-500">
                                <AlertTriangle className="size-4" />
                                ZIP-backed episodes are indexed from archive files. Deleting a ZIP item removes the archive from Google Drive and all indexed episodes from it.
                            </span>
                        ) : (
                            <span className="flex items-center gap-2 text-amber-500">
                                <AlertTriangle className="size-4" />
                                Warning: Files will be permanently deleted from your drive and cannot be recovered!
                            </span>
                        )}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex items-center justify-between gap-3 border-y border-white/10 px-6 py-3 shrink-0">
                    <span className="text-sm text-muted-foreground">
                        {selectedIds.size} of {episodes.length} selected
                    </span>
                    <div className="flex flex-wrap justify-end gap-2">
                        {episodes.length > 0 && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={selectAll}
                                className="border-red-500/50 hover:bg-red-500/20 hover:text-red-400"
                            >
                                <Check className="size-4 mr-1" />
                                Select All
                            </Button>
                        )}
                        {episodes.length === 0 && !isLoading && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleDeleteFolder}
                                disabled={isDeletingFolder || isDeleting}
                                className="border-orange-500/50 hover:bg-orange-500/20 hover:text-orange-400"
                                title="Delete the cloud folder from Google Drive (use if folder wasn't deleted automatically)"
                            >
                                {isDeletingFolder ? (
                                    <Loader2 className="size-4 mr-1 animate-spin" />
                                ) : (
                                    <FolderX className="size-4 mr-1" />
                                )}
                                Delete Folder
                            </Button>
                        )}
                        {episodes.length > 0 && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={deselectAll}
                                className="border-white/20 hover:bg-white/10"
                            >
                                <X className="size-4 mr-1" />
                                Clear
                            </Button>
                        )}
                    </div>
                </div>

                <div className="flex-1 min-h-0 overflow-hidden px-6 py-4">
                    <ScrollArea className="h-full min-h-0 pr-4">
                        {isLoading ? (
                            <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3">
                                <Loader2 className="size-8 animate-spin text-white" />
                                <span className="text-sm text-muted-foreground">Loading episodes…</span>
                            </div>
                        ) : error && episodes.length === 0 ? (
                            <div className="flex h-full min-h-[240px] flex-col items-center justify-center text-center">
                                <AlertTriangle className="size-12 text-red-500 mb-2" />
                                <p className="text-red-400">{error}</p>
                            </div>
                        ) : episodes.length === 0 ? (
                            <div className="flex h-full min-h-[240px] items-center justify-center text-muted-foreground">
                                No episodes found for this series.
                            </div>
                        ) : hasZipArchiveTargets || hasDdlTargets ? (
                            <div className="space-y-3">
                                <AnimatePresence>
                                    {episodes.map((ep) => (
                                        <m.div
                                            key={ep.id}
                                            initial={{ opacity: 0, x: -10 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, x: 10 }}
                                            className={`flex items-center gap-3 rounded-lg border p-4 transition-all cursor-pointer ${
                                                selectedIds.has(ep.id)
                                                    ? "border-red-500/50 bg-red-500/10"
                                                    : "border-white/10 hover:border-white/20 hover:bg-white/5"
                                            }`}
                                            onClick={() => toggleEpisode(ep.id)}
                                        >
                                            <Checkbox
                                                checked={selectedIds.has(ep.id)}
                                                onClick={(event) => event.stopPropagation()}
                                                onCheckedChange={() => toggleEpisode(ep.id)}
                                                className={selectedIds.has(ep.id) ? "border-red-500 data-[state=checked]:bg-red-500" : ""}
                                            />
                                            <div className="flex-1 min-w-0">
                                                <div className="font-medium break-words">{ep.title}</div>
                                                {ep.delete_kind === "zip_archive" ? (
                                                    <>
                                                        <div className="mt-1 text-xs uppercase tracking-[0.14em] text-amber-400/90">
                                                            ZIP Archive
                                                            {ep.archive_episode_count ? ` · ${ep.archive_episode_count} indexed episode${ep.archive_episode_count !== 1 ? "s" : ""}` : ""}
                                                            {ep.file_size_bytes != null ? ` · ${formatFileSize(ep.file_size_bytes)}` : ""}
                                                        </div>
                                                        <div className="mt-1 break-all text-xs text-muted-foreground">
                                                            {ep.file_path || "Deletes the archive file from Google Drive."}
                                                        </div>
                                                    </>
                                                ) : ep.delete_kind === "ddl_source" ? (
                                                    <>
                                                        <div className="mt-1 text-xs uppercase tracking-[0.14em] text-sky-400/90">
                                                            Direct Link
                                                        </div>
                                                        <div className="mt-1 break-all text-xs text-muted-foreground">
                                                            {ep.file_path || "Direct-link item (no cloud file)"}
                                                        </div>
                                                    </>
                                                ) : (
                                                    <>
                                                        <div className="mt-1 text-xs uppercase tracking-[0.14em] text-white/60">
                                                            Season {ep.season_number ?? 0} · Episode {ep.episode_number ?? 0}
                                                            {ep.file_size_bytes != null ? ` · ${formatFileSize(ep.file_size_bytes)}` : ""}
                                                        </div>
                                                        <div className="mt-1 break-all text-xs text-muted-foreground">
                                                            {ep.file_path || "No file path"}
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                            {selectedIds.has(ep.id) && (
                                                <m.div
                                                    initial={{ scale: 0.95 }}
                                                    animate={{ scale: 1 }}
                                                    className="text-red-500"
                                                >
                                                    <Trash2 className="size-4" />
                                                </m.div>
                                            )}
                                        </m.div>
                                    ))}
                                </AnimatePresence>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {sortedSeasons.map((season) => (
                                    <div key={season} className="space-y-2">
                                        <h3 className="sticky top-0 bg-background/90 py-1 text-sm font-semibold text-white/80 backdrop-blur-sm">
                                            Season {season}
                                        </h3>
                                        <AnimatePresence>
                                            {sortedEpisodesBySeason[season].map((ep) => (
                                                <m.div
                                                    key={ep.id}
                                                    initial={{ opacity: 0, x: -10 }}
                                                    animate={{ opacity: 1, x: 0 }}
                                                    exit={{ opacity: 0, x: 10 }}
                                                    className={`flex items-center gap-3 rounded-lg border p-3 transition-all cursor-pointer ${
                                                        selectedIds.has(ep.id)
                                                            ? "border-red-500/50 bg-red-500/10"
                                                            : "border-white/10 hover:border-white/20 hover:bg-white/5"
                                                    }`}
                                                    onClick={() => toggleEpisode(ep.id)}
                                                >
                                                    <Checkbox
                                                        checked={selectedIds.has(ep.id)}
                                                        onClick={(event) => event.stopPropagation()}
                                                        onCheckedChange={() => toggleEpisode(ep.id)}
                                                        className={selectedIds.has(ep.id) ? "border-red-500 data-[state=checked]:bg-red-500" : ""}
                                                    />
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-medium break-words">
                                                            E{String(ep.episode_number ?? 0).padStart(2, "0")} - {ep.episode_title || ep.title}
                                                        </div>
                                                        <div className="break-all text-xs text-muted-foreground">
                                                            {ep.file_path || "No file path"}
                                                            {ep.file_size_bytes != null && (
                                                                <span> · {formatFileSize(ep.file_size_bytes)}</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    {selectedIds.has(ep.id) && (
                                                        <m.div
                                                            initial={{ scale: 0.95 }}
                                                            animate={{ scale: 1 }}
                                                            className="text-red-500"
                                                        >
                                                            <Trash2 className="size-4" />
                                                        </m.div>
                                                    )}
                                                </m.div>
                                            ))}
                                        </AnimatePresence>
                                    </div>
                                ))}
                            </div>
                        )}
                    </ScrollArea>
                </div>

                {error && episodes.length > 0 && (
                    <div className="flex shrink-0 items-center gap-2 px-6 pb-3 text-sm text-red-400">
                        <AlertTriangle className="size-4" />
                        {error}
                    </div>
                )}

                <DialogFooter className="shrink-0 gap-2 border-t border-white/10 px-6 py-4">
                    <Button
                        variant="outline"
                        onClick={onClose}
                        disabled={isDeleting}
                        className="border-white/20"
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={handleDelete}
                        disabled={selectedIds.size === 0 || isDeleting}
                        className="bg-red-600 hover:bg-red-700"
                    >
                        {isDeleting ? (
                            <>
                                <Loader2 className="size-4 mr-2 animate-spin" />
                                Deleting…
                            </>
                        ) : (
                            <>
                                <Trash2 className="size-4 mr-2" />
                                {allDdlTargets
                                    ? `Delete ${selectedIds.size} Direct-Link Item${selectedIds.size !== 1 ? "s" : ""}`
                                    : allZipArchiveTargets
                                        ? `Delete ${selectedIds.size} ZIP Archive${selectedIds.size !== 1 ? "s" : ""}`
                                        : selectedZipArchiveCount > 0 && selectedDdlCount > 0
                                            ? `Delete ${selectedIds.size} Selected Item${selectedIds.size !== 1 ? "s" : ""}`
                                            : selectedZipArchiveCount > 0 && selectedEpisodeCount > 0
                                                ? `Delete ${selectedIds.size} Selected Item${selectedIds.size !== 1 ? "s" : ""}`
                                                : selectedDdlCount > 0 && selectedEpisodeCount > 0
                                                    ? `Delete ${selectedIds.size} Selected Item${selectedIds.size !== 1 ? "s" : ""}`
                                                    : selectedZipArchiveCount > 0
                                                        ? `Delete ${selectedZipArchiveCount} ZIP Archive${selectedZipArchiveCount !== 1 ? "s" : ""}`
                                                        : selectedDdlCount > 0
                                                            ? `Delete ${selectedDdlCount} Direct-Link Item${selectedDdlCount !== 1 ? "s" : ""}`
                                                            : `Delete ${selectedEpisodeCount} Episode${selectedEpisodeCount !== 1 ? "s" : ""}`}
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
        </LazyMotion>
    );
}
