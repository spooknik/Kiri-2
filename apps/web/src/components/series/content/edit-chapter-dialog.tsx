"use client";

import { useId, useState, type FormEvent } from "react";
import { Button, Dialog, Field, Input, useToast } from "@/components/ui";
import { useUpdateChapter } from "@/hooks/use-chapters";
import { updateChapterSchema, type ChapterListItem } from "@/lib/contracts/content";

export interface EditChapterDialogProps {
  open: boolean;
  onClose: () => void;
  seriesId: string;
  chapter: ChapterListItem;
}

type FormValues = { title: string; number: string; volume: string };
type FormErrors = Partial<Record<string, string>>;

function chapterToFormValues(chapter: ChapterListItem): FormValues {
  return {
    title: chapter.title,
    number: chapter.number === null ? "" : String(chapter.number),
    volume: chapter.volume ?? "",
  };
}

/** Edit a chapter's title/number/volume → PATCH /api/chapters/:id. */
export function EditChapterDialog({ open, onClose, seriesId, chapter }: EditChapterDialogProps) {
  const [values, setValues] = useState<FormValues>(() => chapterToFormValues(chapter));
  const [errors, setErrors] = useState<FormErrors>({});
  const updateChapter = useUpdateChapter(seriesId);
  // One dialog is mounted per chapter row, so the field ids must be unique.
  const ids = useId();
  const { toast } = useToast();

  // Re-sync from the latest chapter each time the dialog (re)opens — same
  // pattern as EditSeriesDialog (adjust state during render, not an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValues(chapterToFormValues(chapter));
      setErrors({});
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = {
      title: values.title.trim(),
      number: values.number.trim() === "" ? null : Number(values.number),
      volume: values.volume.trim() === "" ? null : values.volume.trim(),
    };
    const result = updateChapterSchema.safeParse(candidate);
    if (!result.success) {
      const nextErrors: FormErrors = {};
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!nextErrors[key]) nextErrors[key] = issue.message;
      }
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    updateChapter.mutate(
      { chapterId: chapter.id, input: result.data },
      {
        onSuccess: () => {
          toast({ title: "Chapter updated", tone: "success" });
          onClose();
        },
        onError: (error) => {
          toast({ title: "Couldn't save changes", description: error.message, tone: "danger" });
        },
      },
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Edit chapter" className="max-w-md">
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Field label="Title" htmlFor={`${ids}-title`} required error={errors.title}>
          <Input
            value={values.title}
            onChange={(e) => setValues({ ...values, title: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Number" htmlFor={`${ids}-number`} error={errors.number}>
            <Input
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              value={values.number}
              onChange={(e) => setValues({ ...values, number: e.target.value })}
              placeholder="Optional"
            />
          </Field>
          <Field label="Volume" htmlFor={`${ids}-volume`} error={errors.volume}>
            <Input
              value={values.volume}
              onChange={(e) => setValues({ ...values, volume: e.target.value })}
              placeholder="Optional"
            />
          </Field>
        </div>
        <Button type="submit" loading={updateChapter.isPending}>
          Save changes
        </Button>
      </form>
    </Dialog>
  );
}
