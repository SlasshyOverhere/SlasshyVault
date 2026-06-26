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
import { deleteCloudFilesByDriveIds } from "@/services/api";
import {
  listGDriveFolders,
  listGDriveFiles,
  DriveItem,
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
  children: FolderNode[];
  loaded: boolean;
  expanded: boolean;
}

// ==================== Component ====================

export function SelectiveDeleteModal({ open, onOpenChange }: SelectiveDeleteModalProps) {
  const { toast } = useToast();

  // Data
  const [folderTree, setFolderTree] = useState<FolderNode[]>([]);
  const [rootFiles, setRootFiles] = useState<DriveItem[]>([]);
  const [folderFiles, setFolderFiles] = useState<Map<string, DriveItem[]>>(new Map());
  const [loading, setLoading] = useState(true);

  // Navigation
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string | null; name: string }[]>([
    { id: null, name: "My Drive" },
  ]);

  // Selection: Drive file IDs + folder IDs
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  // Map folderId -> all descendant file IDs (cached after recursive fetch)
  const [folderFileCache, setFolderFileCache] = useState<Map<string, string[]>>(new Map());
  const [loadingFolder, setLoadingFolder] = useState<string | null>(null);
  // Delete confirmation
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  // ==================== Data Loading ====================

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [driveFolders, driveFiles] = await Promise.all([
        listGDriveFolders(),
        listGDriveFiles(),
      ]);

      console.log("[SelectiveDelete] Root folders:", driveFolders.length, driveFolders.map(f => f.name));
      console.log("[SelectiveDelete] Root files:", driveFiles.files?.length ?? 0, driveFiles.files?.map(f => f.name));

      const tree: FolderNode[] = driveFolders.map((f) => ({
        id: f.id,
        name: f.name,
        children: [],
        loaded: false,
        expanded: false,
      }));
      setFolderTree(tree);
      setRootFiles(driveFiles.files ?? []);
    } catch (error) {
      console.error("[SelectiveDelete] Failed to load data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadData();
      setSelectedFiles(new Set());
      setSelectedFolders(new Set());
      setFolderFileCache(new Map());
      setDeleteStep(0);
      setDeleteConfirmText("");
    }
  }, [open, loadData]);

  // ==================== Folder Tree ====================

  const loadSubfolders = useCallback(async (folderId: string) => {
    try {
      const [driveFolders, driveFiles] = await Promise.all([
        listGDriveFolders(folderId),
        listGDriveFiles(folderId),
      ]);
      const children: FolderNode[] = driveFolders.map((f) => ({
        id: f.id,
        name: f.name,
        children: [],
        loaded: false,
        expanded: false,
      }));

      setFolderTree((prev) => updateTreeNode(prev, folderId, { children, loaded: true }));
      setFolderFiles((prev) => {
        const next = new Map(prev);
        next.set(folderId, driveFiles.files ?? []);
        return next;
      });
    } catch (error) {
      console.error("[SelectiveDelete] Failed to load subfolders:", error);
    }
  }, []);

  const toggleExpand = useCallback(async (folderId: string) => {
    const node = findNode(folderTree, folderId);
    if (!node) return;

    if (!node.expanded && !node.loaded) {
      await loadSubfolders(folderId);
    }

    setFolderTree((prev) => updateTreeNode(prev, folderId, { expanded: !node.expanded }));
  }, [folderTree, loadSubfolders]);

  // ==================== Files in current view ====================

  const currentFiles = useMemo(() => {
    if (!currentFolderId) return rootFiles;
    return folderFiles.get(currentFolderId) ?? [];
  }, [currentFolderId, rootFiles, folderFiles]);

  // Show all non-folder, non-hidden files (not just videos)
  const videoFiles = useMemo(() => {
    return currentFiles.filter((f) => {
      const mt = f.mimeType?.toLowerCase() ?? "";
      // Exclude folders and Google Docs types
      return (
        mt !== "application/vnd.google-apps.folder" &&
        !mt.startsWith("application/vnd.google-apps.") &&
        !f.name?.startsWith(".")
      );
    });
  }, [currentFiles]);

  // ==================== Recursive file collection ====================

  const collectAllFileIds = useCallback(async (folderId: string): Promise<string[]> => {
    const ids: string[] = [];
    const queue = [folderId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      try {
        const [subFolders, files] = await Promise.all([
          listGDriveFolders(currentId),
          listGDriveFiles(currentId),
        ]);
        // Add all non-folder file IDs
        for (const f of files.files ?? []) {
          const mt = f.mimeType?.toLowerCase() ?? "";
          if (mt !== "application/vnd.google-apps.folder") {
            ids.push(f.id);
          }
        }
        // Queue subfolders for traversal
        for (const sub of subFolders) {
          queue.push(sub.id);
        }
      } catch (error) {
        console.error(`[SelectiveDelete] Failed to list folder ${currentId}:`, error);
      }
    }
    return ids;
  }, []);

  // ==================== Selection ====================

  const toggleFile = useCallback((fileId: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  }, []);

  const toggleAllCurrentFolder = useCallback(() => {
    const currentIds = videoFiles.map((f) => f.id);
    const allSelected = currentIds.every((id) => selectedFiles.has(id));

    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        currentIds.forEach((id) => next.delete(id));
      } else {
        currentIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }, [videoFiles, selectedFiles]);

  const toggleFolder = useCallback(async (folderId: string) => {
    const isSelected = selectedFolders.has(folderId);

    if (isSelected) {
      // Deselect folder: remove its cached file IDs from selectedFiles
      const cachedIds = folderFileCache.get(folderId) ?? [];
      setSelectedFiles((prev) => {
        const next = new Set(prev);
        cachedIds.forEach((id) => next.delete(id));
        return next;
      });
      setSelectedFolders((prev) => {
        const next = new Set(prev);
        next.delete(folderId);
        return next;
      });
    } else {
      // Select folder: recursively collect all file IDs
      setLoadingFolder(folderId);
      try {
        const ids = await collectAllFileIds(folderId);
        setFolderFileCache((prev) => {
          const next = new Map(prev);
          next.set(folderId, ids);
          return next;
        });
        setSelectedFiles((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.add(id));
          return next;
        });
        setSelectedFolders((prev) => {
          const next = new Set(prev);
          next.add(folderId);
          return next;
        });
      } catch (error) {
        console.error("[SelectiveDelete] Failed to collect folder files:", error);
      } finally {
        setLoadingFolder(null);
      }
    }
  }, [selectedFolders, folderFileCache, collectAllFileIds]);

  // ==================== Delete ====================

  const handleDelete = useCallback(async () => {
    if (selectedFiles.size === 0 && selectedFolders.size === 0) return;
    // Combine file IDs + folder IDs for deletion
    const allIds = [...selectedFiles, ...selectedFolders];
    setDeleting(true);
    try {
      const result = await deleteCloudFilesByDriveIds(allIds);
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
  }, [selectedFiles, selectedFolders, toast, onOpenChange]);

  // ==================== Navigation ====================

  const navigateToFolder = useCallback(
    (folderId: string | null) => {
      setCurrentFolderId(folderId);
      if (folderId === null) {
        setBreadcrumbs([{ id: null, name: "My Drive" }]);
      } else {
        const path = findPathToNode(folderTree, folderId);
        setBreadcrumbs([{ id: null, name: "My Drive" }, ...path]);
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

  const allCurrentSelected = videoFiles.length > 0 && videoFiles.every((f) => selectedFiles.has(f.id));
  const someCurrentSelected = videoFiles.some((f) => selectedFiles.has(f.id));

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
                Browse Google Drive and choose files to permanently delete
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
          ) : (
            <div className="space-y-1">
              {/* Folders */}
              {currentChildren.map((child) => (
                <div
                  key={child.id}
                  className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent/50"
                >
                  <Checkbox
                    checked={selectedFolders.has(child.id)}
                    disabled={loadingFolder === child.id}
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
                  </button>
                  {loadingFolder === child.id && (
                    <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => navigateToFolder(child.id)}
                  >
                    Open
                  </Button>
                </div>
              ))}

              {/* Video files */}
              {videoFiles.length > 0 && (
                <>
                  {currentChildren.length > 0 && <div className="border-t my-2" />}
                  {/* Select all row */}
                  <div className="flex items-center gap-3 p-2 rounded-lg bg-muted/30 mb-1">
                    <Checkbox
                      checked={allCurrentSelected}
                      // @ts-ignore
                      indeterminate={someCurrentSelected && !allCurrentSelected}
                      onCheckedChange={toggleAllCurrentFolder}
                    />
                    <span className="text-sm font-medium text-muted-foreground">
                      Select all ({videoFiles.length} video{videoFiles.length !== 1 ? "s" : ""})
                    </span>
                  </div>
                  {videoFiles.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent/50"
                    >
                      <Checkbox
                        checked={selectedFiles.has(file.id)}
                        onCheckedChange={() => toggleFile(file.id)}
                      />
                      <FileVideo className="size-5 text-purple-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{file.name}</p>
                        {file.size && (
                          <p className="text-xs text-muted-foreground">
                            {formatFileSize(Number(file.size))}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}

              {/* Empty state */}
              {currentChildren.length === 0 && videoFiles.length === 0 && (
                <p className="text-center text-muted-foreground py-8">
                  No video files in this folder.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer: Summary + Delete */}
        <div className="border-t p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {selectedFolders.size > 0 && (
                <>{selectedFolders.size} folder{selectedFolders.size !== 1 ? "s" : ""} + </>
              )}
              {selectedFiles.size} file{selectedFiles.size !== 1 ? "s" : ""} selected for permanent deletion
            </span>
          </div>

          {deleteStep === 0 && (
            <Button
              variant="destructive"
              className="w-full"
              disabled={selectedFiles.size === 0 && selectedFolders.size === 0}
              onClick={() => setDeleteStep(1)}
            >
              <Trash2 className="mr-2 size-4" />
              Delete {selectedFolders.size > 0 && <>{selectedFolders.size} Folder{selectedFolders.size !== 1 ? "s" : ""} + </>}{selectedFiles.size} File{selectedFiles.size !== 1 ? "s" : ""}
            </Button>
          )}

          {deleteStep === 1 && (
            <div className="space-y-3 p-4 rounded-lg bg-destructive/10 border border-destructive/30">
              <p className="text-sm font-bold text-destructive text-center">
                ⚠️ WARNING: PERMANENT DELETION
              </p>
              <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                <li>
                  <strong>{selectedFiles.size}</strong> file{selectedFiles.size !== 1 ? "s" : ""} will be <strong>permanently deleted</strong> from Google Drive
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
                <strong>{selectedFiles.size}</strong> file{selectedFiles.size !== 1 ? "s" : ""} from Google Drive.
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

// ==================== Helpers ====================

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

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
