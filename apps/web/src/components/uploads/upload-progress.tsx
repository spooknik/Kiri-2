import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";

export interface UploadProgressItem {
  name: string;
  sentBytes: number;
  totalBytes: number;
  status: "pending" | "uploading" | "done" | "error";
}

export interface UploadProgressProps {
  items: UploadProgressItem[];
  className?: string;
}

/** Per-file upload progress bars, shared by `UploadChapterDialog` and `ImportPdfDialog`. */
export function UploadProgress({ items, className }: UploadProgressProps) {
  if (items.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {items.map((item) => {
        const percent =
          item.totalBytes > 0
            ? Math.min(100, Math.round((item.sentBytes / item.totalBytes) * 100))
            : 0;
        return (
          <div key={item.name} className="flex flex-col gap-1 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-foreground">{item.name}</span>
              <span className="shrink-0 text-muted">
                {item.status === "done"
                  ? "Done"
                  : item.status === "error"
                    ? "Failed"
                    : `${formatBytes(item.sentBytes)} / ${formatBytes(item.totalBytes)}`}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  item.status === "error" ? "bg-danger" : "bg-primary",
                )}
                style={{ width: `${item.status === "done" ? 100 : percent}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
