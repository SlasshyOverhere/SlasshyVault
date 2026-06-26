import { useState, useEffect, useCallback, useMemo } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FolderOpen,
  FileVideo,
  ChevronRight,
  ChevronDown,
  Trash2,
  Loader2,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { getLibraryFiltered, deleteMediaFiles, MediaItem } from "@/services/api";
import {
  getCloudFolders,
  listGDriveFolders,
  CloudFolder,
} from "@/services/gdrive";
import { useToast } from "@/components/ui/use-toast";

interface SelectiveDeleteModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ==================== Types ====================

interface FolderNode {
  id: string;
  name: string;
  driveId: string;
  children: FolderNode[];
  loaded: boolean;
  expanded: boolean;
}

interface SelectionState {
  // folderId -> set of excluded media IDs (everything else in folder is selected)
  folderExclusions: Map<string, Set<number>>;
  // Which folders are explicitly unchecked (no children selected)
  uncheckedFolders: Set<string>;
}

// ==================== Component ====================

export function SelectiveDeleteModal({ open, onOpenChange }: SelectiveDeleteModalProps) {
  const { toast } = useToast();

  // Data
  const [trackedFolders, setTrackedFolders] = useState<CloudFolder[]>([]);
  const [folderTree, setFolderTree] = useState<FolderNode[]>([]);
  const [allCloudMedia, setAllCloudMedia] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Navigation
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string | null; name: string }[]>([
    { id: null, name: "All Folders" },
  ]);

  // Selection
  const [selection, setSelection] = useState<SelectionState>({
    folderExclusions: new Map(),
    uncheckedFolders: new Set(),
  });

  // Delete confirmation
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  // ==================== Data Loading ====================

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [folders, movies, tv] = await Promise.all([
        getCloudFolders(),
        getLibraryFiltered("movie", "", true),
        getLibraryFiltered("tv", "", true),
      ]);
      setTrackedFolders(folders);
      setAllCloudMedia([...movies, ...tv]);

      // Build initial tree from tracked folders
      const tree: FolderNode[] = folders.map((f) => ({
        id: f.id,
        name: f.name,
        driveId: f.id,
        children: [],
        loaded: false,
        expanded: false,
      }));
      setFolderTree(tree);
    } catch (error) {
      console.error("[SelectiveDelete] Failed to load data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadData();
  }, [open, loadData]);

  // ==================== Folder Tree ====================

  const loadSubfolders = useCallback(
    async (folderId: string) => {
      try {
        const driveFolders = await listGDriveFolders(folderId);
        const children: FolderNode[] = driveFolders.map((f) => ({
          id: f.id,
          name: f.name,
          driveId: f.id,
          children: [],
          loaded: false,
          expanded: false,
        }));

        setFolderTree((prev) => updateTreeNode(prev, folderId, { children, loaded: true }));
      } catch (error) {
        console.error("[SelectiveDelete] Failed to load subfolders:", error);
      }
    },
    [],
  );

  const toggleExpand = useCallback(
    async (folderId: string) => {
      const node = findNode(folderTree, folderId);
      if (!node) return;

      if (!node.expanded && !node.loaded) {
        await loadSubfolders(folderId);
      }

      setFolderTree((prev) => updateTreeNode(prev, folderId, { expanded: !node.expanded }));
    },
    [folderTree, loadSubfolders],
  );

  // ==================== Media by Folder ====================

  // Group media by cloud_folder_id
  const mediaByFolder = useMemo(() => {
    const map = new Map<string, MediaItem[]>();
    for (const item of allCloudMedia) {
      const fid = item.cloud_folder_id;
      if (!fid) continue;
      if (!map.has(fid)) map.set(fid, []);
      map.get(fid)!.push(item);
    }
    return map;
  }, [allCloudMedia]);

  // Get media items for the currently viewed folder
  const currentFolderMedia = useMemo(() => {
    if (!currentFolderId) {
      // Show all folders at top level
      return [];
    }
    // Find the tracked folder this folder belongs to
    const trackedId = findTrackedFolderId(folderTree, currentFolderId, trackedFolders);
    if (!trackedId) return [];
    return mediaByFolder.get(trackedId) ?? [];
  }, [currentFolderId, folderTree, trackedFolders, mediaByFolder]);

  // Get all descendant folder IDs for a folder
  const getDescendantFolderIds = useCallback(
    (folderId: string): string[] => {
      const node = findNode(folderTree, folderId);
      if (!node) return [folderId];
      const ids = [folderId];
      for (const child of node.children) {
        ids.push(...getDescendantFolderIds(child.id));
      }
      return ids;
    },
    [folderTree],
  );

  // ==================== Selection Logic ====================

  const isFolderSelected = useCallback(
    (folderId: string): boolean => {
      return !selection.uncheckedFolders.has(folderId);
    },
    [selection],
  );

  const isFolderIndeterminate = useCallback(
    (folderId: string): boolean => {
      const exclusions = selection.folderExclusions.get(folderId);
      return !!exclusions && exclusions.size > 0;
    },
    [selection],
  );

  const isMediaSelected = useCallback(
    (mediaId: number, folderId: string): boolean => {
      if (selection.uncheckedFolders.has(folderId)) return false;
      const exclusions = selection.folderExclusions.get(folderId);
      return !exclusions || !exclusions.has(mediaId);
    },
    [selection],
  );

  const toggleFolder = useCallback(
    (folderId: string) => {
      setSelection((prev) => {
        const next = { ...prev, folderExclusions: new Map(prev.folderExclusions), uncheckedFolders: new Set(prev.uncheckedFolders) };
        if (next.uncheckedFolders.has(folderId)) {
          // Was unchecked -> check it
          next.uncheckedFolders.delete(folderId);
          next.folderExclusions.delete(folderId);
        } else {
          // Was checked -> uncheck it
          next.uncheckedFolders.add(folderId);
          next.folderExclusions.delete(folderId);
        }
        return next;
      });
    },
    [],
  );

  const toggleMedia = useCallback(
    (mediaId: number, folderId: string) => {
      setSelection((prev) => {
        const next = { ...prev, folderExclusions: new Map(prev.folderExclusions), uncheckedFolders: new Set(prev.uncheckedFolders) };
        const exclusions = new Set(next.folderExclusions.get(folderId) ?? []);

        if (exclusions.has(mediaId)) {
          exclusions.delete(mediaId);
        } else {
          exclusions.add(mediaId);
        }

        if (exclusions.size === 0) {
          next.folderExclusions.delete(folderId);
        } else {
          next.folderExclusions.set(folderId, exclusions);
        }

        // Ensure folder is not in unchecked
        next.uncheckedFolders.delete(folderId);

        return next;
      });
    },
    [],
  );

  // ==================== Selected Count ====================

  const selectedMediaIds = useMemo(() => {
    const ids = new Set<number>();
    for (const [trackedId, mediaList] of mediaByFolder) {
      if (selection.uncheckedFolders.has(trackedId)) continue;
      const exclusions = selection.folderExclusions.get(trackedId);
      for (const item of mediaList) {
        if (!exclusions || !exclusions.has(item.id)) {
          ids.add(item.id);
        }
      }
    }
    return ids;
  }, [mediaByFolder, selection]);

  // ==================== Delete ====================

  const handleDelete = useCallback(async () => {
    if (selectedMediaIds.size === 0) return;
    setDeleting(true);
    try {
      const result = await deleteMediaFiles(Array.from(selectedMediaIds));
      setDeleteStep(0);
      setDeleteConfirmText("");
      toast({
        title: "Deletion Complete",
        description: result.message,
      });
      onOpenChange(false);
    } catch (error) {
      console.error("[SelectiveDelete] Failed:", error);
      toast({
        title: "Error",
        description: "Failed to delete selected files",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  }, [selectedMediaIds, toast, onOpenChange]);

  // ==================== Navigation ====================

  const navigateToFolder = useCallback(
    (folderId: string | null) => {
      setCurrentFolderId(folderId);
      if (folderId === null) {
        setBreadcrumbs([{ id: null, name: "All Folders" }]);
      } else {
        // Build breadcrumbs by walking up the tree
        const path = findPathToNode(folderTree, folderId);
        setBreadcrumbs([{ id: null, name: "All Folders" }, ...path]);
      }
    },
    [folderTree],
  );

  // ==================== Render ====================

  const currentChildren = useMemo(() => {
    if (!currentFolderId) return folderTree;
    const node = findNode(folderTree, currentFolderId);
    return node?.children ?? [];
  }, [currentFolderId, folderTree]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-destructive/20">
              <Trash2 className="size-5 text-destructive" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Selective Delete</h2>
              <p className="text-sm text-muted-foreground">
                Choose files to permanently delete from Google Drive
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
            <X className="size-4" />
          </Button>
        </div>

        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 px-4 py-2 text-sm text-muted-foreground border-b bg-muted/30">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.id ?? "root"} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3" />}
              <button
                className="hover:text-foreground transition-colors"
                onClick={() => navigateToFolder(crumb.id)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0 p-2">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : currentFolderId === null ? (
            // Top-level: show tracked folders
            <div className="space-y-1">
              {folderTree.map((folder) => {
                const mediaCount = (mediaByFolder.get(folder.id) ?? []).length;
                return (
                  <div
                    key={folder.id}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent/50 group"
                  >
                    <Checkbox
                      checked={isFolderSelected(folder.id)}
                      // @ts-ignore - indeterminate prop
                      indeterminate={isFolderIndeterminate(folder.id)}
                      onCheckedChange={() => toggleFolder(folder.id)}
                    />
                    <button
                      className="flex items-center gap-2 flex-1 text-left"
                      onClick={() => navigateToFolder(folder.id)}
                    >
                      <FolderOpen className="size-5 text-blue-400 shrink-0" />
                      <span className="font-medium truncate">{folder.name}</span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {mediaCount} item{mediaCount !== 1 ? "s" : ""}
                      </span>
                      <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                    </button>
                  </div>
                );
              })}
              {folderTree.length === 0 && (
                <p className="text-center text-muted-foreground py-8">
                  No cloud folders tracked. Add a Google Drive folder first.
                </p>
              )}
            </div>
          ) : (
            // Inside a folder: show subfolders + media files
            <div className="space-y-1">
              {/* Subfolders */}
              {currentChildren.map((child) => {
                const childMediaCount = (mediaByFolder.get(child.id) ?? []).length;
                return (
                  <div
                    key={child.id}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent/50"
                  >
                    <Checkbox
                      checked={isFolderSelected(child.id)}
                      // @ts-ignore - indeterminate prop
                      indeterminate={isFolderIndeterminate(child.id)}
                      onCheckedChange={() => toggleFolder(child.id)}
                    />
                    <button
                      className="flex items-center gap-2 flex-1 text-left"
                      onClick={() => toggleExpand(child.id)}
                    >
                      {child.expanded ? (
                        <ChevronDown className="size-4 shrink-0" />
                      ) : (
                        <ChevronRight className="size-4 shrink-0" />
                      )}
                      <FolderOpen className="size-5 text-blue-400 shrink-0" />
                      <span className="font-medium truncate">{child.name}</span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {childMediaCount} item{childMediaCount !== 1 ? "s" : ""}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={() => navigateToFolder(child.id)}
                    >
                      Open
                    </Button>
                  </div>
                );
              })}

              {/* Media files in this folder */}
              {currentFolderMedia.length > 0 && (
                <>
                  {currentChildren.length > 0 && (
                    <div className="border-t my-2" />
                  )}
                  {currentFolderMedia.map((item) => {
                    const trackedId = item.cloud_folder_id ?? currentFolderId;
                    return (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent/50"
                      >
                        <Checkbox
                          checked={isMediaSelected(item.id, trackedId)}
                          onCheckedChange={() => toggleMedia(item.id, trackedId)}
                        />
                        <FileVideo className="size-5 text-purple-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{item.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {item.media_type === "movie" ? "Movie" : "TV Show"}
                            {item.year ? ` · ${item.year}` : ""}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}

              {currentChildren.length === 0 && currentFolderMedia.length === 0 && (
                <p className="text-center text-muted-foreground py-8">
                  This folder is empty.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer: Summary + Delete */}
        <div className="border-t p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {selectedMediaIds.size} file{selectedMediaIds.size !== 1 ? "s" : ""} selected for permanent deletion
            </span>
          </div>

          {deleteStep === 0 && (
            <Button
              variant="destructive"
              className="w-full"
              disabled={selectedMediaIds.size === 0}
              onClick={() => setDeleteStep(1)}
            >
              <Trash2 className="mr-2 size-4" />
              Delete {selectedMediaIds.size} Selected File{selectedMediaIds.size !== 1 ? "s" : ""}
            </Button>
          )}

          {deleteStep === 1 && (
            <div className="space-y-3 p-4 rounded-lg bg-destructive/10 border border-destructive/30">
              <p className="text-sm font-bold text-destructive text-center">
                ⚠️ WARNING: PERMANENT DELETION
              </p>
              <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                <li>
                  <strong>{selectedMediaIds.size}</strong> file{selectedMediaIds.size !== 1 ? "s" : ""} will be <strong>permanently deleted</strong> from Google Drive
                </li>
                <li>Files will <strong>NOT</strong> go to Trash — they will be gone forever</li>
                <li>Media entries will also be removed from your SlasshyVault library</li>
                <li>This action is <strong>irreversible</strong></li>
              </ul>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setDeleteStep(0)} className="flex-1">
                  Cancel
                </Button>
                <Button variant="destructive" onClick={() => setDeleteStep(2)} className="flex-1">
                  I Understand, Continue
                </Button>
              </div>
            </div>
          )}

          {deleteStep === 2 && (
            <div className="space-y-3 p-4 rounded-lg bg-destructive/10 border border-destructive/30">
              <p className="text-sm font-bold text-destructive text-center">
                FINAL CONFIRMATION
              </p>
              <p className="text-sm text-muted-foreground text-center">
                Type <strong>DELETE</strong> below to permanently erase{" "}
                <strong>{selectedMediaIds.size}</strong> file{selectedMediaIds.size !== 1 ? "s" : ""} from Google Drive.
              </p>
              <Input
                placeholder='Type "DELETE" to confirm'
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                className="text-center font-mono"
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setDeleteStep(0);
                    setDeleteConfirmText("");
                  }}
                  className="flex-1"
                  disabled={deleting}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  className="flex-1"
                  disabled={deleting || deleteConfirmText !== "DELETE"}
                >
                  {deleting ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    "Permanently Delete"
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==================== Tree Helpers ====================

function updateTreeNode(
  tree: FolderNode[],
  targetId: string,
  updates: Partial<FolderNode>,
): FolderNode[] {
  return tree.map((node) => {
    if (node.id === targetId) return { ...node, ...updates };
    if (node.children.length > 0) {
      return { ...node, children: updateTreeNode(node.children, targetId, updates) };
    }
    return node;
  });
}

function findNode(tree: FolderNode[], targetId: string): FolderNode | null {
  for (const node of tree) {
    if (node.id === targetId) return node;
    const found = findNode(node.children, targetId);
    if (found) return found;
  }
  return null;
}

function findPathToNode(
  tree: FolderNode[],
  targetId: string,
  path: { id: string; name: string }[] = [],
): { id: string; name: string }[] {
  for (const node of tree) {
    if (node.id === targetId) return [...path, { id: node.id, name: node.name }];
    const found = findPathToNode(node.children, targetId, [
      ...path,
      { id: node.id, name: node.name },
    ]);
    if (found.length > 0) return found;
  }
  return [];
}

function findTrackedFolderId(
  tree: FolderNode[],
  folderId: string,
  trackedFolders: CloudFolder[],
): string | null {
  // If this folder is a tracked folder, return it
  if (trackedFolders.some((f) => f.id === folderId)) return folderId;
  // Walk up the tree to find the tracked ancestor
  for (const tracked of trackedFolders) {
    if (isDescendant(tree, tracked.id, folderId)) return tracked.id;
  }
  return null;
}

function isDescendant(tree: FolderNode[], ancestorId: string, targetId: string): boolean {
  const ancestor = findNode(tree, ancestorId);
  if (!ancestor) return false;
  return !!findNode(ancestor.children, targetId) || ancestorId === targetId;
}
