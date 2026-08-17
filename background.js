(() => {
  "use strict";

  const FEEDS_URL = "https://www.facebook.com/?filter=all&sk=h_chr&sorting_setting=CHRONOLOGICAL";
  const DEFAULT_SETTINGS = {
    enableAntiRefresh: true,
    enableFeedFilter: true,
    enableBlockSponsoredSidebar: true,
    enableGoDirectlyToFeeds: false,
    groupFeedDefaultSort: "new posts"
  };
  const FACEBOOK_URL_PATTERNS = [
    "*://www.facebook.com/*",
    "*://web.facebook.com/*"
  ];
  const LEGACY_ANTI_REFRESH_SCRIPT_ID = "faceberg-anti-refresh";
  const LEGACY_STALE_FEED_GUARD_SCRIPT_IDS = [
    "faceberg-stale-feed-guard-v1",
    "faceberg-facebook-module-guard-v2"
  ];
  const MODULE_GUARD_SCRIPT_ID = "faceberg-facebook-module-guard-v3";
  const MODULE_GUARD_RESET_FILE = "module-guard-reset.js";
  const MODULE_GUARD_ANTI_REFRESH_FILE =
    "module-guard-enable-anti-refresh.js";
  const MODULE_GUARD_FEED_FILTER_FILE =
    "module-guard-enable-feed-filter.js";
  const MODULE_GUARD_FILE = "stale-feed-guard.js";
  const ANTI_REFRESH_DIAGNOSTICS_KEY = "antiRefreshDiagnostics";
  const ANTI_REFRESH_CONFIG_KIND = "anti-refresh-config-v13";
  const CONTENT_SCRIPT_FILES = ["shared-stats.js", "content-utils.js", "content-debug.js", "content-feed.js", "content-comments.js", "content.js"];
  const SESSION_STATS_DEFAULTS = {
    sessionRemovedReels: 0,
    sessionRemovedFollowPosts: 0,
    sessionRemovedJoinPosts: 0,
    sessionRemovedStories: 0,
    sessionRemovedPeopleYouMayKnow: 0,
    sessionRemovedSponsored: 0,
    sessionPreventedRefreshes: 0,
    sessionCommentFilterChanges: 0,
    sessionExpandedPosts: 0,
    sessionExpandedComments: 0
  };
  let diagnosticsWriteQueue = Promise.resolve();

  async function resetSessionStats() {
    try {
      /* Session counters belong to the browser/extension session, not individual
         Facebook page loads. Resetting them from the content script causes normal
         navigations or reinjection to wipe the popup's This Session view. */
      await chrome.storage.local.set(SESSION_STATS_DEFAULTS);
    } catch (_error) {
      /* Ignore transient storage failures. */
    }
  }

  async function removeLegacyAntiRefreshRegistration() {
    await Promise.allSettled(
      [
        LEGACY_ANTI_REFRESH_SCRIPT_ID,
        ...LEGACY_STALE_FEED_GUARD_SCRIPT_IDS
      ].map((id) => {
        return chrome.scripting.unregisterContentScripts({ ids: [id] });
      })
    );
  }

  function getModuleGuardFiles(settings = {}) {
    const files = [MODULE_GUARD_RESET_FILE];
    if (settings.enableAntiRefresh === true) {
      files.push(MODULE_GUARD_ANTI_REFRESH_FILE);
    }
    if (
      settings.enableFeedFilter !== false &&
      settings.enableBlockSponsoredSidebar !== false
    ) {
      files.push(MODULE_GUARD_FEED_FILTER_FILE);
    }
    return files.length > 1
      ? [...files, MODULE_GUARD_FILE]
      : [];
  }

  async function syncModuleGuardRegistration(settings) {
    try {
      const registrations = await chrome.scripting.getRegisteredContentScripts({
        ids: [MODULE_GUARD_SCRIPT_ID]
      });
      const [registration] = registrations;
      const desiredFiles = getModuleGuardFiles(settings);
      const currentFiles = Array.isArray(registration?.js)
        ? registration.js
        : [];
      const registrationMatches =
        currentFiles.length === desiredFiles.length &&
        currentFiles.every((file, index) => file === desiredFiles[index]);

      if (registrationMatches) {
        return;
      }

      if (registration) {
        await chrome.scripting.unregisterContentScripts({
          ids: [MODULE_GUARD_SCRIPT_ID]
        });
      }

      if (desiredFiles.length > 0) {
        await chrome.scripting.registerContentScripts([
          {
            id: MODULE_GUARD_SCRIPT_ID,
            matches: FACEBOOK_URL_PATTERNS,
            js: desiredFiles,
            runAt: "document_start",
            world: "MAIN",
            persistAcrossSessions: true
          }
        ]);
      }
    } catch (_error) {
      /*
        Registration is best-effort on older Chromium builds. Existing tabs
        still receive the same guard through executeScript below.
      */
    }
  }

  function queueAntiRefreshDiagnostic(field, detail, sender) {
    diagnosticsWriteQueue = diagnosticsWriteQueue
      .then(async () => {
        const stored = await chrome.storage.local.get({
          [ANTI_REFRESH_DIAGNOSTICS_KEY]: {}
        });
        const previous = stored[ANTI_REFRESH_DIAGNOSTICS_KEY] || {};
        await chrome.storage.local.set({
          [ANTI_REFRESH_DIAGNOSTICS_KEY]: {
            ...previous,
            [field]: {
              ...(detail && typeof detail === "object" ? detail : {}),
              receivedAt: Date.now(),
              tabId: typeof sender?.tab?.id === "number" ? sender.tab.id : null
            }
          }
        });
      })
      .catch(() => {
        /* Diagnostics are best-effort and must never affect protection. */
      });
  }

  async function readSettings() {
    const settingKeys = Object.keys(DEFAULT_SETTINGS);
    const [syncResult, localResult] = await Promise.allSettled([
      chrome.storage.sync.get(settingKeys),
      chrome.storage.local.get(settingKeys)
    ]);

    const syncSettings = syncResult.status === "fulfilled" ? syncResult.value : {};
    const localSettings = localResult.status === "fulfilled" ? localResult.value : {};

    return {
      ...DEFAULT_SETTINGS,
      ...localSettings,
      ...syncSettings
    };
  }

  async function redirectFacebookTabsToFeeds() {
    try {
      const tabs = await chrome.tabs.query({ url: FACEBOOK_URL_PATTERNS });

      for (const tab of tabs) {
        if (typeof tab.id === "number") {
          chrome.tabs.update(tab.id, { url: FEEDS_URL });
        }
      }
    } catch (_error) {
      /* Ignore transient tab-query/reload errors. */
    }
  }

  function isFacebookUrl(url) {
    return /^https?:\/\/(www|web)\.facebook\.com\//i.test(String(url || ""));
  }

  async function hasFacebergContentScript(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "faceberg:ping" });
      return response?.ok === true;
    } catch (_error) {
      return false;
    }
  }

  async function ensureFacebergInjected(tabId) {
    if (typeof tabId !== "number" || tabId < 0) {
      return;
    }

    if (await hasFacebergContentScript(tabId)) {
      return;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: CONTENT_SCRIPT_FILES
      });
    } catch (_error) {
      /* Ignore restricted pages, duplicate injection races, or transient tab states. */
    }
  }

  async function ensurePageGuardsInjected(tabId, settings) {
    if (typeof tabId !== "number" || tabId < 0) {
      return;
    }

    try {
      const moduleGuardFiles = getModuleGuardFiles(settings);
      if (moduleGuardFiles.length > 0) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: moduleGuardFiles,
          world: "MAIN"
        });
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["injected.js"],
        world: "MAIN"
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (nextEnabled, configKind) => {
          window.postMessage(
            {
              source: "faceberg",
              kind: configKind,
              enabled: nextEnabled === true
            },
            "*"
          );
        },
        args: [
          settings?.enableAntiRefresh === true,
          ANTI_REFRESH_CONFIG_KIND
        ]
      });
    } catch (_error) {
      /* Ignore restricted pages, duplicate injection races, or transient tab states. */
    }
  }

  async function notifyFacebergRouteChanged(tabId, url) {
    if (typeof tabId !== "number" || !isFacebookUrl(url)) {
      return;
    }

    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "faceberg:route-changed",
        url
      });
    } catch (_error) {
      /* A document-start content script may still be loading its message listener. */
    }
  }

  async function applyProtectionToTab(tab) {
    if (!tab || typeof tab.id !== "number" || !isFacebookUrl(tab.url)) {
      return;
    }

    try {
      const settings = await readSettings();
      await ensureFacebergInjected(tab.id);
      await ensurePageGuardsInjected(tab.id, settings);
      await setTabDiscardable(tab.id, settings.enableAntiRefresh !== true);
    } catch (_error) {
      /* Ignore transient settings/read errors. */
    }
  }

  async function applyProtectionToTabId(tabId) {
    if (typeof tabId !== "number" || tabId < 0) {
      return;
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      await applyProtectionToTab(tab);
    } catch (_error) {
      /* Ignore transient tab lookup failures. */
    }
  }

  async function setTabDiscardable(tabId, autoDiscardable) {
    try {
      await chrome.tabs.update(tabId, { autoDiscardable });
    } catch (_error) {
      /* Ignore transient failures or unsupported tab states. */
    }
  }

  async function applyFacebookTabProtection() {
    try {
      const settings = await readSettings();
      const autoDiscardable = settings.enableAntiRefresh !== true;
      const tabs = await chrome.tabs.query({ url: FACEBOOK_URL_PATTERNS });

      await Promise.all(
        tabs
          .filter((tab) => typeof tab.id === "number")
          .map((tab) => setTabDiscardable(tab.id, autoDiscardable))
      );
    } catch (_error) {
      /* Ignore transient settings/read errors. */
    }
  }

  async function handleActivation() {
    try {
      const settings = await readSettings();
      await syncModuleGuardRegistration(settings);
      const tabs = await chrome.tabs.query({ url: FACEBOOK_URL_PATTERNS });

      await Promise.all(
        tabs
          .filter((tab) => typeof tab.id === "number")
          .map(async (tab) => {
            await ensureFacebergInjected(tab.id);
            await ensurePageGuardsInjected(tab.id, settings);
          })
      );

      await applyFacebookTabProtection();
      if (settings.enableGoDirectlyToFeeds === true) {
        await redirectFacebookTabsToFeeds();
      }
    } catch (_error) {
      /* Ignore transient settings/read errors. */
    }
  }

  chrome.runtime.onInstalled.addListener(() => {
    resetSessionStats().finally(() => {
      handleActivation();
    });
  });

  removeLegacyAntiRefreshRegistration();

  chrome.runtime.onStartup.addListener(() => {
    resetSessionStats().finally(() => {
      handleActivation();
    });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url && !tab?.url && changeInfo.status !== "complete") {
      return;
    }

    const url = changeInfo.url || tab.url;
    if (!isFacebookUrl(url)) {
      return;
    }

    applyProtectionToTab({ ...tab, id: tabId, url }).then(() => {
      if (changeInfo.url) {
        notifyFacebergRouteChanged(tabId, changeInfo.url);
      }
    });
  });

  chrome.tabs.onCreated.addListener((tab) => {
    if (isFacebookUrl(tab.url)) {
      applyProtectionToTab(tab);
    }
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    applyProtectionToTabId(tabId);
  });

  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (typeof windowId !== "number" || windowId < 0) {
      return;
    }

    try {
      const [activeTab] = await chrome.tabs.query({ windowId, active: true });
      await applyProtectionToTab(activeTab);
    } catch (_error) {
      /* Ignore transient focus/tab query failures. */
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "faceberg:anti-refresh-boot") {
      queueAntiRefreshDiagnostic("lastBoot", message.detail, sender);
      return false;
    }

    if (message?.type === "faceberg:anti-refresh-navigation") {
      queueAntiRefreshDiagnostic("lastNavigation", message.detail, sender);
      return false;
    }

    if (message?.type !== "faceberg:protect-tab") {
      return false;
    }

    applyProtectionToTab(sender.tab)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));

    return true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" && areaName !== "local") {
      return;
    }

    if (
      changes.enableAntiRefresh ||
      changes.enableFeedFilter ||
      changes.enableBlockSponsoredSidebar ||
      changes.enableGoDirectlyToFeeds
    ) {
      handleActivation();
    }
  });

  /*
    A developer-mode extension reload restarts this worker while Facebook may be
    hidden in another tab. Upgrade that tab immediately so its first return is
    protected, instead of waiting for the activation event that arrives too
    late to intercept the same visibility transition.
  */
  handleActivation();
})();
