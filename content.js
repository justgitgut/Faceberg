(() => {
  "use strict";

  if (window.__facebergContentScriptInstalled) {
    return;
  }

  window.__facebergContentScriptInstalled = true;

  /*
    Emergency diagnostic mode keeps the extension present without touching
    Facebook's page. It remains available as a one-switch baseline if the
    lightweight comment-only runtime regresses. Preserve the background ping
    contract so tab activation never repeatedly reinjects the content bundle.
  */
  const COMPATIBILITY_SAFE_MODE = false;
  if (COMPATIBILITY_SAFE_MODE) {
    window.__FACEBERG_SAFE_MODE = Object.freeze({
      active: true,
      reason: "facebook-runtime-compatibility"
    });

    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === "faceberg:ping") {
          sendResponse({ ok: true, safeMode: true });
        } else if (message?.type === "faceberg:rerun") {
          sendResponse({ ok: true, safeMode: true });
        }
        return false;
      });
    } catch (_error) {
      /* Safe mode must remain inert if the extension context is unavailable. */
    }

    return;
  }

  const DEFAULT_SETTINGS = {
    enableAntiRefresh: true,
    enableFeedFilter: true,
    enablePostExpansion: true,
    enableCommentSortAll: true,
    enableCommentExpansion: true,
    enableBlockSponsoredPosts: true,
    enableBlockSponsoredSidebar: true,
    enableBlockSponsoredReels: true,
    enableBlockReels: true,
    enableBlockStories: true,
    enableBlockPeopleYouMayKnow: true,
    enableBlockFollowPosts: true,
    enableBlockJoinPosts: true,
    enableCompactHiddenCards: true,
    enableGoDirectlyToFeeds: false,
    groupFeedDefaultSort: "new posts"
  };
  const sharedStats = globalThis.FacebergStats || {};
  const STATS_DEFAULTS = sharedStats.DEFAULT_STATS || {
    removedReels: 0,
    removedSponsoredReels: 0,
    removedFollowPosts: 0,
    removedJoinPosts: 0,
    removedStories: 0,
    removedPeopleYouMayKnow: 0,
    removedSponsored: 0,
    preventedRefreshes: 0,
    commentFilterChanges: 0,
    expandedPosts: 0,
    expandedComments: 0
  };
  const SESSION_STATS_DEFAULTS = sharedStats.SESSION_STATS_DEFAULTS || {
    sessionRemovedReels: 0,
    sessionRemovedSponsoredReels: 0,
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
  /*
    Destructive React-owned Home-feed cleanup remains disabled. Native post-body
    expansion is safe to run independently because it activates only Facebook's
    exact visible See more button and never mutates a feed-card wrapper.
  */
  const ENABLE_HOME_FEED_AUTOMATION = false;
  const ENABLE_GLOBAL_PAGE_MUTATION_OBSERVER = false;
  const POST_EXPANDER_MAX_ATTEMPTS = 4;
  const POST_EXPANDER_RETRY_COOLDOWN_MS = 250;
  const getSessionStatKey = sharedStats.toSessionKey || ((statKey) => `session${statKey.charAt(0).toUpperCase()}${statKey.slice(1)}`);
  let settings = { ...DEFAULT_SETTINGS };
  let statsFlushQueued = false;
  let extensionContextValid = true;
  const pendingStatIncrements = {};
  /* Facebook may render a valid See more button before its live click handler is
     attached. Track bounded retries instead of permanently suppressing the first
     no-op press during startup hydration. */
  const postExpanderAttemptState = new WeakMap();
  let lastObservedUrl = window.location.href;
  let runtimeReady = false;
  const runtimeCreatedAt = Date.now();
  let scrollSnapshotTimer = 0;
  let scrollRestoreUntil = 0;
  let lastUserScrollIntentAt = 0;
  const SCROLL_SNAPSHOT_STORAGE_KEY = "__facebergScrollSnapshotsV1";
  const SCROLL_SNAPSHOT_MAX_AGE_MS = 2 * 60 * 1000;
  const ANTI_REFRESH_NAVIGATION_EVENT = "__facebergAntiRefreshNavigation";
  const SPA_NAVIGATION_EVENT = "__facebergSpaNavigationV1";
  const ANTI_REFRESH_CONFIG_KIND = "anti-refresh-config-v13";
  const contentUtils = globalThis.FacebergContentUtils;
  if (!contentUtils) {
    return;
  }
  const {
    uiMatchers,
    normalizeText,
    isPostActionControl,
    hasPostActionControl,
    isVisible,
    pressElement
  } = contentUtils;
  const contentFeed = globalThis.FacebergFeedRuntime;
  if (!contentFeed) {
    return;
  }
  const contentComments = globalThis.FacebergCommentsRuntime;
  if (!contentComments) {
    return;
  }
  const contentDebug = globalThis.FacebergContentDebug || {};
  const describeElement = contentDebug.describeElement || ((element) => {
    if (!(element instanceof Element)) {
      return "<none>";
    }

    const tagName = String(element.tagName || "").toLowerCase();
    const role = element.getAttribute("role");
    const ariaModal = element.getAttribute("aria-modal");
    const pagelet = element.getAttribute("data-pagelet");
    return [
      tagName || "element",
      role ? `[role="${role}"]` : "",
      ariaModal ? `[aria-modal="${ariaModal}"]` : "",
      pagelet ? `[data-pagelet="${pagelet}"]` : ""
    ].filter(Boolean).join(" ");
  });
  const debugCommentAutomation = typeof contentDebug.debugCommentAutomation === "function"
    ? contentDebug.debugCommentAutomation
    : () => {};
  const runtimeDeps = {
    getSettings: () => settings,
    hasTrustedPageInteraction: () => lastUserScrollIntentAt > 0,
    getRuntimeAgeMs: () => Date.now() - runtimeCreatedAt,
    isCommentAutomationSuspended: () => commentAutomationSuspended,
    queueStatIncrement
  };
  const groupFeedSortState = {
    lastToggleAt: 0,
    lastSelectionAt: 0,
    interactionUntil: 0,
    retryFrameId: 0,
    observer: null
  };

  function normalizeGroupFeedSortValue(value) {
    const text = normalizeText(value || "");
    if (/^most relevant$/i.test(text)) {
      return "most relevant";
    }
    if (/^recent activity$/i.test(text)) {
      return "recent activity";
    }
    if (/^new posts$/i.test(text)) {
      return "new posts";
    }
    return DEFAULT_SETTINGS.groupFeedDefaultSort;
  }

  function getGroupFeedSortItemLabel(item) {
    if (!(item instanceof Element)) {
      return "";
    }

    const primaryLabel = normalizeText(item.querySelector('span[dir="auto"]')?.textContent || "");
    if (primaryLabel) {
      return primaryLabel;
    }

    const fullText = normalizeText(item.textContent || item.getAttribute("aria-label"));
    if (/^most relevant\b/i.test(fullText)) {
      return "most relevant";
    }
    if (/^recent activity\b/i.test(fullText)) {
      return "recent activity";
    }
    if (/^new posts\b/i.test(fullText)) {
      return "new posts";
    }

    return fullText;
  }

  function isDirectPostPage() {
    return contentComments.isDirectPostPage();
  }

  function isMediaViewerPage() {
    return contentComments.isMediaViewerPage();
  }

  function getActiveReelCommentSurface(root = document) {
    return contentComments.getActiveReelCommentSurface?.(root) || null;
  }

  function isPostOrMediaNavigationHref(href) {
    if (!href) {
      return false;
    }

    try {
      const url = new URL(href, window.location.href);
      return url.origin === window.location.origin &&
        /\/permalink\/|\/posts\/|\/story\.php|\/photo\/|\/videos\/|\/reel\//i.test(
          url.pathname
        );
    } catch (_error) {
      return false;
    }
  }

  function shouldWakeCommentRuntimeFromClick(event) {
    if (event?.isTrusted !== true || !(event.target instanceof Element)) {
      return false;
    }

    const target = event.target;
    if (target.closest('[data-ad-rendering-role="comment_button"]')) {
      return true;
    }

    const control = target.closest(
      '[role="button"], [role="link"], button, a[href], [tabindex]'
    );
    if (!(control instanceof Element)) {
      return false;
    }

    const text = normalizeText(
      control.getAttribute("aria-label") || control.textContent
    );
    if (
      text === "comment" ||
      text === "comments" ||
      text.startsWith("leave a comment") ||
      uiMatchers.commentSummaryRegex.test(text)
    ) {
      return true;
    }

    const link = control.matches("a[href]") ? control : control.closest("a[href]");
    return isPostOrMediaNavigationHref(link?.getAttribute("href") || "");
  }

  function isTrustedFeedCardInteraction(event) {
    if (event?.isTrusted !== true || !(event.target instanceof Element)) {
      return false;
    }

    const control = event.target.closest(
      'a[href], button, [role="button"], [role="link"], [tabindex]'
    );
    return (
      control instanceof Element &&
      !!control.closest('[role="main"], main') &&
      !!control.closest('[data-virtualized], [aria-posinset], div[role="article"]')
    );
  }

  function scheduleUserInitiatedCommentWake() {
    commentWakeObserver?.disconnect();
    if (commentWakeFrame) {
      cancelAnimationFrame(commentWakeFrame);
    }

    const startingUrl = window.location.href;
    const tryWake = (allowInlineSurface = false) => {
      commentWakeFrame = 0;
      if (!runtimeReady || document.visibilityState !== "visible") {
        return;
      }

      const dialog = getVisiblePostDialog(document);
      const routeSettled =
        window.location.href !== startingUrl ||
        isDirectPostPage() ||
        isMediaViewerPage();
      if (!(dialog instanceof Element) && !routeSettled && !allowInlineSurface) {
        return;
      }

      commentWakeObserver?.disconnect();
      commentWakeObserver = null;
      feedAutomationSuspended = false;
      if (dialog instanceof Element) {
        commentAutomationSuspended = false;
        debouncedRunAll(dialog);
      } else if (routeSettled) {
        armSpaCommentWake();
      } else {
        commentAutomationSuspended = false;
        debouncedCommentAutomation();
      }
    };

    commentWakeObserver = new MutationObserver(() => {
      if (!commentWakeFrame) {
        commentWakeFrame = requestAnimationFrame(() => tryWake(true));
      }
    });
    commentWakeObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
    commentWakeFrame = requestAnimationFrame(() => tryWake(false));
  }

  function getVisiblePostDialog(root = document) {
    return contentComments.getVisiblePostDialog(root);
  }

  function getBlockingMediaViewerOverlay() {
    return contentComments.getBlockingMediaViewerOverlay?.() || null;
  }

  function hasPostDialogSignals(surface) {
    return contentComments.hasPostDialogSignals(surface);
  }

  function hasCommentSurfaceSignals(surface) {
    return contentComments.hasCommentSurfaceSignals(surface);
  }

  function getDirectPageExpansionRoot(root = document) {
    const scopeElement = root instanceof Element ? root : document.body;
    const selectors = isMediaViewerPage()
      ? ['[role="complementary"]', 'div[role="article"]', '[data-pagelet]', 'main', '[role="main"]']
      : ['div[role="article"]', '[data-pagelet]', 'main', '[role="main"]'];

    for (const selector of selectors) {
      const scopedMatch = scopeElement instanceof Element
        ? scopeElement.closest(selector) || scopeElement.querySelector?.(selector)
        : null;
      if (scopedMatch instanceof Element && isVisible(scopedMatch)) {
        return scopedMatch;
      }

      const documentMatch = document.querySelector(selector);
      if (documentMatch instanceof Element && isVisible(documentMatch)) {
        return documentMatch;
      }
    }

    return root;
  }

  function runCommentAutomation(root = document) {
    return contentComments.runCommentAutomation(root, runtimeDeps);
  }

  function scheduleCommentAutomationPasses(root = document) {
    return contentComments.scheduleCommentAutomationPasses(root, runtimeDeps);
  }

  function runFeedCleanup(root = document) {
    return contentFeed.runFeedCleanup(root, runtimeDeps);
  }

  function runSponsoredFeedFiltering(root = document) {
    if (isFeedAutomationBlocked()) {
      return;
    }

    return contentFeed.runSponsoredFeedFiltering(root, runtimeDeps);
  }

  function runSidebarSponsoredFiltering(root = document) {
    return contentFeed.runSidebarSponsoredFiltering?.(root, runtimeDeps);
  }

  function runSponsoredReelFiltering(root = document) {
    return contentFeed.runSponsoredReelFiltering?.(root, runtimeDeps) || 0;
  }

  /* Mutation-driven scheduling infrastructure. Automation reacts to actual DOM
     changes and coalesces work into the next rendering frame. */
  let pendingRunAllFrame = 0;
  let pendingAutomationFrame = 0;
  let pendingHomeFeedAutomationFrame = 0;
  let pendingSponsoredFeedFiltering = false;
  let pendingPostExpansion = false;
  let feedAutomationSuspended = false;
  let commentAutomationSuspended = false;
  let pendingSidebarSponsoredFiltering = 0;
  let observedSponsoredSidebar = null;
  let sponsoredSidebarObserver = null;
  let sponsoredSidebarLocatorObserver = null;
  let observedSponsoredReelRoot = null;
  let sponsoredReelObserver = null;
  let observedHomeFeed = null;
  let homeFeedObserver = null;
  let homeFeedLocatorObserver = null;
  let commentWakeObserver = null;
  let commentWakeFrame = 0;
  let closeDialogObserver = null;
  let pendingSpaCommentUrl = "";
  let pendingReelSidebarRefresh = null;
  const pendingHomeFeedRoots = new Set();
  let lastFullDocumentPassAt = 0;
  const pendingRunAllRoots = new Set();
  const runtimePerformance = {
    addedElements: 0,
    documentRuns: 0,
    homeFeedImmediateLastDurationMs: 0,
    homeFeedImmediateMaxDurationMs: 0,
    homeFeedImmediateReason: "",
    homeFeedImmediateRuns: 0,
    homeFeedImmediateTotalDurationMs: 0,
    homeFeedLocatorBatches: 0,
    homeFeedMutationBatches: 0,
    homeFeedRootChanges: 0,
    homeFeedRootScore: 0,
    lastDurationMs: 0,
    localRuns: 0,
    longTaskCount: 0,
    longTaskMaxMs: 0,
    longTaskTotalMs: 0,
    maxDurationMs: 0,
    mutationBatches: 0,
    mutationRecords: 0,
    runCount: 0,
    sponsoredReelMutationBatches: 0,
    sponsoredReelRootChanges: 0,
    slowRunCount: 0,
    spaMutationBatches: 0,
    spaRouteWaitBatches: 0,
    spaUrlChanges: 0,
    runtimeStartedAt: 0,
    totalDurationMs: 0
  };
  window.__FACEBERG_PERF_SUMMARY = runtimePerformance;

  function hasVisibleModalDialog() {
    return [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .some((dialog) => isVisible(dialog));
  }

  function isFeedAutomationBlocked() {
    return (
      feedAutomationSuspended ||
      window.location.pathname !== "/" ||
      hasVisibleModalDialog()
    );
  }

  function runImmediateSponsoredFeedFiltering(root, reason = "") {
    if (
      !runtimeReady ||
      !settings?.enableFeedFilter ||
      document.visibilityState !== "visible" ||
      isFeedAutomationBlocked()
    ) {
      return;
    }

    const startedAt = window.performance.now();
    runSponsoredFeedFiltering(root);
    const duration = window.performance.now() - startedAt;
    runtimePerformance.homeFeedImmediateRuns += 1;
    runtimePerformance.homeFeedImmediateTotalDurationMs += duration;
    runtimePerformance.homeFeedImmediateLastDurationMs = duration;
    runtimePerformance.homeFeedImmediateMaxDurationMs = Math.max(
      runtimePerformance.homeFeedImmediateMaxDurationMs,
      duration
    );
    runtimePerformance.homeFeedImmediateReason = reason;
  }

  function cancelPendingFeedAutomation() {
    if (pendingHomeFeedAutomationFrame) {
      cancelAnimationFrame(pendingHomeFeedAutomationFrame);
      pendingHomeFeedAutomationFrame = 0;
    }
    pendingSponsoredFeedFiltering = false;
    pendingPostExpansion = false;
    pendingHomeFeedRoots.clear();
  }

  function suspendFeedAutomationForNavigation() {
    feedAutomationSuspended = true;
    /* Existing comment-surface observers must become inert before Facebook's
       click handler starts swapping URLs and recycled dialog nodes. Without
       this, a retained controller can press controls in the post being closed
       while the next post is still mounting. */
    commentAutomationSuspended = true;
    cancelPendingFeedAutomation();
  }

  function suspendCommentAutomationForDialogClose(dialog) {
    if (!(dialog instanceof Element)) {
      return false;
    }

    commentAutomationSuspended = true;
    pendingSpaCommentUrl = "";
    watchForDialogClose(dialog);
    return true;
  }

  function scheduleFeedAutomationResume() {
    feedAutomationSuspended = false;
    if (
      runtimeReady &&
      document.visibilityState === "visible" &&
      window.location.pathname === "/" &&
      !hasVisibleModalDialog()
    ) {
      scheduleSidebarSponsoredFiltering();
      ensureHomeFeedObserver();
    }
  }

  function scheduleSidebarSponsoredFiltering() {
    if (
      !runtimeReady ||
      !settings?.enableFeedFilter ||
      !settings?.enableBlockSponsoredSidebar ||
      document.visibilityState !== "visible" ||
      window.location.pathname !== "/" ||
      hasVisibleModalDialog()
    ) {
      return;
    }

    if (pendingSidebarSponsoredFiltering) {
      cancelAnimationFrame(pendingSidebarSponsoredFiltering);
    }

    pendingSidebarSponsoredFiltering = requestAnimationFrame(() => {
      pendingSidebarSponsoredFiltering = 0;
      if (
        settings?.enableFeedFilter &&
        settings?.enableBlockSponsoredSidebar &&
        document.visibilityState === "visible" &&
        window.location.pathname === "/" &&
        !hasVisibleModalDialog()
      ) {
        runSidebarSponsoredFiltering(observedSponsoredSidebar || document);
      }
    });
  }

  function ensureSponsoredSidebarLocatorObserver() {
    if (
      !settings?.enableFeedFilter ||
      !settings?.enableBlockSponsoredSidebar
    ) {
      return;
    }

    if (sponsoredSidebarLocatorObserver) {
      return;
    }

    sponsoredSidebarLocatorObserver = new MutationObserver((mutations) => {
      if (observedSponsoredSidebar?.isConnected) {
        return;
      }

      const sidebarWasAdded = mutations.some((mutation) => {
        return [...mutation.addedNodes].some((node) => {
          return node instanceof Element && (
            node.matches('[role="complementary"]') ||
            !!node.querySelector('[role="complementary"]')
          );
        });
      });
      if (sidebarWasAdded) {
        ensureSponsoredSidebarObserver();
      }
    });
    sponsoredSidebarLocatorObserver.observe(
      document.body || document.documentElement,
      { childList: true, subtree: true }
    );
  }

  function ensureSponsoredSidebarObserver() {
    if (
      !runtimeReady ||
      !settings?.enableFeedFilter ||
      !settings?.enableBlockSponsoredSidebar ||
      document.visibilityState !== "visible" ||
      window.location.pathname !== "/"
    ) {
      return;
    }

    const sidebar = document.querySelector('[role="complementary"]');
    if (!(sidebar instanceof Element)) {
      ensureSponsoredSidebarLocatorObserver();
      return;
    }

    if (
      observedSponsoredSidebar === sidebar &&
      sponsoredSidebarObserver
    ) {
      scheduleSidebarSponsoredFiltering();
      return;
    }

    sponsoredSidebarObserver?.disconnect();
    observedSponsoredSidebar = sidebar;
    sponsoredSidebarObserver = new MutationObserver(() => {
      scheduleSidebarSponsoredFiltering();
    });
    sponsoredSidebarObserver.observe(sidebar, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-ad-rendering-role", "hidden"]
    });
    ensureSponsoredSidebarLocatorObserver();
    scheduleSidebarSponsoredFiltering();
  }

  function stopSponsoredSidebarObservers() {
    if (pendingSidebarSponsoredFiltering) {
      cancelAnimationFrame(pendingSidebarSponsoredFiltering);
      pendingSidebarSponsoredFiltering = 0;
    }
    sponsoredSidebarObserver?.disconnect();
    sponsoredSidebarLocatorObserver?.disconnect();
    sponsoredSidebarObserver = null;
    sponsoredSidebarLocatorObserver = null;
    observedSponsoredSidebar = null;
  }

  function isReelExperiencePath() {
    return /\/reel(?:s)?(?:\/|$)/i.test(
      String(window.location.pathname || "")
    );
  }

  function getReelRouteId(href = window.location.href) {
    try {
      return new URL(href, window.location.href).pathname.match(/\/reel\/(\d+)/i)?.[1] || "";
    } catch {
      return "";
    }
  }

  function getVisibleReelCommentSidebar() {
    return [...document.querySelectorAll('[role="complementary"]')].find((surface) => {
      if (!(surface instanceof Element) || !isVisible(surface) || !hasCommentSurfaceSignals(surface)) {
        return false;
      }

      const rect = surface.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
    }) || null;
  }

  function reelSidebarMatchesRoute(surface, reelId) {
    if (!(surface instanceof Element) || !reelId) {
      return false;
    }

    return [...surface.querySelectorAll('a[href*="/reel/"]')].some((link) => {
      return getReelRouteId(link.href) === reelId;
    });
  }

  function getActiveReelCommentToggle() {
    const viewportCenterY = (window.innerHeight || 0) / 2;
    return [...document.querySelectorAll('[role="button"][aria-label], button[aria-label]')]
      .filter((button) => {
        if (!(button instanceof Element) || normalizeText(button.getAttribute("aria-label")) !== "comment") {
          return false;
        }
        const rect = button.getBoundingClientRect();
        return isVisible(button) && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
      })
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return Math.abs(leftRect.top + leftRect.height / 2 - viewportCenterY) -
          Math.abs(rightRect.top + rightRect.height / 2 - viewportCenterY);
      })[0] || null;
  }

  function recoverStaleReelSidebar() {
    const refresh = pendingReelSidebarRefresh;
    if (!refresh || refresh.url !== window.location.href) {
      pendingReelSidebarRefresh = null;
      return false;
    }

    const sidebar = getVisibleReelCommentSidebar();
    if (sidebar && reelSidebarMatchesRoute(sidebar, refresh.reelId)) {
      pendingReelSidebarRefresh = null;
      return false;
    }

    const toggle = getActiveReelCommentToggle();
    if (!(toggle instanceof Element)) {
      return false;
    }

    if (refresh.phase === "close") {
      if (sidebar || toggle.getAttribute("aria-expanded") === "true") {
        if (pressElement(toggle)) {
          refresh.phase = "reopen";
          return true;
        }
        pendingReelSidebarRefresh = null;
        return false;
      }
      refresh.phase = "reopen";
    }

    if (refresh.phase === "reopen" && !sidebar) {
      if (pressElement(toggle)) {
        refresh.phase = "wait-for-current";
        return true;
      }
      pendingReelSidebarRefresh = null;
    }

    return false;
  }

  function getSponsoredReelObserverRoot() {
    if (!isReelExperiencePath()) {
      return null;
    }

    const candidates = [...document.querySelectorAll('main, [role="main"]')]
      .filter((candidate) => {
        return (
          candidate instanceof Element &&
          candidate.isConnected &&
          isVisible(candidate) &&
          candidate.querySelectorAll("video").length >= 1
        );
      })
      .map((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return {
          candidate,
          score:
            candidate.querySelectorAll("video").length * 100 +
            Math.min(100, Math.round((rect.width * rect.height) / 10000))
        };
      })
      .sort((left, right) => right.score - left.score);

    return candidates[0]?.candidate || null;
  }

  function stopSponsoredReelObserver() {
    sponsoredReelObserver?.disconnect();
    sponsoredReelObserver = null;
    observedSponsoredReelRoot = null;
    runSponsoredReelFiltering(document);
  }

  function ensureSponsoredReelObserver() {
    const shouldRun =
      runtimeReady &&
      settings?.enableFeedFilter === true &&
      settings?.enableBlockSponsoredReels === true &&
      isReelExperiencePath();
    if (!shouldRun) {
      stopSponsoredReelObserver();
      return;
    }

    const root = getSponsoredReelObserverRoot();
    if (!(root instanceof Element)) {
      sponsoredReelObserver?.disconnect();
      sponsoredReelObserver = null;
      observedSponsoredReelRoot = null;
      return;
    }

    if (observedSponsoredReelRoot === root && sponsoredReelObserver) {
      runSponsoredReelFiltering(root);
      return;
    }

    sponsoredReelObserver?.disconnect();
    observedSponsoredReelRoot = root;
    runtimePerformance.sponsoredReelRootChanges += 1;
    sponsoredReelObserver = new MutationObserver((mutations) => {
      runtimePerformance.sponsoredReelMutationBatches += 1;
      handlePotentialUrlChange();
      if (
        document.visibilityState !== "visible" ||
        !settings?.enableFeedFilter ||
        !settings?.enableBlockSponsoredReels ||
        !isReelExperiencePath()
      ) {
        return;
      }

      const localRoots = new Set();
      let shouldScanWholeReelRoot = false;
      for (const mutation of mutations) {
        const candidates = mutation.type === "childList"
          ? [...mutation.addedNodes, mutation.target]
          : [mutation.target];
        for (const node of candidates) {
          const element =
            node instanceof Element ? node : node?.parentElement;
          if (element instanceof Element && element.isConnected) {
            localRoots.add(element);
            if (
              mutation.type === "childList" &&
              (element.matches("video") || !!element.querySelector("video"))
            ) {
              shouldScanWholeReelRoot = true;
            }
          }
        }
      }

      if (shouldScanWholeReelRoot || localRoots.size === 0) {
        runSponsoredReelFiltering(root);
        return;
      }

      for (const localRoot of localRoots) {
        runSponsoredReelFiltering(localRoot);
      }
    });
    sponsoredReelObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "hidden",
        "href",
        "rel",
        "target"
      ]
    });
    runSponsoredReelFiltering(root);
  }

  function getHomeFeedObserverCandidateScore(candidate) {
    if (!(candidate instanceof Element) || !isVisible(candidate)) {
      return 0;
    }

    let score = 1;
    const hasExactFeedHeading = [
      ...candidate.querySelectorAll('h1, h2, h3, [role="heading"]')
    ].some((heading) => normalizeText(heading.textContent) === "feed posts");
    if (hasExactFeedHeading) {
      score += 100;
    }
    if (candidate.querySelector("[aria-posinset], [data-virtualized]")) {
      score += 40;
    }
    if (
      candidate.querySelector(
        'div[role="article"], [role="button"][aria-label^="Actions for this post" i]'
      )
    ) {
      score += 30;
    }
    if (candidate.querySelector('[role="region"][aria-label="Create a post"]')) {
      score += 10;
    }
    return score;
  }

  function getHomeFeedObserverRoot() {
    if (window.location.pathname !== "/") {
      return null;
    }

    const candidates = [...document.querySelectorAll('main, [role="main"]')]
      .filter((candidate) => candidate instanceof Element && isVisible(candidate));
    const rankedCandidates = candidates
      .map((candidate) => ({
        candidate,
        score: getHomeFeedObserverCandidateScore(candidate)
      }))
      .sort((left, right) => right.score - left.score);
    const bestCandidate = rankedCandidates[0];
    const currentCandidate = rankedCandidates.find(({ candidate }) => {
      return candidate === observedHomeFeed;
    });
    return (
      currentCandidate && currentCandidate.score >= Number(bestCandidate?.score || 0)
        ? currentCandidate.candidate
        : bestCandidate?.candidate
    ) || null;
  }

  function addedNodeMayContainFeedRoot(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    if (!(element instanceof Element)) {
      return false;
    }

    if (
      observedHomeFeed instanceof Element &&
      observedHomeFeed.isConnected &&
      observedHomeFeed.contains(element)
    ) {
      return false;
    }

    const selector = [
      "main",
      '[role="main"]',
      "[aria-posinset]",
      "[data-virtualized]",
      'div[role="article"]',
      '[role="button"][aria-label^="Actions for this post" i]'
    ].join(", ");
    return element.matches(selector) || !!element.querySelector(selector);
  }

  function ensureHomeFeedLocatorObserver() {
    if (homeFeedLocatorObserver) {
      return;
    }

    homeFeedLocatorObserver = new MutationObserver((mutations) => {
      runtimePerformance.homeFeedLocatorBatches += 1;
      if (window.location.pathname !== "/") {
        return;
      }

      const shouldRecheckRoot = !observedHomeFeed?.isConnected || mutations.some((mutation) => {
        return [...mutation.addedNodes].some((node) => {
          return addedNodeMayContainFeedRoot(node);
        });
      });
      if (shouldRecheckRoot) {
        ensureHomeFeedObserver();
      }
    });
    homeFeedLocatorObserver.observe(
      document.body || document.documentElement,
      { childList: true, subtree: true }
    );
  }

  function ensureHomeFeedObserver() {
    if (!runtimeReady || window.location.pathname !== "/") {
      homeFeedObserver?.disconnect();
      homeFeedObserver = null;
      observedHomeFeed = null;
      runtimePerformance.homeFeedRootScore = 0;
      pendingHomeFeedRoots.clear();
      return;
    }

    const feedRoot = getHomeFeedObserverRoot();
    if (!(feedRoot instanceof Element)) {
      ensureHomeFeedLocatorObserver();
      return;
    }
    const feedRootScore = getHomeFeedObserverCandidateScore(feedRoot);
    if (observedHomeFeed === feedRoot && homeFeedObserver) {
      runtimePerformance.homeFeedRootScore = feedRootScore;
      return;
    }

    homeFeedObserver?.disconnect();
    observedHomeFeed = feedRoot;
    runtimePerformance.homeFeedRootChanges += 1;
    runtimePerformance.homeFeedRootScore = feedRootScore;
    homeFeedObserver = new MutationObserver((mutations) => {
      runtimePerformance.homeFeedMutationBatches += 1;
      handlePotentialUrlChange();
      if (
        document.visibilityState !== "visible" ||
        window.location.pathname !== "/" ||
        isFeedAutomationBlocked()
      ) {
        return;
      }

      const batchRoots = new Set();
      for (const mutation of mutations) {
        const candidates = mutation.type === "childList"
          ? [...mutation.addedNodes]
          : [mutation.target];
        for (const node of candidates) {
          const element = node instanceof Element ? node : node.parentElement;
          if (element instanceof Element) {
            const localRoot =
              element.closest('[aria-posinset], [data-virtualized], div[role="article"]') ||
              element;
            pendingHomeFeedRoots.add(localRoot);
            batchRoots.add(localRoot);
          }
        }
      }

      if (pendingHomeFeedRoots.size > 0) {
        /*
          Do not defer native Sponsored hiding to a second animation frame.
          Chromium variants can starve that frame while Facebook runs a dense
          startup task chain. MutationObserver delivery is already coalesced;
          process only this batch's card-local roots before returning to the
          page, then leave post expansion on the normal frame scheduler.
        */
        for (const root of batchRoots) {
          if (root.isConnected) {
            runImmediateSponsoredFeedFiltering(root, "feed-mutation");
          }
        }
        if (settings?.enablePostExpansion) {
          scheduleVisiblePostExpansion();
        } else {
          pendingHomeFeedRoots.clear();
        }
      }
    });
    homeFeedObserver.observe(feedRoot, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-ad-rendering-role", "hidden"]
    });
    ensureHomeFeedLocatorObserver();
    runImmediateSponsoredFeedFiltering(feedRoot, "feed-root-attached");
  }

  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const duration = Number(entry.duration || 0);
        runtimePerformance.longTaskCount += 1;
        runtimePerformance.longTaskTotalMs += duration;
        runtimePerformance.longTaskMaxMs = Math.max(runtimePerformance.longTaskMaxMs, duration);
      }
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch (_error) {
    /* Long-task timing is optional in isolated extension worlds. */
  }

  function normalizeRunAllRoot(root) {
    if (!(root instanceof Element)) {
      return document;
    }

    return root.closest('[role="dialog"]') ||
      root.closest('[data-virtualized], [aria-posinset], div[role="article"]') ||
      root;
  }

  function addPendingRunAllRoot(root) {
    const normalizedRoot = normalizeRunAllRoot(root);
    if (normalizedRoot === document) {
      pendingRunAllRoots.clear();
      pendingRunAllRoots.add(document);
      return;
    }

    if (pendingRunAllRoots.has(document)) {
      return;
    }

    for (const existingRoot of [...pendingRunAllRoots]) {
      if (existingRoot === normalizedRoot || existingRoot.contains(normalizedRoot)) {
        return;
      }
      if (normalizedRoot.contains(existingRoot)) {
        pendingRunAllRoots.delete(existingRoot);
      }
    }

    pendingRunAllRoots.add(normalizedRoot);
    if (pendingRunAllRoots.size > 24) {
      const main = normalizedRoot.closest('[role="main"]');
      pendingRunAllRoots.clear();
      pendingRunAllRoots.add(main || document);
    }
  }

  function debouncedRunAll(root = document) {
    if (!runtimeReady) {
      return;
    }

    addPendingRunAllRoot(root);

    if (pendingRunAllFrame) return;
    pendingRunAllFrame = requestAnimationFrame(() => {
      const nextRoots = [...pendingRunAllRoots];
      pendingRunAllRoots.clear();
      pendingRunAllFrame = 0;
      for (const nextRoot of nextRoots) {
        if (nextRoot === document || nextRoot.isConnected) {
          runAll(nextRoot);
        }
      }
    });
  }

  function debouncedCommentAutomation() {
    if (pendingAutomationFrame) return;
    pendingAutomationFrame = requestAnimationFrame(() => {
      pendingAutomationFrame = 0;
      runCommentAutomation(document);
    });
  }

  function scheduleStartupStabilizationPasses() {
    ensureHomeFeedObserver();
    ensureSponsoredSidebarObserver();
    ensureSponsoredReelObserver();
  }

  async function readSettings() {
    if (!canUseExtensionApis()) {
      return { ...DEFAULT_SETTINGS };
    }

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

  function markExtensionContextInvalid(error) {
    const message = String(error?.message || error || "");
    if (/Extension context invalidated|Receiving end does not exist|message port closed|No tab with id|Cannot access contents/i.test(message)) {
      extensionContextValid = false;
    }
  }

  function canUseExtensionApis() {
    return extensionContextValid &&
      typeof chrome !== "undefined" &&
      !!chrome.runtime?.id &&
      !!chrome.storage?.local;
  }

  function requestTabProtection() {
    window.postMessage(
      {
        source: "faceberg",
        kind: ANTI_REFRESH_CONFIG_KIND,
        enabled: settings.enableAntiRefresh === true
      },
      "*"
    );

    if (!settings.enableAntiRefresh || !canUseExtensionApis()) {
      return;
    }

    try {
      chrome.runtime.sendMessage({ type: "faceberg:protect-tab" }).catch((error) => {
        markExtensionContextInvalid(error);
        /* Ignore transient service-worker wakeup or messaging failures. */
      });
    } catch (error) {
      markExtensionContextInvalid(error);
    }
  }

  function queueStatIncrement(statKey, delta = 1) {
    if (!statKey || !Number.isFinite(delta) || delta <= 0) {
      return;
    }

    pendingStatIncrements[statKey] = (pendingStatIncrements[statKey] || 0) + delta;

    if (statsFlushQueued) {
      return;
    }

    statsFlushQueued = true;
    queueMicrotask(() => {
      statsFlushQueued = false;
      flushStats().catch(() => {
        /* Ignore storage write failures. */
      });
    });
  }

  async function flushStats() {
    if (!canUseExtensionApis()) {
      return;
    }

    const keys = Object.keys(pendingStatIncrements);
    if (keys.length === 0) {
      return;
    }

    const increments = {};
    keys.forEach((key) => {
      increments[key] = pendingStatIncrements[key];
      delete pendingStatIncrements[key];
    });

    let current;
    try {
      current = await chrome.storage.local.get({
        ...STATS_DEFAULTS,
        ...SESSION_STATS_DEFAULTS
      });
    } catch (error) {
      markExtensionContextInvalid(error);
      return;
    }
    const next = {};

    Object.keys(STATS_DEFAULTS).forEach((key) => {
      const base = Number(current[key] || 0);
      const delta = Number(increments[key] || 0);
      next[key] = base + delta;
    });

    Object.keys(STATS_DEFAULTS).forEach((totalKey) => {
      const sessionKey = getSessionStatKey(totalKey);
      const base = Number(current[sessionKey] || 0);
      const delta = Number(increments[totalKey] || 0);
      next[sessionKey] = base + delta;
    });

    try {
      await chrome.storage.local.set(next);
    } catch (error) {
      markExtensionContextInvalid(error);
    }
  }

  function expandPostBodies(root = document) {
    if (!settings.enablePostExpansion) {
      return;
    }

    if (
      root === document &&
      window.location.pathname === "/" &&
      feedAutomationSuspended
    ) {
      return;
    }

    const scope = root instanceof Element
      ? root.closest(
        '[data-ad-rendering-role="story_message"], [data-ad-rendering-role="story_body"], div[role="article"], [data-pagelet*="FeedUnit"], [aria-posinset], [data-virtualized]'
      ) || root
      : document;
    const hasVisibleModalDialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .some((dialog) => isVisible(dialog));
    const isDialogScope = scope instanceof Element && scope.matches('[role="dialog"]');
    const isDocumentPass = scope === document;
    const isHomeFeedPass =
      isDocumentPass &&
      window.location.pathname === "/" &&
      !hasVisibleModalDialog;
    const maxPriorityClicks = isDocumentPass ? 12 : 4;
    const maxGenericClicks = isDialogScope || isHomeFeedPass ? 0 : (isDocumentPass ? 4 : 2);
    const prioritizedCandidateSelector = isDialogScope
      ? '[data-ad-rendering-role="story_message"] [role="button"][tabindex], [data-ad-rendering-role="story_body"] [role="button"][tabindex]'
      : '[data-ad-rendering-role="story_message"] [role="button"][tabindex], [data-ad-rendering-role="story_body"] [role="button"][tabindex], [data-ad-comet-preview="message"] [role="button"][tabindex]';
    const prioritizedCandidates = scope.querySelectorAll(prioritizedCandidateSelector);
    const genericCandidates = isDialogScope || isHomeFeedPass
      ? []
      : scope.querySelectorAll('[role="button"][tabindex]');
    const candidates = [];
    const seenCandidates = new Set();
    let priorityClicksThisRun = 0;
    let genericClicksThisRun = 0;

    function getPostExpanderAttemptState(button) {
      return postExpanderAttemptState.get(button) || { attempts: 0, lastAttemptAt: 0 };
    }

    function canAttemptPostExpander(button) {
      const { attempts, lastAttemptAt } = getPostExpanderAttemptState(button);
      if (attempts === 0) {
        return true;
      }

      if (attempts >= POST_EXPANDER_MAX_ATTEMPTS) {
        return false;
      }

      return (Date.now() - lastAttemptAt) >= POST_EXPANDER_RETRY_COOLDOWN_MS;
    }

    function markPostExpanderAttempt(button) {
      const { attempts } = getPostExpanderAttemptState(button);
      postExpanderAttemptState.set(button, {
        attempts: attempts + 1,
        lastAttemptAt: Date.now()
      });
    }

    function hasInlineSeeMoreLabel(button, normalizedButtonText = "") {
      if (!(button instanceof Element)) {
        return false;
      }

      const storyContainer = button.closest('[data-ad-rendering-role="story_message"], [data-ad-rendering-role="story_body"], [data-ad-comet-preview="message"]');
      if (!storyContainer) {
        return false;
      }

      const inlineTextContainer = button.parentElement;
      const inlineText = normalizeText(inlineTextContainer?.textContent || normalizedButtonText);
      if (!inlineText || !/(?:^|[\s.,!?;:()\[\]{}])see more(?=$|[\s.,!?;:()\[\]{}…])/iu.test(inlineText)) {
        return false;
      }

      return inlineText.includes("...") || inlineText.includes("…") || /line-clamp|webkit-box/i.test(inlineTextContainer?.getAttribute("style") || "");
    }

    function pushCandidate(button, priority) {
      if (!(button instanceof Element) || seenCandidates.has(button)) {
        return;
      }

      seenCandidates.add(button);
      candidates.push({ button, priority });
    }

    prioritizedCandidates.forEach((button) => {
      const text = normalizeText(button.textContent || button.getAttribute("aria-label"));
      if (uiMatchers.seeMoreRegex.test(text) || hasInlineSeeMoreLabel(button, text)) {
        pushCandidate(button, "priority");
      }
    });
    genericCandidates.forEach((button) => pushCandidate(button, "generic"));

    function isLikelyPostExpander(button) {
      if (!isVisible(button) || !canAttemptPostExpander(button)) {
        return false;
      }

      const viewportRect = button.getBoundingClientRect();
      if (
        viewportRect.width <= 0 ||
        viewportRect.height <= 0 ||
        viewportRect.bottom <= -80 ||
        viewportRect.top >= window.innerHeight + 160
      ) {
        return false;
      }

      if (button.getAttribute("tabindex") !== "0" || button.getAttribute("aria-hidden") === "true") {
        return false;
      }

      if (button.closest('[role="menu"], [role="toolbar"]')) {
        return false;
      }

      if (button.closest('a[href], [role="link"], nav, [role="navigation"]')) {
        return false;
      }

      const closestMenuButton = button.closest('[role="button"][aria-haspopup="menu"]');
      if (isPostActionControl(closestMenuButton)) {
        return false;
      }

      if (button.getAttribute("aria-haspopup") === "menu") {
        return false;
      }

      if (button.querySelector('svg, img, video')) {
        return false;
      }

      const text = normalizeText(button.textContent || button.getAttribute("aria-label"));
      if (!uiMatchers.seeMoreRegex.test(text) && !hasInlineSeeMoreLabel(button, text)) {
        return false;
      }

      const storyMessage = button.closest('[data-ad-rendering-role="story_message"], [data-ad-rendering-role="story_body"]');
      const previewMessage = button.closest('[data-ad-comet-preview="message"]');
      const article = button.closest(
        'div[role="article"], [data-pagelet*="FeedUnit"], [aria-posinset], [data-virtualized]'
      );
      const postContext = article || storyMessage;
      const measurementRoot = storyMessage || previewMessage || postContext;
      if (!postContext || !measurementRoot) {
        return false;
      }

      if (button.closest('[role="dialog"]') && !storyMessage && !previewMessage) {
        return false;
      }

      if (isDialogScope && !storyMessage) {
        return false;
      }

      const hasPostSignals =
        !!storyMessage ||
        hasPostActionControl(postContext) ||
        !!postContext.querySelector('[data-ad-rendering-role="story_message"], [data-ad-rendering-role="story_body"], [data-ad-rendering-role="profile_name"]') ||
        !!postContext.querySelector('h1, h2, h3, h4, [role="heading"]') ||
        !!postContext.querySelector('a[role="link"][href*="/posts/"], a[role="link"][href*="/reel/"], a[role="link"][href*="/groups/"]');

      if (!hasPostSignals) {
        return false;
      }

      if (!storyMessage && !previewMessage && button.closest('[role="list"], [aria-live], ul, ol')) {
        return false;
      }

      const inlineTextContainer = button.parentElement;
      const inlineText = normalizeText(inlineTextContainer?.textContent || "");
      const hasInlineTruncation = uiMatchers.seeMoreRegex.test(inlineText) && (inlineText.includes("...") || inlineText.includes("…"));
      const hasStoryContext =
        (!!storyMessage || !!previewMessage) &&
        !!postContext.querySelector('[data-ad-rendering-role="profile_name"], a[role="link"][href*="/groups/"], a[role="link"][href*="/posts/"]');
      const isInlineStoryMessageButton =
        (!!storyMessage || !!previewMessage) &&
        !button.querySelector('svg, img, video') &&
        (hasInlineTruncation || /line-clamp|webkit-box/i.test(inlineTextContainer?.getAttribute("style") || "") || !!button.closest('[data-ad-comet-preview="message"]'));

      if (isInlineStoryMessageButton && hasStoryContext) {
        return true;
      }

      if (!hasInlineTruncation && !hasStoryContext) {
        return false;
      }

      const buttonRect = button.getBoundingClientRect();
      const measurementRect = measurementRoot.getBoundingClientRect();
      const relativeTop = buttonRect.top - measurementRect.top;

      return relativeTop >= -160 && relativeTop < Math.max(900, measurementRect.height + 120);
    }

    for (const candidate of candidates) {
      const { button, priority } = candidate;

      if (priority === "priority" && priorityClicksThisRun >= maxPriorityClicks) {
        continue;
      }

      if (priority === "generic" && genericClicksThisRun >= maxGenericClicks) {
        continue;
      }

      if (!isLikelyPostExpander(button)) {
        continue;
      }

      if (!pressElement(button)) {
        continue;
      }

      markPostExpanderAttempt(button);
      queueStatIncrement("expandedPosts");

      if (priority === "priority") {
        priorityClicksThisRun += 1;
      } else {
        genericClicksThisRun += 1;
      }
    }
  }

  function isRootGroupFeedPage(url = window.location.href) {
    let parsedUrl;
    try {
      parsedUrl = new URL(url, window.location.href);
    } catch {
      return false;
    }

    if (parsedUrl.origin !== window.location.origin) {
      return false;
    }

    return /^\/groups\/[^/?#]+\/?$/i.test(parsedUrl.pathname);
  }

  function getGroupFeedSortButton(root = document) {
    const scope = root instanceof Element ? root : document;
    const candidates = scope.querySelectorAll('[role="button"][tabindex="0"]');

    for (const candidate of candidates) {
      if (!(candidate instanceof Element) || !isVisible(candidate)) {
        continue;
      }

      const text = normalizeText(
        `${candidate.getAttribute("aria-label") || ""} ${candidate.textContent || ""}`
      );
      if (!text || !/sort group feed by/i.test(text)) {
        continue;
      }

      return candidate;
    }

    return null;
  }

  function getGroupFeedSortValue(button) {
    if (!(button instanceof Element)) {
      return "";
    }

    const headings = button.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], span');
    for (const heading of headings) {
      const text = normalizeText(heading.textContent || heading.getAttribute("aria-label"));
      if (!text || /sort group feed by/i.test(text)) {
        continue;
      }

      return text;
    }

    return normalizeText(button.textContent || button.getAttribute("aria-label"));
  }

  function getGroupFeedSortPopupWrapper(button) {
    if (!(button instanceof Element)) {
      return null;
    }

    const wrappers = document.querySelectorAll('body > div, body > div *');
    const buttonRect = button.getBoundingClientRect();
    let bestMatch = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const wrapper of wrappers) {
      if (!(wrapper instanceof Element) || !isVisible(wrapper)) {
        continue;
      }

      const menu = wrapper.matches('[role="menu"][aria-label="Sort group posts"]')
        ? wrapper
        : wrapper.querySelector?.('[role="menu"][aria-label="Sort group posts"]');
      if (!(menu instanceof Element)) {
        continue;
      }

      const wrapperRect = wrapper.getBoundingClientRect();
      if (wrapperRect.width < 40 || wrapperRect.height < 40) {
        continue;
      }

      const verticalDistance = Math.min(
        Math.abs(wrapperRect.top - buttonRect.bottom),
        Math.abs(wrapperRect.bottom - buttonRect.top)
      );
      const horizontalDistance = Math.min(
        Math.abs(wrapperRect.left - buttonRect.left),
        Math.abs(wrapperRect.right - buttonRect.right),
        Math.abs((wrapperRect.left + wrapperRect.right) / 2 - (buttonRect.left + buttonRect.right) / 2)
      );
      const overlapsHorizontally = wrapperRect.right >= buttonRect.left - 180 && wrapperRect.left <= buttonRect.right + 180;
      const score = verticalDistance + horizontalDistance;

      if (verticalDistance > 520 || !overlapsHorizontally) {
        continue;
      }

      if (score >= bestScore) {
        continue;
      }

      bestScore = score;
      bestMatch = {
        wrapper,
        menu
      };
    }

    return bestMatch;
  }

  function getGroupFeedSortMenu(button) {
    if (!(button instanceof Element)) {
      return null;
    }

    const popup = getGroupFeedSortPopupWrapper(button);
    if (!popup) {
      return null;
    }

    const menus = [popup.menu, ...popup.wrapper.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')];
    for (const menu of menus) {
      if (!(menu instanceof Element) || !isVisible(menu)) {
        continue;
      }

      const items = menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]');
      if (!items.length) {
        continue;
      }

      const menuLabel = normalizeText(menu.getAttribute("aria-label"));
      const itemTexts = Array.from(items).map((item) => normalizeText(item.textContent || item.getAttribute("aria-label")));
      const hasExpectedOptions = itemTexts.some((text) => /^recent activity$/i.test(text)) && itemTexts.some((text) => /^new posts$/i.test(text));
      const isGroupSortMenu = /sort group posts/i.test(menuLabel) || hasExpectedOptions;
      if (!isGroupSortMenu) {
        continue;
      }

      const buttonRect = button.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const verticallyNearby = Math.abs(menuRect.top - buttonRect.bottom) < 420 || Math.abs(menuRect.bottom - buttonRect.top) < 420;
      const horizontallyNearby = Math.abs(menuRect.left - buttonRect.left) < 420 || Math.abs(menuRect.right - buttonRect.right) < 420;
      const overlapsHorizontally = menuRect.right >= buttonRect.left - 80 && menuRect.left <= buttonRect.right + 80;
      if (!(verticallyNearby && overlapsHorizontally) && !horizontallyNearby) {
        continue;
      }

      return {
        wrapper: popup.wrapper,
        menu,
        items: Array.from(items),
        itemTexts,
        menuLabel
      };
    }

    return null;
  }

  function openGroupFeedSortMenu(button) {
    if (!(button instanceof Element) || !isVisible(button)) {
      return false;
    }

    try {
      button.click();
      return true;
    } catch (_error) {
      return pressElement(button);
    }
  }

  function ensureHomeFeedAutomationFrame() {
    if (
      pendingHomeFeedAutomationFrame ||
      !runtimeReady ||
      isFeedAutomationBlocked()
    ) {
      return;
    }

    pendingHomeFeedAutomationFrame = requestAnimationFrame(() => {
      pendingHomeFeedAutomationFrame = 0;
      const shouldFilterSponsored = pendingSponsoredFeedFiltering;
      const shouldExpandPosts = pendingPostExpansion;
      pendingSponsoredFeedFiltering = false;
      pendingPostExpansion = false;

      if (isFeedAutomationBlocked()) {
        pendingHomeFeedRoots.clear();
        return;
      }

      const roots = [...pendingHomeFeedRoots]
        .filter((root) => root === document || root.isConnected);
      pendingHomeFeedRoots.clear();
      if (roots.length === 0) {
        roots.push(document);
      }

      for (const root of roots) {
        if (shouldFilterSponsored && settings?.enableFeedFilter) {
          runSponsoredFeedFiltering(root);
        }
        if (shouldExpandPosts && settings?.enablePostExpansion) {
          expandPostBodies(root);
        }
      }
    });
  }

  function scheduleVisiblePostExpansion() {
    if (
      !runtimeReady ||
      !settings.enablePostExpansion ||
      isFeedAutomationBlocked()
    ) {
      return;
    }

    pendingPostExpansion = true;
    ensureHomeFeedAutomationFrame();
  }

  function sendAntiRefreshDiagnostic(type, detail) {
    if (!canUseExtensionApis()) {
      return;
    }

    try {
      chrome.runtime.sendMessage({ type, detail }).catch((error) => {
        markExtensionContextInvalid(error);
      });
    } catch (error) {
      markExtensionContextInvalid(error);
    }
  }

  function reportPageBoot() {
    if (!settings.enableAntiRefresh) {
      return;
    }

    const navigationEntry = window.performance?.getEntriesByType?.("navigation")?.[0];
    sendAntiRefreshDiagnostic("faceberg:anti-refresh-boot", {
      at: Date.now(),
      documentWasDiscarded: document.wasDiscarded === true,
      navigationType: navigationEntry?.type || "",
      timeOrigin: Number(window.performance?.timeOrigin || 0),
      url: window.location.href
    });
  }

  function activateGroupFeedSortItem(item) {
    if (!(item instanceof Element) || !isVisible(item)) {
      return { activated: false, target: null };
    }

    try {
      item.click();
      return {
        activated: true,
        target: item
      };
    } catch (_error) {
      if (pressElement(item)) {
        return {
          activated: true,
          target: item
        };
      }
    }

    return {
      activated: false,
      target: null
    };
  }

  function clearGroupFeedSortRetry() {
    if (groupFeedSortState.retryFrameId) {
      cancelAnimationFrame(groupFeedSortState.retryFrameId);
      groupFeedSortState.retryFrameId = 0;
    }
    groupFeedSortState.observer?.disconnect();
    groupFeedSortState.observer = null;
  }

  function ensureGroupFeedSortObserver() {
    if (groupFeedSortState.observer || !isRootGroupFeedPage(window.location.href)) {
      return;
    }

    groupFeedSortState.observer = new MutationObserver(() => {
      scheduleGroupFeedSortRetry();
    });
    groupFeedSortState.observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked", "aria-expanded", "aria-selected"]
    });
  }

  function scheduleGroupFeedSortRetry() {
    ensureGroupFeedSortObserver();
    if (groupFeedSortState.retryFrameId) {
      return;
    }

    groupFeedSortState.retryFrameId = requestAnimationFrame(() => {
      groupFeedSortState.retryFrameId = 0;
      if (document.visibilityState === "visible") {
        debouncedRunAll(document);
      }
    });
  }

  function ensureGroupFeedSort(root = document) {
    if (!isRootGroupFeedPage(window.location.href)) {
      clearGroupFeedSortRetry();
      return "unavailable";
    }

    const now = Date.now();
    const targetSort = normalizeGroupFeedSortValue(settings.groupFeedDefaultSort);
    const button = getGroupFeedSortButton(root);
    if (!(button instanceof Element)) {
      ensureGroupFeedSortObserver();
      debugCommentAutomation("group-feed-sort-no-button", {
        target: describeElement(root instanceof Element ? root : document.body),
        url: window.location.href
      });
      return "unavailable";
    }

    const currentValue = getGroupFeedSortValue(button);
    debugCommentAutomation("group-feed-sort-state", {
      target: describeElement(button),
      currentValue,
      root: describeElement(root instanceof Element ? root : document.body),
      url: window.location.href
    });

    if (currentValue === targetSort) {
      groupFeedSortState.interactionUntil = 0;
      clearGroupFeedSortRetry();
      debugCommentAutomation("group-feed-sort-already-target", {
        target: describeElement(button),
        currentValue,
        targetSort
      });
      return "already";
    }

    const openMenu = getGroupFeedSortMenu(button);
    if (openMenu) {
      debugCommentAutomation("group-feed-sort-popup-wrapper-found", {
        target: describeElement(button),
        currentValue,
        wrapper: describeElement(openMenu.wrapper)
      });
      debugCommentAutomation("group-feed-sort-menu-open", {
        target: describeElement(button),
        currentValue,
        targetSort,
        wrapper: describeElement(openMenu.wrapper),
        menu: describeElement(openMenu.menu),
        itemCount: openMenu.items.length,
        menuLabel: openMenu.menuLabel,
        itemTexts: openMenu.itemTexts
      });
      const targetItem = openMenu.items.find((item) => getGroupFeedSortItemLabel(item) === targetSort);
      if (targetItem instanceof Element) {
        if (targetItem.getAttribute("aria-checked") === "true") {
          groupFeedSortState.interactionUntil = 0;
          clearGroupFeedSortRetry();
          debugCommentAutomation("group-feed-sort-already-target", {
            target: describeElement(button),
            currentValue,
            targetSort,
            selectedItem: getGroupFeedSortItemLabel(targetItem)
          });
          return "already";
        }

        if (now - groupFeedSortState.lastSelectionAt < 400) {
          debugCommentAutomation("group-feed-sort-selection-pending", {
            target: describeElement(button),
            currentValue,
            targetSort,
            selectedItem: getGroupFeedSortItemLabel(targetItem)
          });
          return "pending";
        }

        const selectionLabel = getGroupFeedSortItemLabel(targetItem);
        const activationResult = activateGroupFeedSortItem(targetItem);
        if (activationResult.activated) {
          groupFeedSortState.lastSelectionAt = now;
          groupFeedSortState.interactionUntil = now + 1500;
          scheduleGroupFeedSortRetry();
          debugCommentAutomation("group-feed-sort-selection-dispatched", {
            target: describeElement(button),
            currentValue,
            targetSort,
            selectedItem: selectionLabel,
            selectedItemChecked: targetItem.getAttribute("aria-checked"),
            selectedTarget: describeElement(activationResult.target)
          });
          return "pending";
        }

        groupFeedSortState.interactionUntil = now + 800;
        scheduleGroupFeedSortRetry();
        debugCommentAutomation("group-feed-sort-selection-failed", {
          target: describeElement(button),
          currentValue,
          targetSort,
          selectedItem: selectionLabel,
          selectedItemChecked: targetItem.getAttribute("aria-checked"),
          selectedTarget: "<none>"
        });
        return "pending";
      } else {
        debugCommentAutomation("group-feed-sort-no-target-item", {
          target: describeElement(button),
          currentValue,
          targetSort,
          wrapper: describeElement(openMenu.wrapper),
          menu: describeElement(openMenu.menu),
          itemCount: openMenu.items.length,
          menuLabel: openMenu.menuLabel,
          itemTexts: openMenu.itemTexts
        });
      }

      debugCommentAutomation("group-feed-sort-selection-no-change", {
        target: describeElement(button),
        currentValue,
        targetSort,
        wrapper: describeElement(openMenu.wrapper),
        menu: describeElement(openMenu.menu),
        itemCount: openMenu.items.length,
        menuLabel: openMenu.menuLabel,
        itemTexts: openMenu.itemTexts
      });
      return "pending";
    }

    if (groupFeedSortState.interactionUntil > now || now - groupFeedSortState.lastToggleAt < 600) {
      ensureGroupFeedSortObserver();
      debugCommentAutomation("group-feed-sort-toggle-pending", {
        target: describeElement(button),
        currentValue,
        targetSort,
        interactionUntil: groupFeedSortState.interactionUntil,
        msSinceLastToggle: now - groupFeedSortState.lastToggleAt
      });
      return "pending";
    }

    if (openGroupFeedSortMenu(button)) {
      groupFeedSortState.lastToggleAt = now;
      groupFeedSortState.interactionUntil = now + 1500;
      scheduleGroupFeedSortRetry();
      debugCommentAutomation("group-feed-sort-toggle-opened", {
        target: describeElement(button),
        currentValue,
        targetSort
      });
      return "pending";
    }

    debugCommentAutomation("group-feed-sort-toggle-failed", {
      target: describeElement(button),
      currentValue,
      targetSort
    });

    return "unavailable";
  }

  function runAll(root = document) {
    const startedAt = window.performance.now();
    try {
      ensureGroupFeedSort(root);

      const hasDialogContext =
        root === document ||
        (root instanceof Element && (
          !!root.closest('[role="dialog"]') ||
          !!root.querySelector('[role="dialog"]') ||
          !!document.querySelector('[role="dialog"][aria-modal="true"]')
        ));
      const visibleDialog = hasDialogContext ? getVisiblePostDialog(root) : null;
      if (visibleDialog) {
        if (hasPostDialogSignals(visibleDialog) || hasCommentSurfaceSignals(visibleDialog)) {
          expandPostBodies(visibleDialog);
          scheduleCommentAutomationPasses(visibleDialog);
        }
        return;
      }

      if (isMediaViewerPage() && getBlockingMediaViewerOverlay()) {
        return;
      }

      if (isDirectPostPage() || isMediaViewerPage()) {
        expandPostBodies(getDirectPageExpansionRoot(root));
        scheduleCommentAutomationPasses(document);
        return;
      }

      if (isReelExperiencePath()) {
        runSponsoredReelFiltering(root);
        ensureSponsoredReelObserver();
        if (getActiveReelCommentSurface(document)) {
          scheduleCommentAutomationPasses(document);
        }
        return;
      }

      if (getActiveReelCommentSurface(document)) {
        scheduleCommentAutomationPasses(document);
        return;
      }

      if (!ENABLE_HOME_FEED_AUTOMATION) {
        expandPostBodies(root);
        return;
      }

      runFeedCleanup(root);
      expandPostBodies(root);
    } finally {
      const duration = window.performance.now() - startedAt;
      runtimePerformance.runCount += 1;
      runtimePerformance.totalDurationMs += duration;
      runtimePerformance.lastDurationMs = duration;
      runtimePerformance.maxDurationMs = Math.max(runtimePerformance.maxDurationMs, duration);
      runtimePerformance.slowRunCount += Number(duration >= 16);
      if (root === document) {
        runtimePerformance.documentRuns += 1;
      } else {
        runtimePerformance.localRuns += 1;
      }
    }
  }

  function scheduleDocumentPasses() {
    if (!runtimeReady) {
      return;
    }

    const now = Date.now();
    if (now - lastFullDocumentPassAt >= 250) {
      lastFullDocumentPassAt = now;
      runAll(document);
    }
    scheduleStartupStabilizationPasses();
    scheduleSponsoredFeedFiltering();
  }

  async function loadSettings() {
    try {
      const stored = await readSettings();

      settings = {
        enableAntiRefresh: stored.enableAntiRefresh === true,
        enableFeedFilter: stored.enableFeedFilter !== false,
        enablePostExpansion: stored.enablePostExpansion !== false,
        enableCommentSortAll: stored.enableCommentSortAll !== false,
        enableCommentExpansion: stored.enableCommentExpansion !== false,
        enableBlockSponsoredPosts: stored.enableBlockSponsoredPosts !== false,
        enableBlockSponsoredSidebar: stored.enableBlockSponsoredSidebar !== false,
        enableBlockSponsoredReels: stored.enableBlockSponsoredReels !== false,
        enableBlockReels: stored.enableBlockReels !== false,
        enableBlockStories: stored.enableBlockStories !== false,
        enableBlockPeopleYouMayKnow: stored.enableBlockPeopleYouMayKnow !== false,
        enableBlockFollowPosts: stored.enableBlockFollowPosts !== false,
        enableBlockJoinPosts: stored.enableBlockJoinPosts !== false,
        enableCompactHiddenCards: stored.enableCompactHiddenCards !== false,
        enableGoDirectlyToFeeds: stored.enableGoDirectlyToFeeds === true,
        groupFeedDefaultSort: normalizeGroupFeedSortValue(stored.groupFeedDefaultSort)
      };
    } catch (_error) {
      settings = { ...DEFAULT_SETTINGS };
    }

    requestTabProtection();
  }

  if (canUseExtensionApis()) {
    document.addEventListener(ANTI_REFRESH_NAVIGATION_EVENT, (event) => {
      let detail = null;
      try {
        detail = JSON.parse(String(event.detail || ""));
      } catch (_error) {
        return;
      }

      sendAntiRefreshDiagnostic("faceberg:anti-refresh-navigation", detail);
    }, true);

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "faceberg:ping") {
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === "faceberg:rerun") {
        scheduleDocumentPasses();
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === "faceberg:route-changed") {
        handlePotentialUrlChange();
        const armed = armSpaCommentWake(message.url);
        sendResponse({ ok: true, armed });
        return false;
      }

      return false;
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" && areaName !== "local") {
        return;
      }

      let shouldRerun = false;

      if (changes.enableAntiRefresh) {
        settings.enableAntiRefresh = changes.enableAntiRefresh.newValue === true;
        requestTabProtection();
        shouldRerun = true;
      }

      if (changes.enableFeedFilter) {
        settings.enableFeedFilter = changes.enableFeedFilter.newValue !== false;
        if (settings.enableFeedFilter && settings.enableBlockSponsoredSidebar) {
          ensureSponsoredSidebarObserver();
        } else {
          stopSponsoredSidebarObservers();
        }
        ensureSponsoredReelObserver();
        shouldRerun = true;
      }

      if (changes.enablePostExpansion) {
        settings.enablePostExpansion = changes.enablePostExpansion.newValue !== false;
        shouldRerun = true;
      }

      if (changes.enableCommentExpansion) {
        settings.enableCommentExpansion = changes.enableCommentExpansion.newValue !== false;
        shouldRerun = true;
      }

      if (changes.enableCommentSortAll) {
        settings.enableCommentSortAll = changes.enableCommentSortAll.newValue !== false;
        shouldRerun = true;
      }

      if (changes.enableBlockSponsoredPosts) {
        settings.enableBlockSponsoredPosts = changes.enableBlockSponsoredPosts.newValue !== false;
        shouldRerun = true;
      }

      if (changes.enableBlockSponsoredSidebar) {
        settings.enableBlockSponsoredSidebar = changes.enableBlockSponsoredSidebar.newValue !== false;
        if (settings.enableBlockSponsoredSidebar && settings.enableFeedFilter) {
          ensureSponsoredSidebarObserver();
        } else {
          stopSponsoredSidebarObservers();
        }
        shouldRerun = true;
      }

      if (changes.enableBlockSponsoredReels) {
        settings.enableBlockSponsoredReels =
          changes.enableBlockSponsoredReels.newValue !== false;
        ensureSponsoredReelObserver();
        shouldRerun = true;
      }

      if (changes.enableBlockReels) {
        settings.enableBlockReels = changes.enableBlockReels.newValue !== false;
        shouldRerun = true;
      }

      if (changes.enableBlockStories) {
        settings.enableBlockStories = changes.enableBlockStories.newValue !== false;
        shouldRerun = true;
      }

      if (changes.enableBlockPeopleYouMayKnow) {
        settings.enableBlockPeopleYouMayKnow = changes.enableBlockPeopleYouMayKnow.newValue !== false;
        shouldRerun = true;
      }

      if (changes.enableBlockFollowPosts) {
        settings.enableBlockFollowPosts = changes.enableBlockFollowPosts.newValue !== false;
        shouldRerun = true;
      }

      if (changes.enableBlockJoinPosts) {
        settings.enableBlockJoinPosts = changes.enableBlockJoinPosts.newValue !== false;
        shouldRerun = true;
      }

      if (changes.enableCompactHiddenCards) {
        settings.enableCompactHiddenCards = changes.enableCompactHiddenCards.newValue !== false;
        shouldRerun = true;
      }

      if (changes.enableGoDirectlyToFeeds) {
        settings.enableGoDirectlyToFeeds = changes.enableGoDirectlyToFeeds.newValue === true;
        shouldRerun = true;
      }

      if (changes.groupFeedDefaultSort) {
        settings.groupFeedDefaultSort = normalizeGroupFeedSortValue(changes.groupFeedDefaultSort.newValue);
        shouldRerun = true;
      }

      if (shouldRerun) {
        debouncedRunAll(document);
        scheduleSponsoredFeedFiltering();
      }
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) {
      return;
    }

    const data = event.data;
    if (data.source !== "faceberg" || data.kind !== "stat") {
      return;
    }

    if (data.stat === "preventedRefreshes") {
      const increment = Number(data.count || 1);
      queueStatIncrement("preventedRefreshes", increment > 0 ? increment : 1);
    }
  });

  function getScrollSnapshotUrl() {
    return `${window.location.origin}${window.location.pathname}${window.location.search}`;
  }

  function readScrollSnapshots() {
    try {
      const parsed = JSON.parse(window.sessionStorage.getItem(SCROLL_SNAPSHOT_STORAGE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function saveScrollSnapshot() {
    scrollSnapshotTimer = 0;

    try {
      const url = getScrollSnapshotUrl();
      const snapshots = readScrollSnapshots();
      snapshots[url] = {
        x: Math.max(0, Math.round(window.scrollX)),
        y: Math.max(0, Math.round(window.scrollY)),
        at: Date.now()
      };

      const recentEntries = Object.entries(snapshots)
        .filter(([, value]) => value && Date.now() - Number(value.at || 0) <= SCROLL_SNAPSHOT_MAX_AGE_MS)
        .sort((left, right) => Number(right[1].at || 0) - Number(left[1].at || 0))
        .slice(0, 5);
      window.sessionStorage.setItem(SCROLL_SNAPSHOT_STORAGE_KEY, JSON.stringify(Object.fromEntries(recentEntries)));
    } catch (_error) {
      /* Session storage can be unavailable in restricted browsing modes. */
    }
  }

  function scheduleScrollSnapshot() {
    if (Date.now() < scrollRestoreUntil) {
      return;
    }

    if (scrollSnapshotTimer) {
      cancelAnimationFrame(scrollSnapshotTimer);
    }
    scrollSnapshotTimer = requestAnimationFrame(saveScrollSnapshot);
  }

  function scheduleSponsoredFeedFiltering() {
    if (!runtimeReady || isFeedAutomationBlocked()) {
      return;
    }

    if (!settings?.enableFeedFilter) {
      return;
    }

    pendingSponsoredFeedFiltering = true;
    ensureHomeFeedAutomationFrame();
  }

  function restoreRecentScrollSnapshot() {
    const snapshot = readScrollSnapshots()[getScrollSnapshotUrl()];
    if (!snapshot ||
        Date.now() - Number(snapshot.at || 0) > SCROLL_SNAPSHOT_MAX_AGE_MS ||
        Number(snapshot.y || 0) < 80) {
      return;
    }

    const restoreStartedAt = Date.now();
    scrollRestoreUntil = Number.POSITIVE_INFINITY;
    requestAnimationFrame(() => {
      const userTookControl = lastUserScrollIntentAt > restoreStartedAt;
      const maxScrollY = Math.max(
        0,
        (document.documentElement?.scrollHeight || document.body?.scrollHeight || 0) - window.innerHeight
      );
      const targetY = Math.min(Number(snapshot.y || 0), maxScrollY);

      if (
        !userTookControl &&
        document.visibilityState === "visible" &&
        targetY >= 80 &&
        window.scrollY < targetY - 80
      ) {
        window.scrollTo(Number(snapshot.x || 0), targetY);
      }

      scrollRestoreUntil = 0;
      saveScrollSnapshot();
    });
  }

  function noteUserScrollIntent(event) {
    if (event?.isTrusted === true) {
      lastUserScrollIntentAt = Date.now();
    }
  }

  function handlePotentialUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl === lastObservedUrl) {
      return false;
    }

    const previousUrl = lastObservedUrl;
    lastObservedUrl = currentUrl;
    runtimePerformance.spaUrlChanges += 1;
    const previousReelId = getReelRouteId(previousUrl);
    const currentReelId = getReelRouteId(currentUrl);
    const mountedReelSidebar = getVisibleReelCommentSidebar();
    const activeReelCommentToggle = getActiveReelCommentToggle();
    const reelCommentsWereOpen =
      !!mountedReelSidebar ||
      activeReelCommentToggle?.getAttribute("aria-expanded") === "true";
    pendingReelSidebarRefresh =
      previousReelId &&
      currentReelId &&
      previousReelId !== currentReelId &&
      reelCommentsWereOpen &&
      (!mountedReelSidebar || !reelSidebarMatchesRoute(mountedReelSidebar, currentReelId))
        ? { url: currentUrl, reelId: currentReelId, phase: "close" }
        : null;
    if (isPostOrMediaNavigationHref(currentUrl)) {
      commentAutomationSuspended = true;
      pendingSpaCommentUrl = currentUrl;
      tryCompletePendingSpaCommentWake();
    } else {
      pendingSpaCommentUrl = "";
      const closingDialog = getVisiblePostDialog(document);
      if (!suspendCommentAutomationForDialogClose(closingDialog)) {
        commentAutomationSuspended = false;
        debouncedRunAll(document);
      }
    }
    if (window.location.pathname === "/") {
      scheduleFeedAutomationResume();
      ensureSponsoredSidebarObserver();
      ensureHomeFeedObserver();
      scheduleSponsoredFeedFiltering();
    } else {
      homeFeedObserver?.disconnect();
      homeFeedObserver = null;
      observedHomeFeed = null;
    }
    ensureSponsoredReelObserver();

    return true;
  }

  /*
    Facebook commits a post permalink before it replaces the previously opened
    dialog. A one-shot URL wake therefore sees the old dialog, rejects it
    correctly by post identity, and used to stop before the new surface arrived.
    Keep only the expected URL armed and complete the wake on the first DOM
    mutation that exposes a matching post surface.
  */
  function armSpaCommentWake(expectedUrl = window.location.href) {
    const normalizedExpectedUrl = String(expectedUrl || "");
    if (
      !normalizedExpectedUrl ||
      normalizedExpectedUrl !== window.location.href ||
      !isPostOrMediaNavigationHref(normalizedExpectedUrl)
    ) {
      return false;
    }

    pendingSpaCommentUrl = normalizedExpectedUrl;
    return tryCompletePendingSpaCommentWake();
  }

  function tryCompletePendingSpaCommentWake() {
    if (!runtimeReady || !pendingSpaCommentUrl) {
      return false;
    }

    if (window.location.href !== pendingSpaCommentUrl) {
      pendingSpaCommentUrl = "";
      return false;
    }

    const dialog = getVisiblePostDialog(document);
    if (dialog instanceof Element) {
      pendingSpaCommentUrl = "";
      feedAutomationSuspended = false;
      commentAutomationSuspended = false;
      debouncedRunAll(dialog);
      return true;
    }

    /* Reel links participate in the same SPA wake path as post/media links,
       but their comments render in an adjacent non-dialog surface. Resume as
       soon as the isolated Reel resolver can identify that surface; otherwise
       pendingSpaCommentUrl leaves comment automation suspended indefinitely. */
    const reelSurface = isReelExperiencePath()
      ? getActiveReelCommentSurface(document)
      : null;
    if (reelSurface instanceof Element) {
      pendingSpaCommentUrl = "";
      pendingReelSidebarRefresh = null;
      feedAutomationSuspended = false;
      commentAutomationSuspended = false;
      debouncedRunAll(reelSurface);
      return true;
    }

    if (isReelExperiencePath() && recoverStaleReelSidebar()) {
      return false;
    }

    /*
      A direct permalink can render as a page rather than a modal. Do not use
      this fallback while any modal is visible, because that modal may still be
      the stale feed post Facebook is in the process of replacing.
    */
    if (
      !hasVisibleModalDialog() &&
      (isDirectPostPage() || isMediaViewerPage()) &&
      runCommentAutomation(document)
    ) {
      pendingSpaCommentUrl = "";
      feedAutomationSuspended = false;
      commentAutomationSuspended = false;
      expandPostBodies(getDirectPageExpansionRoot(document));
      scheduleCommentAutomationPasses(document);
      return true;
    }

    return false;
  }

  function watchForDialogClose(dialog) {
    if (!(dialog instanceof Element)) {
      return;
    }

    closeDialogObserver?.disconnect();
    const checkClosed = () => {
      if (dialog.isConnected && isVisible(dialog)) {
        return;
      }

      closeDialogObserver?.disconnect();
      closeDialogObserver = null;
      commentAutomationSuspended = false;
      if (window.location.pathname === "/" && !hasVisibleModalDialog()) {
        scheduleFeedAutomationResume();
        ensureSponsoredSidebarObserver();
        ensureHomeFeedObserver();
      }
    };

    closeDialogObserver = new MutationObserver(checkClosed);
    closeDialogObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "hidden", "style"]
    });
  }

  function startRuntime() {
    if (runtimeReady) {
      return;
    }

    runtimeReady = true;
    runtimePerformance.runtimeStartedAt = Date.now();
    restoreRecentScrollSnapshot();
    ensureSponsoredSidebarObserver();
    ensureSponsoredReelObserver();
    ensureHomeFeedObserver();
    if (!(observedHomeFeed instanceof Element)) {
      runImmediateSponsoredFeedFiltering(document, "startup-fallback");
    }
    scheduleDocumentPasses();
  }

  loadSettings().then(() => {
    reportPageBoot();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startRuntime, { once: true });
    } else {
      startRuntime();
    }
  });

  window.addEventListener("load", () => {
    if (runtimeReady) {
      scheduleDocumentPasses();
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (runtimeReady && event.persisted === true) {
      scheduleDocumentPasses();
    }
  });
  window.addEventListener("popstate", () => {
    handlePotentialUrlChange();
  });
  window.addEventListener("hashchange", () => {
    handlePotentialUrlChange();
  });
    window.addEventListener("scroll", () => {
      scheduleScrollSnapshot();
      scheduleSponsoredFeedFiltering();
      scheduleVisiblePostExpansion();
    }, { passive: true });
    window.addEventListener("resize", () => {
      scheduleSponsoredFeedFiltering();
      scheduleVisiblePostExpansion();
    }, { passive: true });
  window.addEventListener("wheel", noteUserScrollIntent, { capture: true, passive: true });
  window.addEventListener("touchstart", noteUserScrollIntent, { capture: true, passive: true });
  window.addEventListener("pointerdown", (event) => {
    const closeControl = event.target instanceof Element
      ? event.target.closest('[role="button"][aria-label="Close" i]')
      : null;
    if (closeControl) {
      const closingDialog =
        closeControl.closest('[role="dialog"]') ||
        getVisiblePostDialog(document);
      if (suspendCommentAutomationForDialogClose(closingDialog)) {
        return;
      }
    }

    if (shouldWakeCommentRuntimeFromClick(event)) {
      suspendFeedAutomationForNavigation();
    } else if (isTrustedFeedCardInteraction(event)) {
      cancelPendingFeedAutomation();
    }
  }, { capture: true, passive: true });
  window.addEventListener("pointerdown", noteUserScrollIntent, { capture: true, passive: true });
  window.addEventListener("keydown", noteUserScrollIntent, { capture: true, passive: true });
  window.addEventListener("pagehide", saveScrollSnapshot);
  document.addEventListener("click", (event) => {
    if (shouldWakeCommentRuntimeFromClick(event)) {
      suspendFeedAutomationForNavigation();
      scheduleUserInitiatedCommentWake();
      return;
    }

    const closeControl = event.target instanceof Element
      ? event.target.closest('[role="button"][aria-label="Close" i]')
      : null;
    const closingDialog =
      closeControl?.closest('[role="dialog"]') ||
      (closeControl ? getVisiblePostDialog(document) : null);
    if (closingDialog) {
      suspendCommentAutomationForDialogClose(closingDialog);
    }
  }, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveScrollSnapshot();
    }
    if (document.visibilityState === "visible") {
      ensureSponsoredSidebarObserver();
      ensureSponsoredReelObserver();
      ensureHomeFeedObserver();
      runImmediateSponsoredFeedFiltering(
        observedHomeFeed || document,
        "visibility-visible"
      );
      handlePotentialUrlChange();
    }
  });
  document.addEventListener(SPA_NAVIGATION_EVENT, () => {
    handlePotentialUrlChange();
    armSpaCommentWake();
  }, true);

  /*
    Facebook can replace the current permalink through its SPA router without
    emitting popstate/hashchange/currententrychange in the content-script
    world. This observer deliberately performs only an O(1) URL comparison;
    unlike the retired global observer, it never scans mutation records or
    feed nodes. A real route change schedules one coalesced document pass.
  */
  const spaUrlObserver = new MutationObserver(() => {
    if (!runtimeReady) {
      return;
    }

    runtimePerformance.spaMutationBatches += 1;
    handlePotentialUrlChange();
    if (
      isReelExperiencePath() &&
      (!observedSponsoredReelRoot?.isConnected || !sponsoredReelObserver)
    ) {
      ensureSponsoredReelObserver();
    }
    if (pendingSpaCommentUrl) {
      runtimePerformance.spaRouteWaitBatches += 1;
      tryCompletePendingSpaCommentWake();
    }
  });
  spaUrlObserver.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-hidden", "aria-modal", "href", "role"]
  });

  const observer = new MutationObserver((mutations) => {
    if (!runtimeReady) {
      return;
    }

    const addedElements = [];
    const addedDialogs = [];
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) {
          if (node.nodeType === 3 && mutation.target instanceof Element) {
            addedElements.push(mutation.target);
          }
          continue;
        }

        addedElements.push(node);
        if (node.matches('[role="dialog"]')) {
          addedDialogs.push(node);
        }
        addedDialogs.push(...node.querySelectorAll('[role="dialog"]'));
      }
    }
    if (addedElements.length === 0) return;
    runtimePerformance.mutationBatches += 1;
    runtimePerformance.mutationRecords += mutations.length;
    runtimePerformance.addedElements += addedElements.length;

    /* Facebook frequently nests a full-screen shell dialog around the actual
       aria-modal post dialog. Always choose the deepest modal so one comment
       surface cannot acquire two competing automation controllers. */
    const visibleDialogs = [...new Set(addedDialogs)]
      .filter((dialog) => dialog.isConnected && isVisible(dialog))
      .sort((left, right) => {
        const modalDifference = Number(right.getAttribute("aria-modal") === "true") -
          Number(left.getAttribute("aria-modal") === "true");
        if (modalDifference !== 0) {
          return modalDifference;
        }

        const getDepth = (element) => {
          let depth = 0;
          for (let current = element.parentElement; current; current = current.parentElement) {
            depth += 1;
          }
          return depth;
        };
        return getDepth(right) - getDepth(left);
      });
    const addedDialog = visibleDialogs[0];
    if (addedDialog) {
      debouncedRunAll(addedDialog);
      return;
    }

    const connectedElements = addedElements.filter((element) => element.isConnected);
    for (const element of connectedElements) {
      debouncedRunAll(element);
    }
  });

  if (ENABLE_GLOBAL_PAGE_MUTATION_OBSERVER) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  if (window.navigation?.addEventListener) {
    window.navigation.addEventListener("currententrychange", handlePotentialUrlChange);
  }
})();
