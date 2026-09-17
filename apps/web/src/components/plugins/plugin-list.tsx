"use client";

import { PackageX } from "lucide-react";
import { EmptyState, Spinner } from "@/components/ui";
import { usePlugins } from "@/hooks/use-plugins";
import { PluginCard } from "./plugin-card";

/** Installed-plugins list for `/admin/plugins`: loading/error/empty states + one `PluginCard` per plugin. */
export function PluginList() {
  const { data, isPending, isError, error } = usePlugins();

  if (isPending) {
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading plugins" />
      </div>
    );
  }

  if (isError) {
    return <EmptyState icon={PackageX} title="Couldn't load plugins" description={error.message} />;
  }

  if (data.length === 0) {
    return (
      <EmptyState
        icon={PackageX}
        title="No plugins installed"
        description="Kiri ships with no content sources. Install a plugin below to let series sync from a site — see docs/PLUGINS.md for how plugins work and where to find them."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {data.map((plugin) => (
        <PluginCard key={plugin.id} plugin={plugin} />
      ))}
    </div>
  );
}
