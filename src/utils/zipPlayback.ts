import { getMpvStatus, type MediaItem } from "@/services/api";
import { formatFileSize } from "@/utils/format";

export interface ZipPlaybackLoadingState {
  title: string;
  resume: boolean;
  estimatedSeconds: number;
  sizeLabel: string;
  detail: string;
}

const estimateZipStartupSeconds = (
  item: MediaItem,
  resume: boolean,
) => {
  const bytes = item.zip_uncompressed_size || item.zip_compressed_size || 0;
  const sizeGb = bytes > 0 ? bytes / 1024 ** 3 : 0;

  if (item.zip_compression_method === 8) {
    return Math.max(
      resume ? 18 : 12,
      Math.min(120, Math.round(10 + sizeGb * 8 + (resume ? 5 : 0))),
    );
  }

  const isMkv =
    item.zip_entry_path?.toLowerCase().endsWith(".mkv") ||
    item.file_path?.toLowerCase().endsWith(".mkv");

  return Math.max(
    resume ? 10 : 7,
    Math.min(
      45,
      Math.round(
        5 + sizeGb * (isMkv ? 2.8 : 2.2) + (resume ? 3 : 0) + (isMkv ? 1 : 0),
      ),
    ),
  );
};

export const buildZipPlaybackLoadingState = (
  item: MediaItem,
  resume: boolean,
): ZipPlaybackLoadingState => {
  const estimatedSeconds = estimateZipStartupSeconds(item, resume);
  const sizeLabel = formatFileSize(
    item.zip_uncompressed_size || item.zip_compressed_size,
  );
  const detail =
    item.zip_compression_method === 8
      ? "ZIP-contained episodes can take longer than expected to start because the video is being extracted and prepared in the backend before playback opens."
      : "ZIP-contained episodes can take a bit longer to start because the archive is being prepared in the backend before MPV opens.";
  const seasonEpisodeLabel =
    typeof item.season_number === "number" &&
    typeof item.episode_number === "number"
      ? `S${String(item.season_number).padStart(2, "0")}E${String(
          item.episode_number,
        ).padStart(2, "0")}`
      : null;
  const title = seasonEpisodeLabel
    ? `${item.title} • ${seasonEpisodeLabel}`
    : item.title;

  return {
    title,
    resume,
    estimatedSeconds,
    sizeLabel,
    detail,
  };
};

export const waitForZipLoadingOverlayPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

export const waitForMinimumZipOverlayVisibility = async (
  visibleSinceMs: number,
  minimumMs = 900,
) => {
  const elapsed = Date.now() - visibleSinceMs;
  if (elapsed < minimumMs) {
    await delay(minimumMs - elapsed);
  }
};

export const waitForMpvPlaybackStart = async (
  mediaId: number,
  timeoutMs = 45000,
) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = await getMpvStatus(mediaId);
    const hasLoadedMedia =
      !!status.is_playing &&
      typeof status.duration === "number" &&
      status.duration > 0;

    if (hasLoadedMedia) {
      return true;
    }

    await delay(350);
  }

  return false;
};
