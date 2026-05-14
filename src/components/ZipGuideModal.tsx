import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Archive, Info, ShieldAlert } from "lucide-react";

interface ZipGuideModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ZipGuideModal({ open, onOpenChange }: ZipGuideModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border-border bg-card text-foreground">
        <div className="space-y-6">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-white/10 p-2">
              <Archive className="h-5 w-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">
                Create Compatible ZIP Archives
              </h2>
              <p className="text-sm text-muted-foreground">
                SlasshyVault can index episodes directly inside ZIP archives.
                Store archives open fastest, while Deflate archives are
                extracted into a managed playback cache.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm font-medium text-white">7-Zip on Windows</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Select your episode files, right-click, choose{" "}
              <span className="text-white">7-Zip</span>, then{" "}
              <span className="text-white">Add to archive</span>. Set the
              compression method to <span className="text-white">Store</span>{" "}
              for fastest playback, or keep{" "}
              <span className="text-white">Deflate</span> if you prefer smaller
              archives and do not mind extraction on first play.
            </p>
          </div>

          <div className="grid gap-3">
            <div className="rounded-xl border border-white/10 p-4">
              <p className="text-sm font-medium text-white">
                Command line examples
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-black/30 p-3 text-xs text-muted-foreground">
                {`zip -0 "Show.S01.zip" "Show.S01E*.mkv"
7z a -m0=Copy "Show.S01.zip" "*.mkv"`}
              </pre>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 text-white" />
                <div>
                  <p className="text-sm font-medium text-white">
                    Avoid these options
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Encrypted, multipart, split, or password-protected ZIP
                    archives will be skipped because they cannot be played
                    safely.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-white/10 p-4">
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 text-white" />
                <p className="text-sm text-muted-foreground">
                  Larger Store ZIPs use more Google Drive space, but they start
                  fastest because SlasshyVault can stream them directly without
                  extracting the whole episode first.
                </p>
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
