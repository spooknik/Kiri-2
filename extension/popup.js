const statusEl = document.getElementById("status");
const hostsListEl = document.getElementById("hostsList");
const currentHostEl = document.getElementById("currentHost");
const captureCurrentBtn = document.getElementById("captureCurrent");

function originsFor(host) {
  return [`*://${host}/*`, `*://*.${host}/*`];
}

function formatLastCapture(entry) {
  if (!entry) return "never";
  const seconds = Math.round((Date.now() - entry.at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Must run from a direct user gesture (a button's click handler) —
// chrome.permissions.request() rejects a call that isn't.
async function grantHost(host) {
  return chrome.permissions.request({ origins: originsFor(host) });
}

async function getCurrentTabHostname() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    return tab?.url ? new URL(tab.url).hostname : "";
  } catch {
    return "";
  }
}

async function render() {
  const status = await chrome.runtime.sendMessage({ type: "kiri-status" });
  hostsListEl.innerHTML = "";

  if (!status || !status.instanceUrl) {
    statusEl.textContent = "Not configured — open Options to set your Kiri instance and token.";
    statusEl.className = "status err";
  } else if (status.hosts.length === 0) {
    statusEl.textContent = `Connected to ${status.instanceUrl}. No plugins need cookies yet.`;
    statusEl.className = "status ok";
  } else {
    statusEl.textContent = `Connected to ${status.instanceUrl}. ${status.hosts.length} site(s) registered.`;
    statusEl.className = "status ok";
  }

  if (!status?.hosts?.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Install a plugin on your Kiri instance to see sites here.";
    hostsListEl.appendChild(empty);
    return;
  }

  const granted = new Set(status.granted ?? []);
  for (const entry of status.hosts) {
    const isGranted = granted.has(entry.host);

    const row = document.createElement("div");
    row.className = "host-row";

    const top = document.createElement("div");
    top.className = "host-top";
    const dot = document.createElement("span");
    dot.className = `dot${isGranted ? "" : " off"}`;
    const label = document.createElement("span");
    label.className = "host-label";
    label.textContent = entry.host;
    top.append(dot, label);

    const meta = document.createElement("span");
    meta.className = "host-meta";
    meta.textContent = isGranted
      ? `${entry.pluginName} · last capture: ${formatLastCapture(status.lastCapture?.[entry.host])}`
      : `${entry.pluginName} · not granted`;

    const action = document.createElement("button");
    action.className = "small" + (isGranted ? " secondary" : "");
    action.textContent = isGranted ? "Capture now" : "Grant";
    action.addEventListener("click", async () => {
      action.disabled = true;
      if (isGranted) {
        const result = await chrome.runtime.sendMessage({
          type: "kiri-capture",
          host: entry.host,
          force: true,
        });
        if (!result?.ok && result?.reason !== "throttled") {
          statusEl.textContent = `Capture for ${entry.host} failed: ${result?.reason || "unknown"}.`;
          statusEl.className = "status err";
        }
      } else {
        const grantedNow = await grantHost(entry.host);
        if (grantedNow) {
          await chrome.runtime.sendMessage({ type: "kiri-capture", host: entry.host, force: true });
        }
      }
      await render();
    });

    row.append(top, meta, action);
    hostsListEl.appendChild(row);
  }
}

async function initCurrentTab() {
  const hostname = await getCurrentTabHostname();
  currentHostEl.textContent = hostname || "(no page)";
  captureCurrentBtn.disabled = !hostname;
  captureCurrentBtn.addEventListener("click", async () => {
    captureCurrentBtn.disabled = true;
    const grantedNow = await grantHost(hostname);
    if (grantedNow) {
      await chrome.runtime.sendMessage({ type: "kiri-capture", host: hostname, force: true });
    }
    captureCurrentBtn.disabled = false;
    await render();
  });
}

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

void initCurrentTab();
void render();
