"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Button, Checkbox, Field, Input, Select, Textarea } from "@/components/ui";
import { useResolveUrl } from "@/hooks/use-plugins";
import type { ResolveUrlResponse } from "@/lib/contracts/plugins";
import {
  MEDIA_TYPES,
  MEDIA_TYPE_LABELS,
  READING_STATUSES,
  READING_STATUS_LABELS,
  VISIBILITIES,
  createSeriesSchema,
  type CreateSeriesInput,
} from "@/lib/contracts/series";
import { ExistingSeriesCard } from "./existing-series-card";
import { TagInput } from "./tag-input";
import { formValuesToCreateInput, type SeriesFormValues } from "./series-form-utils";

export type SeriesFormFieldErrors = Partial<Record<string, string>>;

export interface SeriesFormProps {
  values: SeriesFormValues;
  onValuesChange: (values: SeriesFormValues) => void;
  /** Show the "initial status" + "current chapter" fields (create flow only). */
  showInitialProgress?: boolean;
  submitLabel: string;
  submitting?: boolean;
  onValidSubmit: (input: CreateSeriesInput) => void;
  /** Non-field error shown above the submit button (e.g. a 500 from the API). */
  formError?: string | null;
  /** Extra fields rendered after the built-in ones (e.g. book-club switch, remove cover). */
  children?: ReactNode;
  className?: string;
}

/**
 * Shared metadata form for add-series (both tabs) and edit-series. Owns its
 * own client-side validation (`createSeriesSchema.safeParse`) so both call
 * sites get identical field errors; callers only ever see the converted,
 * already-valid `CreateSeriesInput` via `onValidSubmit`.
 */
export function SeriesForm({
  values,
  onValuesChange,
  showInitialProgress = false,
  submitLabel,
  submitting = false,
  onValidSubmit,
  formError,
  children,
  className,
}: SeriesFormProps) {
  const formId = useId();
  const router = useRouter();
  const [errors, setErrors] = useState<SeriesFormFieldErrors>({});
  const resolveUrl = useResolveUrl();
  const [sourceUrlResolved, setSourceUrlResolved] = useState<ResolveUrlResponse | null>(null);

  function set<K extends keyof SeriesFormValues>(key: K, value: SeriesFormValues[K]) {
    onValuesChange({ ...values, [key]: value });
  }

  /**
   * On blur, checks which installed plugin (if any) would handle this
   * series URL and shows a "Recognised by <plugin>" hint. When the form is
   * still blank (no title typed yet — the signal that nothing here would be
   * clobbered), prefills title/mediaType/cover from the resolve response.
   */
  function handleSourceUrlBlur() {
    const trimmed = values.sourceUrl.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setSourceUrlResolved(null);
      return;
    }
    resolveUrl.mutate(
      { url: trimmed },
      {
        onSuccess: (data) => {
          setSourceUrlResolved(data);
          if (data.handled && !values.title.trim()) {
            onValuesChange({
              ...values,
              title: data.title ?? values.title,
              mediaType: data.mediaType ?? values.mediaType,
              coverUrl: data.coverUrl ?? values.coverUrl,
            });
          }
        },
        onError: () => setSourceUrlResolved(null),
      },
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = formValuesToCreateInput(values);
    const result = createSeriesSchema.safeParse(candidate);
    if (!result.success) {
      const nextErrors: SeriesFormFieldErrors = {};
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!nextErrors[key]) nextErrors[key] = issue.message;
      }
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    onValidSubmit(result.data);
  }

  return (
    <form onSubmit={handleSubmit} className={className} noValidate>
      <div className="flex flex-col gap-4">
        <Field label="Title" htmlFor={`${formId}-title`} required error={errors.title}>
          <Input
            value={values.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="e.g. Solo Leveling"
          />
        </Field>

        <Field
          label="Original title"
          htmlFor={`${formId}-original-title`}
          error={errors.originalTitle}
        >
          <Input
            value={values.originalTitle}
            onChange={(e) => set("originalTitle", e.target.value)}
            placeholder="Optional original-language title"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Type" htmlFor={`${formId}-media-type`} error={errors.mediaType}>
            <Select
              value={values.mediaType}
              onChange={(e) => set("mediaType", e.target.value as SeriesFormValues["mediaType"])}
            >
              {MEDIA_TYPES.map((type) => (
                <option key={type} value={type}>
                  {MEDIA_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Publication year" htmlFor={`${formId}-year`} error={errors.publicationYear}>
            <Input
              type="number"
              inputMode="numeric"
              value={values.publicationYear}
              onChange={(e) => set("publicationYear", e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Total chapters"
            htmlFor={`${formId}-total-chapters`}
            error={errors.totalChapters}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              value={values.totalChapters}
              onChange={(e) => set("totalChapters", e.target.value)}
              placeholder="Optional"
            />
          </Field>
          <Field
            label="Total volumes"
            htmlFor={`${formId}-total-volumes`}
            error={errors.totalVolumes}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              value={values.totalVolumes}
              onChange={(e) => set("totalVolumes", e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </div>

        <Field
          label="Tags"
          htmlFor={`${formId}-tags`}
          help="Press comma or Enter to add a tag."
          error={errors.tags}
        >
          <TagInput value={values.tags} onChange={(tags) => set("tags", tags)} />
        </Field>

        <Field label="Synopsis" htmlFor={`${formId}-synopsis`} error={errors.synopsis}>
          <Textarea
            rows={4}
            value={values.synopsis}
            onChange={(e) => set("synopsis", e.target.value)}
            placeholder="Brief description of the series…"
          />
        </Field>

        <Field
          label="Source URL"
          htmlFor={`${formId}-source-url`}
          help="Where to read it."
          error={errors.sourceUrl}
        >
          <Input
            type="url"
            value={values.sourceUrl}
            onChange={(e) => {
              set("sourceUrl", e.target.value);
              setSourceUrlResolved(null);
            }}
            onBlur={handleSourceUrlBlur}
            placeholder="https://…"
          />
        </Field>

        {resolveUrl.isPending ? (
          <p className="-mt-2 text-xs text-muted">Checking…</p>
        ) : sourceUrlResolved?.handled ? (
          <p className="-mt-2 flex items-center gap-1.5 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Recognised by {sourceUrlResolved.pluginName}
          </p>
        ) : sourceUrlResolved && !sourceUrlResolved.handled ? (
          <p className="-mt-2 flex items-center gap-1.5 text-xs text-muted">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            No installed plugin recognises this site.
          </p>
        ) : null}

        {sourceUrlResolved?.existingSeriesId ? (
          // Reusing the same card the MAL-conflict flow (`(app)/add/page.tsx`)
          // shows on a 409. This form doesn't own a create/track mutation
          // (it's shared by add + edit), so both actions just open the
          // existing series.
          <ExistingSeriesCard
            onTrack={() => router.push(`/series/${sourceUrlResolved.existingSeriesId}`)}
            onOpen={() => router.push(`/series/${sourceUrlResolved.existingSeriesId}`)}
          />
        ) : null}

        <Field
          label="Cover URL"
          htmlFor={`${formId}-cover-url`}
          help="We'll fetch and store this locally."
          error={errors.coverUrl}
        >
          <Input
            type="url"
            value={values.coverUrl}
            onChange={(e) => set("coverUrl", e.target.value)}
            placeholder="https://…"
          />
        </Field>
        {values.coverUrl.trim() ? (
          <div className="h-40 w-28 overflow-hidden rounded-md border border-card-border bg-surface-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary user-pasted remote URL, unoptimized */}
            <img
              src={values.coverUrl}
              alt=""
              className="h-full w-full object-cover"
              onError={(e) => {
                e.currentTarget.style.visibility = "hidden";
              }}
            />
          </div>
        ) : null}

        <Field
          label="Visibility"
          htmlFor={`${formId}-visibility`}
          error={errors.visibility}
          help={
            values.visibility === "PRIVATE"
              ? "Only you can see private series; they can't be book club series."
              : "Visible to everyone on this Kiri instance."
          }
        >
          <Select
            value={values.visibility}
            onChange={(e) => set("visibility", e.target.value as SeriesFormValues["visibility"])}
          >
            {VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {v === "SHARED" ? "Shared" : "Private"}
              </option>
            ))}
          </Select>
        </Field>

        <Checkbox
          label="18+ / adult content"
          checked={values.isAdult}
          onChange={(e) => set("isAdult", e.target.checked)}
        />

        {showInitialProgress ? (
          <div className="grid grid-cols-2 gap-3 border-t border-card-border pt-4">
            <Field label="Your status" htmlFor={`${formId}-status`}>
              <Select
                value={values.status}
                onChange={(e) => set("status", e.target.value as SeriesFormValues["status"])}
              >
                {READING_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {READING_STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Current chapter"
              htmlFor={`${formId}-current-chapter`}
              error={errors.currentChapter}
            >
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                value={values.currentChapter}
                onChange={(e) => set("currentChapter", e.target.value)}
              />
            </Field>
          </div>
        ) : null}

        {children}

        {formError ? (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        ) : null}

        <Button type="submit" size="lg" loading={submitting} disabled={submitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
