"use client";

import { useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { Badge, Button, Card, useToast } from "@/components/ui";
import { ConfirmDialog } from "@/components/series/confirm-dialog";
import { useUninstallPlugin, useUpdatePlugin } from "@/hooks/use-plugins";
import type { PluginView } from "@/lib/contracts/plugins";
import { formatRelativeTime } from "@/lib/format";
import { PluginAdultBadge, PluginCapabilityBadge, PluginStatusBadge } from "./plugin-badges";

export interface PluginCardProps {
  plugin: PluginView;
}

/** One installed plugin: identity/status/capability badges, hosts, source count, actions. */
export function PluginCard({ plugin }: PluginCardProps) {
  const updatePlugin = useUpdatePlugin();
  const uninstallPlugin = useUninstallPlugin();
  const { toast } = useToast();
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const toggling = updatePlugin.isPending && updatePlugin.variables?.id === plugin.id;
  const uninstalling = uninstallPlugin.isPending && uninstallPlugin.variables === plugin.id;

  function handleToggle() {
    const nextStatus = plugin.status === "ENABLED" ? "DISABLED" : "ENABLED";
    updatePlugin.mutate(
      { id: plugin.id, input: { status: nextStatus } },
      {
        onError: (error) =>
          toast({ title: "Couldn't update plugin", description: error.message, tone: "danger" }),
      },
    );
  }

  function handleUninstall() {
    uninstallPlugin.mutate(plugin.id, {
      onSuccess: () => {
        toast({ title: "Plugin uninstalled", tone: "success" });
        setConfirmUninstall(false);
      },
      onError: (error) => {
        toast({ title: "Couldn't uninstall plugin", description: error.message, tone: "danger" });
        setConfirmUninstall(false);
      },
    });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{plugin.name}</h3>
            <PluginStatusBadge status={plugin.status} />
            {plugin.adult ? <PluginAdultBadge /> : null}
          </div>
          <p className="text-xs text-muted">
            {plugin.id} · v{plugin.version}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleToggle}
            loading={toggling}
          >
            {plugin.status === "ENABLED" ? "Disable" : "Enable"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-danger"
            onClick={() => setConfirmUninstall(true)}
          >
            Uninstall
          </Button>
        </div>
      </div>

      {plugin.capabilities.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {plugin.capabilities.map((capability) => (
            <PluginCapabilityBadge key={capability} capability={capability} />
          ))}
        </div>
      ) : null}

      {plugin.hosts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {plugin.hosts.map((host) => (
            <Badge key={host} tone="neutral">
              {host}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>{plugin.sourceCount} series</span>
        <span>Installed {formatRelativeTime(plugin.installedAt)}</span>
        <span>Updated {formatRelativeTime(plugin.updatedAt)}</span>
        {plugin.hasCredential ? <span>Has extension credential</span> : null}
        {plugin.homepage ? (
          <a
            href={plugin.homepage}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Homepage <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      {plugin.lastError ? (
        <p className="flex items-start gap-1.5 rounded-md bg-danger-light px-2 py-1.5 text-xs text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {plugin.lastError}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmUninstall}
        onClose={() => setConfirmUninstall(false)}
        onConfirm={handleUninstall}
        title={`Uninstall ${plugin.name}?`}
        description={
          plugin.sourceCount > 0
            ? `${plugin.sourceCount} series will need this plugin installed again to sync.`
            : "No series currently use this plugin."
        }
        confirmLabel="Uninstall"
        loading={uninstalling}
      />
    </Card>
  );
}
