"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui";
import { ExtensionTokenCard } from "@/components/plugins/extension-token-card";
import { InstallPluginDialog } from "@/components/plugins/install-plugin-dialog";
import { PluginList } from "@/components/plugins/plugin-list";

export default function AdminPluginsPage() {
  const [installOpen, setInstallOpen] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Plugins</h2>
          <p className="text-sm text-muted">
            Content-source plugins let series sync chapters from a site. Kiri ships with none —
            install the ones you need.
          </p>
        </div>
        <Button type="button" onClick={() => setInstallOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" /> Install plugin
        </Button>
      </div>

      <PluginList />

      <ExtensionTokenCard />

      <InstallPluginDialog open={installOpen} onClose={() => setInstallOpen(false)} />
    </div>
  );
}
