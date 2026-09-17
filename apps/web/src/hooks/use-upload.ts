"use client";

/**
 * React wrapper around `src/components/uploads/upload-client.ts`'s
 * `uploadFile`. Deliberately not a TanStack Query mutation — upload dialogs
 * need raw byte-progress callbacks and per-file control (sequential
 * multi-file uploads, cancel mid-flight), not query caching.
 */
import { useCallback, useRef } from "react";
import { uploadFile, type UploadProgress } from "@/components/uploads/upload-client";
import type { UploadSessionView } from "@/lib/contracts/content";

export interface UseUploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  /** Combined with the hook's own internal controller — aborting either cancels the upload. */
  signal?: AbortSignal;
}

export interface UseUpload {
  upload: (file: File, options?: UseUploadOptions) => Promise<UploadSessionView>;
  /** Aborts the most recent in-flight `upload()` call, if any. */
  cancel: () => void;
}

export function useUpload(): UseUpload {
  const controllerRef = useRef<AbortController | null>(null);

  const upload = useCallback(async (file: File, options: UseUploadOptions = {}) => {
    const controller = new AbortController();
    controllerRef.current = controller;

    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort);

    try {
      return await uploadFile(file, { onProgress: options.onProgress, signal: controller.signal });
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort);
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { upload, cancel };
}
