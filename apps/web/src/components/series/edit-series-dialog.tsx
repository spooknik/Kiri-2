"use client";

import { useState } from "react";
import { Checkbox, Dialog, Label, Switch, useToast } from "@/components/ui";
import { useUpdateSeries } from "@/hooks/use-series";
import type { CreateSeriesInput, SeriesDetail } from "@/lib/contracts/series";
import { SeriesForm } from "./series-form";
import {
  createInputToUpdateInput,
  seriesDetailToFormValues,
  type SeriesFormValues,
} from "./series-form-utils";

export interface EditSeriesDialogProps {
  open: boolean;
  onClose: () => void;
  series: SeriesDetail;
}

/** Dialog wrapping `SeriesForm` in edit mode, plus book-club switch + remove-cover. */
export function EditSeriesDialog({ open, onClose, series }: EditSeriesDialogProps) {
  const [values, setValues] = useState<SeriesFormValues>(() => seriesDetailToFormValues(series));
  const [removeCover, setRemoveCover] = useState(false);
  const updateSeries = useUpdateSeries(series.id);
  const { toast } = useToast();

  // Re-sync from the latest series each time the dialog (re)opens. Adjusting
  // state during render (rather than in a useEffect) avoids the extra
  // synchronous-setState-in-effect render pass — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValues(seriesDetailToFormValues(series));
      setRemoveCover(false);
    }
  }

  function handleSubmit(input: CreateSeriesInput) {
    // `input.isBookClub` already respects the PRIVATE-exclusivity rule
    // (enforced in `formValuesToCreateInput`); no override needed here.
    const patch = createInputToUpdateInput(input, {
      removeCover: removeCover || undefined,
    });
    updateSeries.mutate(patch, {
      onSuccess: () => {
        toast({ title: "Series updated", tone: "success" });
        onClose();
      },
      onError: (error) => {
        toast({ title: "Couldn't save changes", description: error.message, tone: "danger" });
      },
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Edit series" className="max-w-lg">
      <SeriesForm
        values={values}
        onValuesChange={setValues}
        submitLabel="Save changes"
        submitting={updateSeries.isPending}
        onValidSubmit={handleSubmit}
      >
        <div className="flex items-center justify-between gap-3 rounded-md border border-card-border p-3">
          <div>
            <Label htmlFor="edit-book-club" className="block">
              Book club
            </Label>
            <p className="text-xs text-muted">
              {values.visibility === "PRIVATE"
                ? "Private series can't be book club series."
                : "Auto-enrolls every user in this series."}
            </p>
          </div>
          <Switch
            id="edit-book-club"
            checked={values.visibility === "PRIVATE" ? false : values.isBookClub}
            onCheckedChange={(isBookClub) => setValues({ ...values, isBookClub })}
            disabled={values.visibility === "PRIVATE"}
          />
        </div>

        {series.coverUrl ? (
          <Checkbox
            label="Remove current cover"
            checked={removeCover}
            onChange={(e) => setRemoveCover(e.target.checked)}
          />
        ) : null}
      </SeriesForm>
    </Dialog>
  );
}
