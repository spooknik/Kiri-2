import { AlertTriangle } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui";
import type { PluginCapability, PluginStatus } from "@/lib/contracts/plugins";

const STATUS_LABELS: Record<PluginStatus, string> = {
  ENABLED: "Enabled",
  DISABLED: "Disabled",
  BROKEN: "Broken",
};

const STATUS_TONE: Record<PluginStatus, BadgeTone> = {
  ENABLED: "success",
  DISABLED: "neutral",
  BROKEN: "danger",
};

export function PluginStatusBadge({ status }: { status: PluginStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>;
}

const CAPABILITY_LABELS: Record<PluginCapability, string> = {
  network: "Network",
  cookie: "Cookie",
  browser: "Browser",
  subprocess: "Subprocess",
};

/** Capabilities that run code with more server access than a plain HTTP fetch. */
const WARNING_CAPABILITIES = new Set<PluginCapability>(["browser", "subprocess"]);

export function PluginCapabilityBadge({ capability }: { capability: PluginCapability }) {
  const warning = WARNING_CAPABILITIES.has(capability);
  return (
    <Badge
      tone={warning ? "warning" : "neutral"}
      title={warning ? "Runs a browser / child processes on the server" : undefined}
      className={warning ? "gap-1" : undefined}
    >
      {warning ? <AlertTriangle className="h-3 w-3" aria-hidden="true" /> : null}
      {CAPABILITY_LABELS[capability]}
    </Badge>
  );
}

export function PluginAdultBadge() {
  return <Badge tone="danger">18+</Badge>;
}
