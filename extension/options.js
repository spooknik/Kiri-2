const instanceUrlInput = document.getElementById("instanceUrl");
const tokenInput = document.getElementById("token");
const statusEl = document.getElementById("status");
const hostsListEl = document.getElementById("hostsList");

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

function normalizeInstanceUrl(raw) {
  const value = (raw || "").trim().replace(/\/+$/, "");
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

// Ask for runtime host permission for the Kiri origin so the service worker
// can fetch it without being blocked by CORS. Must run from a user gesture
// (this function is only ever called from the save/test button handlers).
async function ensureInstanceHostPermission(instanceUrl) {
  const origin = `${new URL(instanceUrl).origin}/*`;
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) {
    return true;
  }
  return chrome.permissions.request({ origins: [origin] });
}

async function renderHosts() {
  const status = await chrome.runtime.sendMessage({ type: "kiri-status" });
  hostsListEl.innerHTML = "";
  if (!status || status.hosts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "None yet — save an instance URL and token, then Test connection.";
    hostsListEl.appendChild(empty);
    return;
  }
  const granted = new Set(status.granted);
  for (const entry of status.hosts) {
    const row = document.createElement("div");
    row.className = "host-row";
    const label = document.createElement("span");
    label.textContent = `${entry.host} (${entry.pluginName})`;
    const state = document.createElement("span");
    state.textContent = granted.has(entry.host) ? "Granted" : "Not granted — use the popup";
    state.style.color = granted.has(entry.host) ? "var(--success)" : "var(--muted)";
    row.append(label, state);
    hostsListEl.appendChild(row);
  }
}

async function load() {
  const { instanceUrl, token } = await chrome.storage.local.get(["instanceUrl", "token"]);
  instanceUrlInput.value = instanceUrl || "";
  tokenInput.value = token || "";
  await renderHosts();
}

async function save() {
  const instanceUrl = normalizeInstanceUrl(instanceUrlInput.value);
  if (!instanceUrl) {
    setStatus("Enter a valid http(s) URL.", "err");
    return;
  }

  const granted = await ensureInstanceHostPermission(instanceUrl);
  if (!granted) {
    setStatus(
      "Permission for that host was denied — the bridge can't reach Kiri without it.",
      "err",
    );
    return;
  }

  await chrome.storage.local.set({ instanceUrl, token: tokenInput.value.trim() });
  setStatus("Saved.", "ok");
  const result = await chrome.runtime.sendMessage({ type: "kiri-refresh" });
  if (result?.ok) {
    await renderHosts();
  }
}

async function test() {
  const instanceUrl = normalizeInstanceUrl(instanceUrlInput.value);
  if (!instanceUrl) {
    setStatus("Enter a valid http(s) URL first.", "err");
    return;
  }

  const granted = await ensureInstanceHostPermission(instanceUrl);
  if (!granted) {
    setStatus("Permission for that host was denied.", "err");
    return;
  }

  const headers = {};
  const token = tokenInput.value.trim();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  setStatus("Testing…");
  try {
    const response = await fetch(`${instanceUrl}/api/plugins/hosts`, { headers });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      const count = Array.isArray(data.hosts) ? data.hosts.length : 0;
      setStatus(`Connected. ${count} host(s) registered by installed plugins.`, "ok");
      await chrome.storage.local.set({ instanceUrl, token });
      const result = await chrome.runtime.sendMessage({ type: "kiri-refresh" });
      if (result?.ok) {
        await renderHosts();
      }
    } else if (response.status === 401) {
      setStatus("Reached Kiri, but the token was rejected (401).", "err");
    } else {
      setStatus(`Reached Kiri, but got HTTP ${response.status}.`, "err");
    }
  } catch (error) {
    setStatus(`Could not reach Kiri: ${error.message}`, "err");
  }
}

document.getElementById("save").addEventListener("click", () => void save());
document.getElementById("test").addEventListener("click", () => void test());
void load();
