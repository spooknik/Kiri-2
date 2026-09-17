// Service worker. Owns:
//   - fetching the host list this Kiri instance's installed plugins care
//     about (GET /api/plugins/hosts, bearer token from options)
//   - capturing + POSTing cookies for hosts the user has granted permission
//     for (chrome.permissions — always requested from a direct user gesture
//     in the popup or options page; this file only ever *checks* grants,
//     never requests them, since request() requires that gesture)
//   - reacting to cookie changes, navigation, a daily alarm, and manual
//     "capture now" messages from the popup
import { buildCookieHeader, cfClearanceValue, matchKnownHost } from "./cookies.js";

const ALARM_NAME = "kiri-refresh-hosts";
const ALARM_PERIOD_MINUTES = 24 * 60;
// Debounce: a granted host's cookies can change many times in a short
// window (page loads, redirects); don't re-POST more than once per host in
// this window unless cf_clearance itself changed (the value that actually
// matters to a plugin sync) or the caller forces it (popup "Capture now").
const CAPTURE_THROTTLE_MS = 10 * 60 * 1000;

async function getSettings() {
  const { instanceUrl, token } = await chrome.storage.local.get(["instanceUrl", "token"]);
  return { instanceUrl: instanceUrl || "", token: token || "" };
}

function authHeaders(token) {
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

function originsFor(host) {
  return [`*://${host}/*`, `*://*.${host}/*`];
}

async function isHostGranted(host) {
  return chrome.permissions.contains({ origins: originsFor(host) });
}

/** Every host from the server's list the user currently has permission for. */
async function grantedHostsOf(hosts) {
  const granted = [];
  for (const entry of hosts) {
    if (await isHostGranted(entry.host)) {
      granted.push(entry.host);
    }
  }
  return granted;
}

/** GET /api/plugins/hosts — refreshes the cached host list. */
async function fetchHosts() {
  const { instanceUrl, token } = await getSettings();
  if (!instanceUrl) {
    return { ok: false, reason: "no-instance-url" };
  }
  try {
    const response = await fetch(`${instanceUrl.replace(/\/+$/, "")}/api/plugins/hosts`, {
      headers: authHeaders(token),
    });
    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}` };
    }
    const data = await response.json();
    const hosts = Array.isArray(data.hosts) ? data.hosts : [];
    await chrome.storage.local.set({ hosts, hostsUpdatedAt: Date.now() });
    return { ok: true, hosts };
  } catch (error) {
    return { ok: false, reason: error?.message || "network-error" };
  }
}

/** Reads+POSTs cookies for one host. Throttled unless `force` or cf_clearance changed. */
async function capture(host, { force = false } = {}) {
  if (!host) {
    return { ok: false, reason: "no-host" };
  }
  const { instanceUrl, token } = await getSettings();
  if (!instanceUrl) {
    return { ok: false, reason: "no-instance-url" };
  }

  const cookies = await chrome.cookies.getAll({ domain: host });
  if (cookies.length === 0) {
    return { ok: false, reason: "no-cookies", host };
  }

  const { lastCapture = {} } = await chrome.storage.local.get(["lastCapture"]);
  const previous = lastCapture[host];
  const currentClearance = cfClearanceValue(cookies);
  if (!force && previous) {
    const isFresh = Date.now() - previous.at < CAPTURE_THROTTLE_MS;
    const isUnchanged = previous.cfClearance === currentClearance;
    if (isFresh && isUnchanged) {
      return { ok: true, reason: "throttled", host };
    }
  }

  const cookie = buildCookieHeader(cookies);
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";

  try {
    const response = await fetch(`${instanceUrl.replace(/\/+$/, "")}/api/plugins/credentials`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ host, cookie, userAgent }),
    });
    if (!response.ok) {
      console.warn(`[Kiri] credential ingest failed for ${host}: HTTP ${response.status}`);
      return { ok: false, reason: `http-${response.status}`, host };
    }
    lastCapture[host] = { at: Date.now(), cfClearance: currentClearance };
    await chrome.storage.local.set({ lastCapture });
    return { ok: true, host, count: cookies.length };
  } catch (error) {
    console.warn(`[Kiri] credential ingest error for ${host}: ${error.message}`);
    return { ok: false, reason: error?.message || "network-error", host };
  }
}

/** Refreshes the host list, then captures for every host already granted. */
async function refreshAndCaptureGranted() {
  const result = await fetchHosts();
  if (!result.ok) return result;
  const granted = await grantedHostsOf(result.hosts);
  const results = [];
  for (const host of granted) {
    results.push(await capture(host));
  }
  return { ok: true, hosts: result.hosts, granted, results };
}

async function captureForMatchedHost(hostname) {
  const { hosts = [] } = await chrome.storage.local.get(["hosts"]);
  const knownHosts = hosts.map((entry) => entry.host);
  const matched = matchKnownHost(hostname, knownHosts);
  if (!matched) return;
  if (await isHostGranted(matched)) {
    void capture(matched);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  void refreshAndCaptureGranted();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshAndCaptureGranted();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void refreshAndCaptureGranted();
  }
});

// A cookie for a granted host changed (new value, or a fresh cf_clearance
// after solving a challenge) — capture() itself decides whether this is
// worth a re-send (throttled unless cf_clearance changed).
chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo.removed) return;
  void captureForMatchedHost(changeInfo.cookie.domain.replace(/^\./, ""));
});

// A tab finished loading a page on a granted host — the most reliable
// signal that a challenge may have just been solved there.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  let hostname;
  try {
    hostname = new URL(tab.url).hostname;
  } catch {
    return;
  }
  void captureForMatchedHost(hostname);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "kiri-refresh") {
    refreshAndCaptureGranted().then(sendResponse);
    return true;
  }

  if (message.type === "kiri-capture") {
    capture(message.host, { force: Boolean(message.force) }).then(sendResponse);
    return true;
  }

  if (message.type === "kiri-status") {
    (async () => {
      const {
        instanceUrl,
        token,
        hosts = [],
        lastCapture = {},
      } = await chrome.storage.local.get(["instanceUrl", "token", "hosts", "lastCapture"]);
      const granted = await grantedHostsOf(hosts);
      sendResponse({ instanceUrl, token, hosts, granted, lastCapture });
    })();
    return true;
  }

  return false;
});
