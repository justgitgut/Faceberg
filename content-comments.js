(() => {
  "use strict";

  if (globalThis.FacebergCommentsRuntime) {
    return;
  }

  const contentUtils = globalThis.FacebergContentUtils;
  const contentDebug = globalThis.FacebergContentDebug;
  if (!contentUtils || !contentDebug) {
    return;
  }

  const {
    uiMatchers,
    normalizeText,
    matchesSorterToggleText,
    isPostActionControl,
    hasPostActionControl,
    isVisible,
    pressElement,
    getRuntimeSettings,
    queueRuntimeStatIncrement
  } = contentUtils;
  const {
    describeElement,
    debugCommentAutomation
  } = contentDebug;

  const clickedElements = new WeakSet();
  const commentExpansionAttemptState = new WeakMap();
  const activeExpansionWatchers = new WeakMap();
  const commentFilterAttemptState = new WeakMap();
  const COMMENT_INTENT_REQUEST_EVENT = "__facebergCommentIntentRequestV7";
  const COMMENT_INTENT_RESULT_EVENT = "__facebergCommentIntentResultV7";
  const commentIntentBridgeResults = new Map();
  let commentIntentRequestSequence = 0;
  const COMMENT_FILTER_MAX_SELECTION_ATTEMPTS = 2;
  const COMMENT_FILTER_SELECTION_WINDOW_MS = 1200;

  function isCommentAutomationSuspended(deps = {}) {
    try {
      return deps?.isCommentAutomationSuspended?.() === true;
    } catch {
      return true;
    }
  }

  document.addEventListener(COMMENT_INTENT_RESULT_EVENT, (event) => {
    try {
      const result = JSON.parse(String(event.detail || ""));
      if (result?.requestId) {
        commentIntentBridgeResults.set(String(result.requestId), result);
      }
    } catch {
      /* Ignore malformed or unrelated page events. */
    }
  }, true);

  function getPrimaryControlText(control) {
    if (!(control instanceof Element)) {
      return "";
    }

    const labelCandidates = [control, ...control.querySelectorAll("span, div")]
      .filter((candidate) => candidate instanceof Element)
      .filter((candidate) => isVisible(candidate))
      .map((candidate) => normalizeText(candidate.textContent || candidate.getAttribute("aria-label")))
      .filter((text) => text && text.length <= 80)
      .sort((left, right) => left.length - right.length);

    return labelCandidates[0] || normalizeText(control.textContent || control.getAttribute("aria-label"));
  }

  function isReplySummaryText(text) {
    return /^view all \d+ replies$/i.test(text) ||
      /^(?:view|see|show)\s+(?:all\s+)?\d*\s*(?:more\s+|previous\s+)?(?:repl(?:y|ies)|responses?|answers?)$/i.test(text) ||
      /^\d+\s+(?:more\s+)?(?:repl(?:y|ies)|responses?|answers?)$/i.test(text);
  }

  function isCommentTextSeeMoreControl(control) {
    if (
      !(control instanceof Element) ||
      !isVisible(control) ||
      normalizeText(
        control.textContent ||
        control.getAttribute("aria-label")
      ) !== "see more" ||
      !control.matches('button, [role="button"]') ||
      control.closest('a[href], [role="menu"], [role="toolbar"]') ||
      control.getAttribute("aria-haspopup") === "menu"
    ) {
      return false;
    }

    const article = control.closest('div[role="article"]');
    if (!(article instanceof Element)) {
      return false;
    }

    const articleLabel = normalizeText(article.getAttribute("aria-label"));
    const isCommentArticle =
      articleLabel.startsWith("comment by ") ||
      articleLabel.startsWith("reply by ");
    if (
      !isCommentArticle ||
      hasPostActionControl(article) ||
      !article.querySelector('a[href*="comment_id"]')
    ) {
      return false;
    }

    /*
      Facebook places the exact comment-text expander in the same small text
      wrapper as the ellipsis. Requiring that local truncation signal avoids
      touching Reel captions, navigation "See more" buttons, or post bodies.
    */
    const textWrapper = control.parentElement;
    const wrapperText = normalizeText(textWrapper?.textContent);
    return (
      textWrapper instanceof Element &&
      textWrapper.closest('div[role="article"]') === article &&
      /(?:…|\.{3})\s*see more$/.test(wrapperText)
    );
  }

  function watchSurfaceMutations(surface, callback) {
    if (!(surface instanceof Element) || !document.contains(surface)) {
      return null;
    }

    let rafId = 0;
    let done = false;

    function stop() {
      if (done) {
        return;
      }

      done = true;
      observer.disconnect();
      bodyObserver.disconnect();
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }

    function schedule() {
      if (done || rafId) {
        return;
      }

      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (done || !document.contains(surface)) {
          stop();
          return;
        }
        callback(surface);
      });
    }

    const observer = new MutationObserver((mutations) => {
      const onlyComposerMutations = mutations.every((mutation) => {
        return mutation.target instanceof Element &&
          !!mutation.target.closest(
            'input, textarea, [contenteditable="true"], [role="textbox"]'
          );
      });
      if (!onlyComposerMutations) {
        schedule();
      }
    });
    observer.observe(surface, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "aria-checked", "aria-selected", "role", "hidden", "style"]
    });

    const bodyObserver = new MutationObserver((mutations) => {
      if (!surface.isConnected) {
        stop();
        return;
      }

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            (node.querySelector('[role="menu"]') || node.matches('[role="menu"]'))
          ) {
            schedule();
            return;
          }
        }
      }
    });
    bodyObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });

    return { stop };
  }

  function isDirectPostPage() {
    const path = String(window.location.pathname || "");
    return /\/permalink\/|\/posts\/|\/story\.php/i.test(path);
  }

  function getPostRouteIdentity(href = window.location.href) {
    try {
      const url = new URL(href, window.location.href);
      const path = url.pathname;
      let match = path.match(/\/groups\/([^/]+)\/(?:permalink|posts)\/([^/]+)/i);
      if (match) {
        return `group:${match[1]}:post:${match[2]}`;
      }

      match = path.match(/\/([^/]+)\/posts\/([^/]+)/i);
      if (match) {
        return `profile:${match[1]}:post:${match[2]}`;
      }

      match = path.match(/\/permalink\/([^/]+)/i);
      if (match) {
        return `post:${match[1]}`;
      }

      if (/\/story\.php/i.test(path)) {
        const storyId = url.searchParams.get("story_fbid");
        if (storyId) {
          return `post:${storyId}`;
        }
      }
    } catch {
      /* Fail closed when a candidate URL cannot be parsed. */
    }

    return "";
  }

  function surfaceMatchesCurrentPostRoute(surface) {
    if (!(surface instanceof Element) || !isDirectPostPage()) {
      return true;
    }

    const currentIdentity = getPostRouteIdentity(window.location.href);
    if (!currentIdentity) {
      return false;
    }

    return [...surface.querySelectorAll("a[href]")].some((link) => {
      const rawHref = link.getAttribute("href") || "";
      if (/\/(?:permalink|posts)\/|\/story\.php/i.test(rawHref)) {
        return getPostRouteIdentity(rawHref) === currentIdentity;
      }

      /*
        In Facebook's SPA post modal, the post's own timestamp/story links can
        be query-only hrefs. Their resolved URL still identifies the active
        route, while comment permalinks retain a different explicit post path.
        Accept this exact-self form only in the deepest modal dialog so a
        query-only link in the mounted Home feed cannot validate a stale page
        surface during notification navigation.
      */
      if (
        surface.matches('[role="dialog"][aria-modal="true"]') &&
        /^[?#]/.test(rawHref)
      ) {
        return getPostRouteIdentity(link.href) === currentIdentity;
      }

      return false;
    });
  }

  function getActiveEditableElement() {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof Element)) {
      return null;
    }

      if (activeElement.closest('[contenteditable="true"][role="textbox"], textarea')) {
      return activeElement;
    }

    return null;
  }

  function isCommentComposerActive(surface = null) {
    const activeElement = getActiveEditableElement();
    if (!(activeElement instanceof Element)) {
      return false;
    }

    const composer = activeElement.closest('[contenteditable="true"][role="textbox"], textarea');
    if (!(composer instanceof Element)) {
      return false;
    }

    const rawComposerText = normalizeText(composer.textContent || "");
    const rawActiveText = normalizeText(activeElement?.textContent || "");
    const controlValue =
      "value" in composer && typeof composer.value === "string"
        ? normalizeText(composer.value)
        : "";
    const hasUserInput =
      controlValue.length > 0 ||
      rawComposerText.length > 0 ||
      rawActiveText.length > 0;

    return (!(surface instanceof Element) || surface.contains(composer)) && hasUserInput;
  }

  function isMediaViewerPage() {
    const path = String(window.location.pathname || "");
    return /\/photo\/|\/watch\//i.test(path);
  }

  function isReelExperiencePage() {
    const path = String(window.location.pathname || "");
    return /\/reel(?:s)?(?:\/|$)/i.test(path);
  }

  function getViewportVisibilityScore(element) {
    if (!(element instanceof Element) || !isVisible(element)) {
      return 0;
    }

    const rect = element.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return 0;
    }

    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));

    if (visibleWidth <= 0 || visibleHeight <= 0) {
      return 0;
    }

    return Math.round((visibleWidth * visibleHeight) / 1000);
  }

  function hasVisibleLargeReelMedia(surface) {
    if (!(surface instanceof Element) || !isVisible(surface)) {
      return false;
    }

    return [...surface.querySelectorAll("video")].some((video) => {
      if (!(video instanceof Element) || !isVisible(video)) {
        return false;
      }

      const rect = video.getBoundingClientRect();
      return rect.width >= 220 && rect.height >= 280;
    });
  }

  function hasReelNavigationSignals(surface) {
    if (!(surface instanceof Element) || !isVisible(surface)) {
      return false;
    }

    return !!surface.querySelector('a[role="link"][href*="/reel/"], a[href*="/reel/"]');
  }

  function hasReelsLabelSignals(surface) {
    if (!(surface instanceof Element) || !isVisible(surface)) {
      return false;
    }

    const ownLabel = normalizeText(surface.getAttribute("aria-label"));
    if (ownLabel === "reels" || ownLabel.startsWith("reels ")) {
      return true;
    }

    return [...surface.querySelectorAll('h1, h2, h3, h4, [role="heading"], [role="tab"], [aria-label]')].some((candidate) => {
      if (!(candidate instanceof Element) || !isVisible(candidate)) {
        return false;
      }

      const text = normalizeText(candidate.textContent || candidate.getAttribute("aria-label"));
      return text === "reels" || text.startsWith("reels ");
    });
  }

  function isActiveReelContextCandidate(surface) {
    if (!(surface instanceof Element) || !isVisible(surface)) {
      return false;
    }

    if (!surface.matches('div[role="article"], [data-pagelet], main, [role="main"]')) {
      return false;
    }

    if (surface.closest('[role="dialog"]')) {
      return false;
    }

    if (!hasVisibleLargeReelMedia(surface)) {
      return false;
    }

    return isReelExperiencePage() || hasReelNavigationSignals(surface) || hasReelsLabelSignals(surface);
  }

  function chooseBestScopedCandidate(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.top - right.top;
    });

    const best = candidates[0] || null;
    const second = candidates[1] || null;
    if (!best) {
      return null;
    }

    if (!second) {
      return best.surface;
    }

    const nested = best.surface.contains(second.surface) || second.surface.contains(best.surface);
    if (nested || best.score - second.score >= 45) {
      return best.surface;
    }

    return null;
  }

  function getActiveReelContext(root = document) {
    if (!isReelExperiencePage()) {
      return null;
    }

    const scopeElement = root instanceof Element ? root : document.body;
    const selectors = 'div[role="article"], [data-pagelet], main, [role="main"]';
    const seen = new Set();
    const candidates = [];

    function addCandidate(surface, bias = 0) {
      if (!(surface instanceof Element) || seen.has(surface) || !isActiveReelContextCandidate(surface)) {
        return;
      }

      seen.add(surface);

      let score = bias;
      if (scopeElement instanceof Element && surface === scopeElement) {
        score += 120;
      }
      if (scopeElement instanceof Element && surface.contains(scopeElement)) {
        score += 60;
      }
      if (scopeElement instanceof Element && scopeElement.contains(surface)) {
        score += 30;
      }
      if (surface.matches('main, [role="main"]')) {
        score += 40;
      }
      if (hasReelNavigationSignals(surface)) {
        score += 100;
      }
      if (hasReelsLabelSignals(surface)) {
        score += 45;
      }
      if (hasCommentSurfaceSignals(surface)) {
        score += 55;
      }

      const relatedCommentSurface = [...surface.querySelectorAll('[role="complementary"], div[role="article"], [data-pagelet], main, [role="main"]')]
        .find((candidate) => candidate instanceof Element && isVisible(candidate) && hasCommentSurfaceSignals(candidate));
      if (relatedCommentSurface) {
        score += 50;
      }

      const visibilityScore = getViewportVisibilityScore(surface);
      score += Math.min(140, visibilityScore);

      const rect = surface.getBoundingClientRect();
      candidates.push({
        surface,
        score,
        top: Number.isFinite(rect?.top) ? rect.top : Number.POSITIVE_INFINITY
      });
    }

    if (scopeElement instanceof Element) {
      addCandidate(scopeElement.closest(selectors), 110);
      if (scopeElement.matches(selectors)) {
        addCandidate(scopeElement, 90);
      }
      scopeElement.querySelectorAll?.(selectors).forEach((surface) => addCandidate(surface, 20));
    }

    document.querySelectorAll('video, a[href*="/reel/"]').forEach((node) => {
      if (!(node instanceof Element) || !isVisible(node)) {
        return;
      }

      addCandidate(node.closest(selectors), 35);
    });

    document.querySelectorAll(selectors).forEach((surface) => addCandidate(surface, 5));
    return chooseBestScopedCandidate(candidates);
  }

  function getActiveReelCommentSurface(root = document) {
    if (!isReelExperiencePage()) {
      return null;
    }

    const reelContext = getActiveReelContext(root);
    if (!(reelContext instanceof Element)) {
      return null;
    }

    const scopeElement = root instanceof Element ? root : reelContext;
    const seen = new Set();
    const candidates = [];
    const selectors = '[role="complementary"], div[role="article"], [data-pagelet], main, [role="main"]';

    function addCandidate(surface, bias = 0) {
      if (!(surface instanceof Element) || seen.has(surface) || !isVisible(surface) || !hasCommentSurfaceSignals(surface)) {
        return;
      }

      if (surface.closest('[role="dialog"]')) {
        return;
      }

      if (!(reelContext.contains(surface) || surface.contains(reelContext) || surface.parentElement === reelContext.parentElement)) {
        return;
      }

      seen.add(surface);

      let score = bias;
      if (surface === reelContext) {
        score += 60;
      }
      if (surface.matches('[role="complementary"]')) {
        score += 95;
      }
      if (surface.matches('main, [role="main"], [data-pagelet]')) {
        score += 50;
      }
      if (scopeElement instanceof Element && surface === scopeElement) {
        score += 80;
      }
      if (scopeElement instanceof Element && surface.contains(scopeElement)) {
        score += 35;
      }
      if (scopeElement instanceof Element && scopeElement.contains(surface)) {
        score += 20;
      }

      const sorterToggle = getCommentSorterToggle(surface);
      if (sorterToggle instanceof Element) {
        score += 100;
      }

      if (surface.querySelector('[contenteditable="true"][role="textbox"], textarea')) {
        score += 65;
      }

      if (surface.querySelector('[role="list"], [aria-live], ul, ol')) {
        score += 40;
      }

      if (hasVisibleLargeReelMedia(surface)) {
        score -= 15;
      }

      const rect = surface.getBoundingClientRect();
      score += Math.min(120, getViewportVisibilityScore(surface));

      candidates.push({
        surface,
        score,
        top: Number.isFinite(rect?.top) ? rect.top : Number.POSITIVE_INFINITY
      });
    }

    addCandidate(reelContext, 80);
    reelContext.querySelectorAll(selectors).forEach((surface) => addCandidate(surface, 20));

    if (reelContext.parentElement instanceof Element) {
      reelContext.parentElement.querySelectorAll(':scope > [role="complementary"], :scope > div[role="article"], :scope > [data-pagelet], :scope > main, :scope > [role="main"]').forEach((surface) => addCandidate(surface, 25));
    }

    return chooseBestScopedCandidate(candidates);
  }

  function isReelCommentSurface(surface) {
    if (!(surface instanceof Element) || !isVisible(surface) || !isReelExperiencePage()) {
      return false;
    }

    const activeSurface = getActiveReelCommentSurface(surface);
    return activeSurface === surface;
  }

  function isDirectPageCommentSurface(surface) {
    if (!(surface instanceof Element) || !isVisible(surface)) {
      return false;
    }

    if (isMediaViewerPage()) {
      if (!surface.matches('[role="complementary"], div[role="article"], [data-pagelet], main, [role="main"]')) {
        return false;
      }

      return hasCommentSurfaceSignals(surface);
    }

    if (!isDirectPostPage()) {
      return false;
    }

    if (!surface.matches('div[role="article"], [data-pagelet], main, [role="main"]')) {
      return false;
    }

    return hasCommentSurfaceSignals(surface);
  }

  function isMediaViewerSurface(surface) {
    if (!(surface instanceof Element) || !surface.matches('[role="dialog"]')) {
      return false;
    }

    const dialogLabel = normalizeText(surface.getAttribute("aria-label"));
    if (/\b(photo|image|video|media)\b/i.test(dialogLabel)) {
      return true;
    }

    if (!isMediaViewerPage()) {
      return false;
    }

    return [...surface.querySelectorAll("img, video")].some((media) => {
      if (!(media instanceof Element) || !isVisible(media)) {
        return false;
      }

      const rect = media.getBoundingClientRect();
      return rect.width >= 260 && rect.height >= 180;
    });
  }

  function isIgnoredDialog(surface) {
    if (!(surface instanceof Element) || !surface.matches('[role="dialog"]')) {
      return false;
    }

    const dialogLabel = normalizeText(surface.getAttribute("aria-label"));
    if (/notifications|messenger|search|create post/i.test(dialogLabel)) {
      return true;
    }

    /*
      Facebook can leave the Home feed and a comment composer mounted behind a
      failed post route. The composer alone otherwise makes that error dialog
      look automatable. Never interact with an unavailable/error surface.
    */
    return [...surface.querySelectorAll('h1, h2, h3, [role="heading"]')].some((heading) => {
      const text = normalizeText(heading.textContent || heading.getAttribute("aria-label"));
      return text === "this page isn't available right now" ||
        text === "this content isn't available right now" ||
        text === "content not available";
    });
  }

  function hasPostDialogSignals(surface) {
    if (!(surface instanceof Element) || !surface.matches('[role="dialog"]')) {
      return false;
    }

    return (
      hasPostActionControl(surface) ||
      !!surface.querySelector(
        '[data-ad-rendering-role="story_message"], ' +
        '[data-ad-rendering-role="story_body"], ' +
        '[data-ad-rendering-role="profile_name"], ' +
        '[data-ad-rendering-role="comment_button"], ' +
        'a[aria-label="hide post"], ' +
        'a[role="link"][href*="/permalink/"], ' +
        'a[role="link"][href*="/posts/"], ' +
        'a[role="link"][href*="/story.php"], ' +
        '[role="list"] [role="article"], ' +
        '[aria-live] [role="article"]'
      )
    );
  }

  function hasAutomatableDialogSignals(surface) {
    if (!(surface instanceof Element) || !surface.matches('[role="dialog"]')) {
      return false;
    }

    /* Feed dialogs require real post signals. Media dialogs are only valid when
       comments are visibly present; otherwise photo viewers can hijack dialog resolution. */
    return hasPostDialogSignals(surface) || (isMediaViewerSurface(surface) && hasCommentSurfaceSignals(surface));
  }

  function getCanonicalDialog(surface) {
    if (!(surface instanceof Element)) {
      return null;
    }

    const rootDialog = surface.matches('[role="dialog"]')
      ? surface
      : surface.closest('[role="dialog"]');
    if (!(rootDialog instanceof Element)) {
      return null;
    }

    const dialogs = [rootDialog, ...rootDialog.querySelectorAll('[role="dialog"]')]
      .filter((dialog, index, values) => {
        return values.indexOf(dialog) === index && isVisible(dialog) && !isIgnoredDialog(dialog);
      });
    if (dialogs.length === 0) {
      return null;
    }

    const modalDialog = [...dialogs]
      .reverse()
      .find((dialog) => dialog.getAttribute("aria-modal") === "true");
    return modalDialog || dialogs[dialogs.length - 1];
  }

  function getTopVisibleDialog(root = document) {
    const scopedElement = root instanceof Element ? root : null;
    const scopedDialog = scopedElement ? scopedElement.closest('[role="dialog"]') : null;
    const canonicalScopedDialog = scopedDialog ? getCanonicalDialog(scopedDialog) : null;
    if (
      canonicalScopedDialog &&
      (!isMediaViewerSurface(canonicalScopedDialog) || hasCommentSurfaceSignals(canonicalScopedDialog))
    ) {
      return canonicalScopedDialog;
    }

    const visibleDialogs = [...document.querySelectorAll('[role="dialog"]')]
      .filter((dialog) => isVisible(dialog) && !isIgnoredDialog(dialog));
    const modalDialogs = visibleDialogs.filter((dialog) => dialog.getAttribute("aria-modal") === "true");
    const dialogs = [...(modalDialogs.length > 0 ? modalDialogs : visibleDialogs)].reverse();
    return dialogs.find((dialog) => {
      if (!isMediaViewerSurface(dialog)) {
        return true;
      }
      /* Allow media viewer dialogs that also contain comment UI
         (e.g. photo lightbox with an inline comment section). */
      return hasCommentSurfaceSignals(dialog);
    }) || null;
  }

  function getBlockingMediaViewerOverlay() {
    const visibleDialogs = [...document.querySelectorAll('[role="dialog"]')]
      .filter((dialog) => isVisible(dialog) && !isIgnoredDialog(dialog));
    const modalDialogs = visibleDialogs.filter((dialog) => dialog.getAttribute("aria-modal") === "true");
    const topVisibleDialog = [...(modalDialogs.length > 0 ? modalDialogs : visibleDialogs)].reverse()[0] || null;

    if (topVisibleDialog && isMediaViewerSurface(topVisibleDialog) && !hasCommentSurfaceSignals(topVisibleDialog)) {
      return topVisibleDialog;
    }

    return null;
  }

  function getVisiblePostDialog(root = document) {
    const visibleDialog = getTopVisibleDialog(root);
    /* Only real post dialogs or media viewer dialogs with inline comments should
       suppress normal feed handling; unrelated overlays otherwise hijack comment automation. */
    if (
      visibleDialog &&
      surfaceMatchesCurrentPostRoute(visibleDialog) &&
      hasAutomatableDialogSignals(visibleDialog)
    ) {
      return visibleDialog;
    }

    if (!(root instanceof Element)) {
      return null;
    }

    /* If the topmost visible overlay is a media viewer without comment UI yet,
       do not fall back to older dialogs underneath it or a previously viewed post
       dialog can be re-targeted when the user simply opens a photo. */
    if (getBlockingMediaViewerOverlay()) {
      return null;
    }

    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      .map((dialog) => getCanonicalDialog(dialog))
      .filter((dialog, index, values) => {
        return dialog &&
          values.indexOf(dialog) === index &&
          surfaceMatchesCurrentPostRoute(dialog) &&
          hasAutomatableDialogSignals(dialog);
      })
      .reverse();
    return dialogs[0] || null;
  }

  function isCommentHintControl(control) {
    if (!(control instanceof Element) || !isVisible(control)) {
      return false;
    }

    if (control.closest('[role="menu"], [role="toolbar"]')) {
      return false;
    }

    const text = normalizeText(control.textContent || control.getAttribute("aria-label"));
    return (
      !!control.querySelector('[data-ad-rendering-role="comment_button"]') ||
      uiMatchers.commentSummaryRegex.test(text) ||
      uiMatchers.loadMoreCommentRegex.test(text) ||
      uiMatchers.moreCommentRegex.test(text) ||
      isReplySummaryText(text) ||
      isCommentTextSeeMoreControl(control)
    );
  }

    /* Facebook uses focus and selection separately inside the comment-ordering popup.
      A focused row often has tabindex="0" even when it is not the chosen sort option,
      so only aria-checked / aria-selected are trusted here. If this regresses, do not
      reintroduce tabindex-based selection checks or the code will start treating
      "Newest" as already selected again. */
    function isMenuItemSelected(item) {
    if (!(item instanceof Element)) {
      return false;
    }

    return (
      item.getAttribute("aria-checked") === "true" ||
      item.getAttribute("aria-selected") === "true"
    );
  }

    /* Facebook menu rows often concatenate a short label with a long descriptive sentence.
      Matching against the full text caused false positives such as:
      "Newest ... show all comments with the newest comments first".
      This helper intentionally prefers the shortest stable label-like fragment so
      downstream matching can target the actual option name rather than the description. */
    function getMenuItemMatchText(item) {
    if (!(item instanceof Element)) {
      return "";
    }

    const ariaLabel = normalizeText(item.getAttribute("aria-label"));
    if (ariaLabel) {
      return ariaLabel;
    }

    const candidateTexts = [item, ...item.querySelectorAll("span, div")]
      .filter((candidate) => candidate instanceof Element)
      .map((candidate) => normalizeText(candidate.textContent || candidate.getAttribute("aria-label")))
      .filter((text) => text && text.length <= 80)
      .sort((left, right) => left.length - right.length);

    return candidateTexts[0] || normalizeText(item.textContent || item.getAttribute("aria-label"));
  }

  function matchesAllCommentsText(text) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      return false;
    }

    return /^all comments(?:\b|\s|[.,!?;:()\[\]{}])/.test(normalizedText);
  }

  function matchesFilterOptionText(text) {
    return matchesAllCommentsText(text) || matchesSorterToggleText(text);
  }

  function isCommentOrderingMenu(menu) {
    if (!(menu instanceof Element)) {
      return false;
    }

    const label = normalizeText(menu.getAttribute("aria-label") || "");
    return label === "comment ordering" || label.startsWith("comment ordering ");
  }

  function hasRenderedFilterBox(element) {
    if (
      !(element instanceof Element) ||
      !isVisible(element) ||
      element.closest('[hidden], [inert], [aria-hidden="true"]')
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isMenuAnchoredToToggle(menu, toggle, items = []) {
    if (!(menu instanceof Element) || !(toggle instanceof Element)) {
      return false;
    }

    if (menu.contains(toggle) || toggle.contains(menu)) {
      return false;
    }

    const toggleRect = toggle.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    if (!toggleRect || !menuRect || menuRect.width <= 0 || menuRect.height <= 0) {
      return false;
    }

    const toggleCenterX = toggleRect.left + (toggleRect.width / 2);
    const menuCenterX = menuRect.left + (menuRect.width / 2);
    const horizontalDistance = Math.abs(menuCenterX - toggleCenterX);
    const verticalGap = menuRect.top - toggleRect.bottom;
    const overlapsToggleRow = menuRect.bottom >= toggleRect.top && menuRect.top <= toggleRect.bottom;
    const anchoredBelow = verticalGap >= -12 && verticalGap <= 240;
    const anchoredSide = horizontalDistance <= Math.max(220, toggleRect.width * 2.5);

    if (!(overlapsToggleRow || anchoredBelow) || !anchoredSide) {
      return false;
    }

    if (menu.matches('[role="dialog"]') && !isCommentOrderingMenu(menu)) {
      const visibleItems = items.filter((item) => item instanceof Element && isVisible(item));
      if (visibleItems.length < 2) {
        return false;
      }
    }

    return true;
  }

    /* The sorter toggle lives inside the active dialog and can read as Newest,
      Most relevant, or All comments. The scoring here intentionally prefers:
      1. a toggle already reading All comments,
      2. an expanded toggle,
      3. a toggle near the discussion region.
      This keeps the code anchored to the current modal instead of some unrelated
      Facebook menu button elsewhere on the page. */
    function getCommentSorterToggle(surface) {
    if (!(surface instanceof Element)) {
      return null;
    }

    const candidates = [];
    const selector = '[role="button"][aria-haspopup="menu"], [role="link"][aria-haspopup="menu"], [tabindex][aria-haspopup="menu"]';
      const discussionAnchor = surface.querySelector('[contenteditable="true"][role="textbox"], textarea, [role="list"], [aria-live], ul, ol');
      const discussionRect = discussionAnchor?.getBoundingClientRect?.() || null;
      const isFeedDialogSurface = !isDirectPostPage() && !isMediaViewerPage() && surface.matches('[role="dialog"]');

    surface.querySelectorAll(selector).forEach((candidate) => {
      if (
        !hasRenderedFilterBox(candidate) ||
        candidate.closest('[role="menu"], [role="toolbar"]') ||
        isPostActionControl(candidate)
      ) {
        return;
      }

      const text = normalizeText(candidate.textContent || candidate.getAttribute("aria-label"));
      if (!matchesSorterToggleText(text)) {
        return;
      }

      let score = 0;
      if (matchesAllCommentsText(text)) {
        score += 200;
      }
      if (candidate.getAttribute("aria-expanded") === "true") {
        score += 80;
      }
      if (candidate.closest('[role="list"], [aria-live], ul, ol')) {
        score += 30;
      }

      const rect = candidate.getBoundingClientRect();
      if (isFeedDialogSurface && discussionRect && rect) {
        const verticalDistance = Math.abs((rect.bottom || rect.top || 0) - discussionRect.top);
        const horizontalDistance = Math.abs((rect.left || 0) - discussionRect.left);
        score += Math.max(0, 180 - Math.min(180, verticalDistance));
        score += Math.max(0, 80 - Math.min(80, horizontalDistance));
      }

      candidates.push({
        candidate,
        score,
        top: Number.isFinite(rect?.top) ? rect.top : Number.POSITIVE_INFINITY
      });
    });

    candidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.top - right.top;
    });

    return candidates[0]?.candidate || null;
  }

  function getFilterOptionItems(container, toggle = null) {
    if (!(container instanceof Element)) {
      return [];
    }

    const items = [];
    const seenItems = new Set();

    function pushItem(item) {
      if (!(item instanceof Element) || !hasRenderedFilterBox(item) || seenItems.has(item)) {
        return;
      }

      seenItems.add(item);
      items.push(item);
    }

    const roleItems = [
      ...container.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="radio"]')
    ].filter((item) => hasRenderedFilterBox(item));

    roleItems.forEach(pushItem);

    const genericPressables = [
      ...container.querySelectorAll('[role="button"], [role="link"], button, a[href], [tabindex]')
    ].filter((item) => {
      if (!(item instanceof Element) || !hasRenderedFilterBox(item)) {
        return false;
      }

      if (toggle instanceof Element && (item === toggle || item.contains(toggle) || toggle.contains(item))) {
        return false;
      }

      if (item.closest('[role="toolbar"]') || isPostActionControl(item)) {
        return false;
      }

      const text = normalizeText(item.textContent || item.getAttribute("aria-label"));
      return matchesFilterOptionText(text);
    });

    genericPressables.forEach(pushItem);

    [...container.querySelectorAll('[aria-checked], [aria-selected]')]
      .filter((item) => hasRenderedFilterBox(item))
      .forEach(pushItem);

    return items;
  }

    /* The open popup is not identified by DOM position alone.
      Facebook may leave multiple menu-like surfaces in the document, so this scores
      candidates using the exact signals that proved reliable during debugging:
      - aria-label="Comment Ordering"
      - presence of a real All comments row
      - presence of the current toggle label (Newest / Most relevant / All comments)
      - proximity to the active sorter toggle
      Keep this scoring behavior intact unless the popup structure changes again. */
    function getCommentSortMenu(surface, toggle = null) {
    const toggleText = normalizeText(toggle?.textContent || toggle?.getAttribute?.("aria-label"));
    const toggleRect = toggle?.getBoundingClientRect?.();
    const visibleMenuCandidates = [
      ...document.querySelectorAll(
        '[role="menu"], [role="listbox"], [role="dialog"]'
      )
    ].filter((menu) => hasRenderedFilterBox(menu));
    const exactOrderingMenus = visibleMenuCandidates.filter((menu) => {
      return isCommentOrderingMenu(menu);
    });
    const menus = visibleMenuCandidates
      .map((menu) => {
        const items = getFilterOptionItems(menu, toggle);

        if (items.length === 0) {
          return null;
        }

          const isUniqueExactOrderingMenu =
            exactOrderingMenus.length === 1 &&
            exactOrderingMenus[0] === menu;
          if (
            toggle instanceof Element &&
            !isUniqueExactOrderingMenu &&
            !isMenuAnchoredToToggle(menu, toggle, items)
          ) {
            return null;
          }

        let score = 0;
        const itemTexts = items.map((item) => getMenuItemMatchText(item));
        if (itemTexts.some((text) => matchesAllCommentsText(text))) {
          score += 140;
        }
        if (itemTexts.some((text) => matchesSorterToggleText(text))) {
          score += 70;
        }
        if (toggleText && itemTexts.some((text) => text === toggleText)) {
          score += 40;
        }
        if (items.some((item) => isMenuItemSelected(item))) {
          score += 15;
        }
        if (surface instanceof Element && surface.contains(menu)) {
          score += 25;
        }

        if (isCommentOrderingMenu(menu)) {
          score += 180;
        }

        if (menu.matches('[role="menu"]')) {
          score += 30;
        }

        if (menu.matches('[role="listbox"]')) {
          score += 20;
        }

        const menuRect = menu.getBoundingClientRect();
        const top = Number.isFinite(menuRect?.top) ? menuRect.top : Number.POSITIVE_INFINITY;
        if (toggleRect) {
          const horizontalDistance = Math.abs(menuRect.left - toggleRect.left);
          const verticalDistance = Math.abs(menuRect.top - toggleRect.bottom);
          score += Math.max(0, 120 - Math.min(120, horizontalDistance));
          score += Math.max(0, 120 - Math.min(120, verticalDistance));
        }

        return score > 0 ? { menu, items, score, top } : null;
      })
      .filter(Boolean)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.top - right.top;
      });

    return menus[0] || null;
  }

  function getMenuItemDebugState(item) {
    if (!(item instanceof Element)) {
      return null;
    }

    return {
      role: item.getAttribute("role") || "",
      ariaChecked: item.getAttribute("aria-checked") || "",
      ariaSelected: item.getAttribute("aria-selected") || "",
      tabIndex: item.getAttribute("tabindex") || "",
      text: getMenuItemMatchText(item)
    };
  }

    /* Facebook's current FDSMenuItem/Pressable stack does not translate DOM
      click synthesis from an isolated content world into its selection
      callback. Ask the narrowly scoped MAIN-world bridge to invoke the exact
      row's own React press handler, then verify the visible sorter transition
      through the normal bounded follow-up. */
  function activateCommentIntentTarget(target, intent) {
    if (!(target instanceof Element) || !isVisible(target)) {
      return false;
    }

    const requestId = `${Date.now()}-${++commentIntentRequestSequence}`;
    try {
      target.dispatchEvent(
        new CustomEvent(COMMENT_INTENT_REQUEST_EVENT, {
          bubbles: true,
          composed: true,
          detail: JSON.stringify({
            requestId,
            intent
          })
        })
      );
    } catch {
      return false;
    }

    const result = commentIntentBridgeResults.get(requestId);
    commentIntentBridgeResults.delete(requestId);
    debugCommentAutomation("filter-main-world-activation", {
      target: describeElement(target),
      intent,
      activated: result?.activated === true,
      bridgeVersion: result?.bridgeVersion || 0,
      handlerName: result?.handlerName || "",
      handlerSource: result?.handlerSource || "",
      diagnostic: result?.diagnostic || null,
      reason: result?.reason || "no-response"
    });
    return result?.activated === true;
  }

  function activateMenuItem(item) {
    if (!(item instanceof Element) || !isVisible(item)) {
      return false;
    }

    const interactiveSelector =
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="radio"]';
    const interactiveRow = item.matches(interactiveSelector)
      ? item
      : item.closest(interactiveSelector) || item.querySelector(interactiveSelector);

    if (!(interactiveRow instanceof Element) || !isVisible(interactiveRow)) {
      return false;
    }

    return activateCommentIntentTarget(interactiveRow, "all-comments");
  }

  function isInViewport(element, margin = 4) {
    if (!(element instanceof Element) || !isVisible(element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= margin &&
      rect.right >= margin &&
      rect.top <= viewportHeight - margin &&
      rect.left <= viewportWidth - margin
    );
  }

  function captureScrollableAncestors(element) {
    const snapshots = [];
    let current = element?.parentElement || null;

    while (current instanceof Element) {
      const style = window.getComputedStyle(current);
      if (
        /auto|scroll/i.test(style.overflowY) &&
        current.scrollHeight > current.clientHeight
      ) {
        snapshots.push({
          element: current,
          left: current.scrollLeft,
          top: current.scrollTop
        });
      }
      current = current.parentElement;
    }

    return snapshots;
  }

  function revealFilterToggle(toggle, state) {
    if (!(toggle instanceof Element) || isInViewport(toggle)) {
      return;
    }

    if (!Array.isArray(state.scrollSnapshots) || state.scrollSnapshots.length === 0) {
      state.scrollSnapshots = captureScrollableAncestors(toggle);
    }

    /* Never use Element.scrollIntoView() here. In Facebook's fixed post overlay it
       may also scroll the virtualized Home feed behind the dialog. When that dialog
       closes, Facebook then keeps loading at the leaked page position and appears
       to infinite-scroll on its own. Move only the nearest real scroll container. */
    const scrollContainer = state.scrollSnapshots[0]?.element;
    if (!(scrollContainer instanceof Element)) {
      return;
    }

    const toggleRect = toggle.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    const offset =
      (toggleRect.top + (toggleRect.height / 2)) -
      (containerRect.top + (containerRect.height / 2));
    if (Number.isFinite(offset) && Math.abs(offset) > 1) {
      scrollContainer.scrollTop += offset;
    }
  }

  function restoreFilterScroll(state) {
    if (!state || !Array.isArray(state.scrollSnapshots) || state.scrollSnapshots.length === 0) {
      return;
    }

    if (state.restoreScrollFrameId) {
      cancelAnimationFrame(state.restoreScrollFrameId);
    }

    state.restoreScrollFrameId = requestAnimationFrame(() => {
      state.restoreScrollFrameId = 0;
      const snapshots = state.scrollSnapshots || [];
      state.scrollSnapshots = [];

      for (const snapshot of snapshots) {
        if (snapshot.element?.isConnected) {
          snapshot.element.scrollLeft = snapshot.left;
          snapshot.element.scrollTop = snapshot.top;
        }
      }
    });
  }

  function activateFilterToggle(surface, toggle, state) {
    if (!(toggle instanceof Element) || !isVisible(toggle)) {
      return false;
    }

    revealFilterToggle(toggle, state);

    if (activateCommentIntentTarget(toggle, "toggle-comment-ordering")) {
      return true;
    }

    try {
      if (typeof toggle.click === "function") {
        toggle.click();
        return true;
      }
    } catch {
      /* Ignore native click failures. */
    }

    return false;
  }

  /* Keep one targeted watcher so the sorter reacts when the menu finishes
     hydrating instead of reopening or polling it. */
  function getCommentFilterState(surface) {
    let state = commentFilterAttemptState.get(surface);
    const toggle = surface instanceof Element ? getCommentSorterToggle(surface) : null;

    if (!state) {
      state = {
        lastToggleAt: 0,
        lastSelectionAt: 0,
        selectionFailedUntil: 0,
        interactionUntil: 0,
        retryRunning: false,
        retryObserver: null,
        menuWatcher: null,
        menuLoadingUntil: 0,
        menuPollAttempts: 0,
        pendingSelectionStat: false,
        selectionAttempts: 0,
        restoreScrollFrameId: 0,
        scrollSnapshots: [],
        toggleElement: toggle
      };
      commentFilterAttemptState.set(surface, state);
    } else if (toggle instanceof Element && state.toggleElement !== toggle) {
      clearCommentFilterRetry(state);
      clearMenuWatcher(state);
      state.lastToggleAt = 0;
      state.lastSelectionAt = 0;
      state.selectionFailedUntil = 0;
      state.interactionUntil = 0;
      state.menuLoadingUntil = 0;
      state.menuPollAttempts = 0;
      state.pendingSelectionStat = false;
      state.selectionAttempts = 0;
      state.toggleElement = toggle;
    }

    return state;
  }

  function clearCommentFilterRetry(state) {
    if (!state) {
      return;
    }

    state.retryObserver?.disconnect();
    state.retryObserver = null;
    state.retryRunning = false;
  }

  function clearMenuWatcher(state) {
    if (!state?.menuWatcher) {
      return;
    }

    state.menuWatcher.stop();
    state.menuWatcher = null;
    state.menuLoadingUntil = 0;
  }

  function closeOpenCommentSortMenu(surface, state, {
    reason = ""
  } = {}) {
    if (!(surface instanceof Element) || !state) {
      return false;
    }

    const toggle = getCommentSorterToggle(surface);
    if (!(toggle instanceof Element)) {
      return false;
    }

    const openMenu = getCommentSortMenu(surface, toggle);
    const exactVisibleMenu = [...document.querySelectorAll(
      '[role="menu"][aria-label="Comment Ordering"]'
    )].find((menu) => isVisible(menu));
    if (!(openMenu?.menu instanceof Element) && !(exactVisibleMenu instanceof Element)) {
      return false;
    }

    if (activateCommentIntentTarget(toggle, "toggle-comment-ordering")) {
      debugCommentAutomation("filter-menu-close-dispatched", {
        target: describeElement(surface),
        reason,
        activationStrategy: "main-world-react-handler"
      });
      return true;
    }

    try {
      toggle.click();
      debugCommentAutomation("filter-menu-close-dispatched", {
        target: describeElement(surface),
        reason,
        activationStrategy: "native-click-fallback"
      });
      return true;
    } catch {
      return false;
    }
  }

  function confirmAllCommentsSelection(surface, state, toggleText, deps = {}) {
    if (!matchesAllCommentsText(toggleText)) {
      return false;
    }

    closeOpenCommentSortMenu(surface, state, {
      reason: "all-comments-confirmed"
    });
    clearCommentFilterRetry(state);
    clearMenuWatcher(state);
    state.interactionUntil = 0;
    state.menuPollAttempts = 0;
    state.selectionAttempts = 0;
    state.selectionFailedUntil = 0;

    if (state.pendingSelectionStat) {
      state.pendingSelectionStat = false;
      queueRuntimeStatIncrement(deps, "commentFilterChanges");
      debugCommentAutomation("filter-selected-all-comments", {
        target: describeElement(surface),
        toggleText
      });
    }

    restoreFilterScroll(state);
    return true;
  }

  function failAllCommentsSelection(surface, toggle, state, eventName, details = {}) {
    clearCommentFilterRetry(state);
    clearMenuWatcher(state);
    state.pendingSelectionStat = false;
    state.selectionAttempts = 0;
    state.interactionUntil = 0;
    state.menuPollAttempts = 0;
    state.selectionFailedUntil = Date.now() + 900;
    closeOpenCommentSortMenu(surface, state, {
      reason: eventName
    });
    restoreFilterScroll(state);
    debugCommentAutomation(eventName, {
      target: describeElement(surface),
      toggleText: normalizeText(toggle?.textContent || toggle?.getAttribute?.("aria-label")),
      ...details
    });
    return "unavailable";
  }

  function hasMenuLoadingIndicator(menu) {
    if (!(menu instanceof Element)) {
      return false;
    }

    if (menu.querySelector('[role="progressbar"]')) {
      return true;
    }

    return !menu.querySelector('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]');
  }

  function watchForMenuReady(menu, onReady, resolveMenu = null) {
    function getActiveMenu() {
      const resolvedMenu = typeof resolveMenu === "function" ? resolveMenu() : null;
      if (resolvedMenu instanceof Element) {
        return resolvedMenu;
      }

      return menu instanceof Element ? menu : null;
    }

    const initialMenu = getActiveMenu();
    if (!(initialMenu instanceof Element) || !hasMenuLoadingIndicator(initialMenu)) {
      onReady(initialMenu);
      return { stop() {} };
    }

    let stopped = false;
    let missingMenuMutationBatches = 0;

    function stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      observer.disconnect();
    }

    function check() {
      const activeMenu = getActiveMenu();
      if (stopped) {
        return;
      }
      if (!(activeMenu instanceof Element) || !activeMenu.isConnected) {
        missingMenuMutationBatches += 1;
        if (missingMenuMutationBatches >= 2) {
          stop();
          onReady(null);
        }
        return;
      }
      missingMenuMutationBatches = 0;
      if (!hasMenuLoadingIndicator(activeMenu)) {
        stop();
        onReady(activeMenu);
      }
    }

    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", "aria-busy", "hidden"]
    });

    return { stop };
  }

  function selectAllCommentsFromResolvedMenu(surface, openMenu, state, toggleText, deps = {}, { respectCooldown = true } = {}) {
    if (isCommentAutomationSuspended(deps)) {
      clearCommentFilterRetry(state);
      clearMenuWatcher(state);
      restoreFilterScroll(state);
      return "unavailable";
    }

    if (!(openMenu?.menu instanceof Element) || !Array.isArray(openMenu.items)) {
      return "not-open";
    }

    const allCommentsItem = openMenu.items.find((item) => {
      const text = getMenuItemMatchText(item);
      return matchesAllCommentsText(text);
    });

    if (!(allCommentsItem instanceof Element)) {
      return failAllCommentsSelection(surface, state.toggleElement, state, "filter-menu-no-all-comments-item", {
        observedToggleText: toggleText
      });
    }

    if (isMenuItemSelected(allCommentsItem)) {
      closeOpenCommentSortMenu(surface, state, {
        reason: "all-comments-row-selected"
      });
      clearCommentFilterRetry(state);
      clearMenuWatcher(state);
      state.interactionUntil = 0;
      state.menuPollAttempts = 0;
      state.selectionAttempts = 0;
      if (state.pendingSelectionStat) {
        queueRuntimeStatIncrement(deps, "commentFilterChanges");
        state.pendingSelectionStat = false;
      }
      restoreFilterScroll(state);
      return "already";
    }

    const now = Date.now();
    if (state.selectionFailedUntil > now) {
      debugCommentAutomation("filter-selection-pending", {
        target: describeElement(surface),
        toggleText
      });
      return "pending";
    }

    if (state.selectionAttempts >= COMMENT_FILTER_MAX_SELECTION_ATTEMPTS) {
      return failAllCommentsSelection(surface, state.toggleElement, state, "filter-selection-not-confirmed", {
        observedToggleText: toggleText,
        selectedItem: getMenuItemMatchText(allCommentsItem)
      });
    }

    const activationStrategy = "main-world-react-handler";
    if (!activateMenuItem(allCommentsItem)) {
      return failAllCommentsSelection(surface, state.toggleElement, state, "filter-selection-failed", {
        observedToggleText: toggleText,
        activationStrategy,
        selectedItem: getMenuItemMatchText(allCommentsItem),
        selectedItemBefore: getMenuItemDebugState(allCommentsItem)
      });
    }

    state.lastSelectionAt = now;
    state.selectionAttempts += 1;
    state.selectionFailedUntil = 0;
    state.interactionUntil = now + COMMENT_FILTER_SELECTION_WINDOW_MS;
    state.pendingSelectionStat = true;
    debugCommentAutomation("filter-selection-dispatched", {
      target: describeElement(surface),
      toggleText,
      activationStrategy,
      selectedItem: getMenuItemMatchText(allCommentsItem),
      selectedItemBefore: getMenuItemDebugState(allCommentsItem)
    });

    scheduleAllCommentsSelectionRetry(surface, deps);
    return "pending";
  }

    /* This is the core "choose All comments" step.
      Important constraints from debugging:
      - match against getMenuItemMatchText(), not full textContent
      - only treat a row as selected when aria state says so
      - if the popup is open, click immediately and let DOM changes verify state
      - avoid long cooldowns or reopen loops now that the correct row is found
      If selection starts hitting Newest again, inspect the label extraction before
      changing anything else. */
    function selectAllCommentsFromOpenMenu(surface, toggle, state, toggleText, deps = {}, { respectCooldown = true } = {}) {
    if (isCommentAutomationSuspended(deps)) {
      clearCommentFilterRetry(state);
      clearMenuWatcher(state);
      restoreFilterScroll(state);
      return "unavailable";
    }

    const openMenu = getCommentSortMenu(surface, toggle);
    if (!openMenu) {
      return "not-open";
    }

      const isDirectSelectionSurface = isDirectPostPage() || isMediaViewerPage();
      const hasImmediateFilterRows = openMenu.items.some((item) => matchesFilterOptionText(getMenuItemMatchText(item)));

      if (hasMenuLoadingIndicator(openMenu.menu) && !(isDirectSelectionSurface && hasImmediateFilterRows)) {
      debugCommentAutomation("filter-menu-loading", {
        target: describeElement(surface),
        toggleText
      });
      return "pending";
    }

    return selectAllCommentsFromResolvedMenu(surface, openMenu, state, toggleText, deps, { respectCooldown });
  }

    /* Verify the complete transition instead of trusting click dispatch:
      toggle opens -> exact All comments row is clicked -> toggle says All comments ->
      popup is closed. Selection gets at most one bounded second click. */
  function scheduleAllCommentsSelectionRetry(surface, deps = {}) {
    if (!(surface instanceof Element)) {
      return;
    }

    const state = getCommentFilterState(surface);

    const runRetry = () => {
      if (
        isCommentAutomationSuspended(deps) ||
        getRuntimeSettings(deps)?.enableCommentSortAll === false
      ) {
        state.pendingSelectionStat = false;
        state.selectionAttempts = 0;
        clearCommentFilterRetry(state);
        restoreFilterScroll(state);
        return;
      }

      if (!surface.isConnected || !isVisible(surface)) {
        state.pendingSelectionStat = false;
        state.selectionAttempts = 0;
        clearCommentFilterRetry(state);
        restoreFilterScroll(state);
        return;
      }

      const toggle = getCommentSorterToggle(surface);
      if (!(toggle instanceof Element)) {
        return;
      }

      const currentToggleText = normalizeText(toggle.textContent || toggle.getAttribute("aria-label"));
      if (confirmAllCommentsSelection(surface, state, currentToggleText, deps)) {
        return;
      }

      const openMenu = getCommentSortMenu(surface, toggle);
      const menuElement = openMenu?.menu || null;
      const hasImmediateFilterRows = openMenu?.items?.some((item) => {
        return matchesFilterOptionText(getMenuItemMatchText(item));
      });
      const allowImmediateDirectSelection =
        (isDirectPostPage() || isMediaViewerPage()) &&
        hasImmediateFilterRows;

      if (menuElement || toggle.getAttribute("aria-expanded") === "true") {
        if (menuElement && hasMenuLoadingIndicator(menuElement) && !allowImmediateDirectSelection) {
          if (!state.menuWatcher) {
            state.menuWatcher = watchForMenuReady(menuElement, (resolvedMenuElement) => {
              state.menuWatcher = null;

              if (isCommentAutomationSuspended(deps) ||
                  getRuntimeSettings(deps)?.enableCommentSortAll === false ||
                  !surface.isConnected ||
                  !isVisible(surface)) {
                clearCommentFilterRetry(state);
                restoreFilterScroll(state);
                return;
              }

              const readyToggle = getCommentSorterToggle(surface);
              if (!(readyToggle instanceof Element)) {
                return;
              }

              const readyToggleText = normalizeText(
                readyToggle.textContent ||
                readyToggle.getAttribute("aria-label")
              );
              if (confirmAllCommentsSelection(surface, state, readyToggleText, deps)) {
                return;
              }
              if (
                !(resolvedMenuElement instanceof Element) ||
                !resolvedMenuElement.isConnected
              ) {
                failAllCommentsSelection(
                  surface,
                  readyToggle,
                  state,
                  "filter-menu-disappeared",
                  { observedToggleText: readyToggleText }
                );
                return;
              }

              const readyOpenMenu = getCommentSortMenu(surface, readyToggle) || (
                resolvedMenuElement instanceof Element
                  ? {
                      menu: resolvedMenuElement,
                      items: getFilterOptionItems(resolvedMenuElement, readyToggle)
                    }
                  : openMenu
              );
              if (readyOpenMenu?.menu instanceof Element &&
                  !hasMenuLoadingIndicator(readyOpenMenu.menu)) {
                selectAllCommentsFromResolvedMenu(
                  surface,
                  readyOpenMenu,
                  state,
                  readyToggleText,
                  deps,
                  { respectCooldown: false }
                );
              }
            }, () => {
              const activeToggle = getCommentSorterToggle(surface);
              if (!(activeToggle instanceof Element)) {
                return null;
              }

              const exactVisibleMenu = [
                ...document.querySelectorAll(
                  '[role="menu"][aria-label="Comment Ordering"]'
                )
              ].find((menu) => hasRenderedFilterBox(menu));
              return (
                exactVisibleMenu ||
                getCommentSortMenu(surface, activeToggle)?.menu ||
                null
              );
            });
          }
          debugCommentAutomation("filter-menu-waiting-for-load", {
            target: describeElement(surface),
            toggleText: currentToggleText
          });
        } else if (menuElement) {
          selectAllCommentsFromOpenMenu(
            surface,
            toggle,
            state,
            currentToggleText,
            deps,
            { respectCooldown: false }
          );
        }
        return;
      }

      /*
        Opening or selecting the popup necessarily changes its DOM or ARIA state.
        If neither happened, leave the observer armed and wait for a real change;
        do not poll or manufacture a delayed retry.
      */
      if (state.selectionAttempts > 0) {
        failAllCommentsSelection(surface, toggle, state, "filter-selection-not-confirmed", {
          observedToggleText: currentToggleText,
          menuPresent: false,
          selectionAttempts: state.selectionAttempts
        });
      }
    };

    const runGuardedRetry = () => {
      if (state.retryRunning) {
        return;
      }

      state.retryRunning = true;
      try {
        runRetry();
      } finally {
        state.retryRunning = false;
      }
    };

    if (!state.retryObserver) {
      state.retryObserver = new MutationObserver(runGuardedRetry);
      state.retryObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "aria-busy",
          "aria-checked",
          "aria-expanded",
          "aria-selected",
          "hidden",
          "role"
        ]
      });
    }

    runGuardedRetry();
  }

    /* Full filter flow for the active comment surface:
      1. Find the sorter toggle in the resolved surface only.
      2. Exit immediately if the toggle already reads All comments.
      3. If the popup is already open, select All comments from that popup.
      4. Otherwise open the toggle once and schedule one short follow-up pass.

      This function is intentionally conservative about reopening the popup. The code
      used to carry aggressive retries, suspension windows, and reopen heuristics, but
      those were only compensating for incorrect item matching and wrong click targets.
      If behavior regresses, prefer fixing popup/menu detection before adding retries. */
    function ensureAllCommentsFilter(surface, deps = {}) {
    if (
      isCommentAutomationSuspended(deps) ||
      !(surface instanceof Element)
    ) {
      return "unavailable";
    }

    const toggle = getCommentSorterToggle(surface);
    if (!(toggle instanceof Element)) {
      debugCommentAutomation("filter-no-toggle", {
        target: describeElement(surface)
      });
      return "unavailable";
    }

    const now = Date.now();
    const state = getCommentFilterState(surface);
    const toggleText = normalizeText(toggle.textContent || toggle.getAttribute("aria-label"));
    const toggleExpanded = toggle.getAttribute("aria-expanded") === "true";
    const msSinceLastToggle = now - state.lastToggleAt;
    const isFeedDialogSurface = !isDirectPostPage() && !isMediaViewerPage() && !!surface.closest('[role="dialog"]');
    const openMenu = getCommentSortMenu(surface, toggle);
    const hasLoadedOpenMenu = !!openMenu?.menu && !hasMenuLoadingIndicator(openMenu.menu);

    if (state.menuWatcher && !isFeedDialogSurface) {
      debugCommentAutomation("filter-menu-watcher-pending", {
        target: describeElement(surface),
        toggleText,
        toggleExpanded,
        msSinceLastToggle,
        interactionUntil: state.interactionUntil,
        retryObserverActive: !!state.retryObserver
      });
      return "pending";
    }

    if (state.menuLoadingUntil > now && !isFeedDialogSurface) {
      debugCommentAutomation("filter-menu-loading-pending", {
        target: describeElement(surface),
        toggleText,
        toggleExpanded,
        msSinceLastToggle,
        menuLoadingUntil: state.menuLoadingUntil
      });
      return "pending";
    }

    if (state.menuLoadingUntil && state.menuLoadingUntil <= now) {
      state.menuLoadingUntil = 0;
    }

    if (state.selectionFailedUntil > now) {
      debugCommentAutomation("filter-interaction-pending", {
        target: describeElement(surface),
        toggleText
      });
      return "pending";
    }

    if (confirmAllCommentsSelection(surface, state, toggleText, deps)) {
      debugCommentAutomation("filter-already-all-comments", {
        target: describeElement(surface),
        toggleText
      });
      return "already";
    }

    if (isFeedDialogSurface && hasLoadedOpenMenu) {
      state.interactionUntil = 0;
      state.menuLoadingUntil = 0;
      clearMenuWatcher(state);
      return selectAllCommentsFromResolvedMenu(surface, openMenu, state, toggleText, deps, {
        respectCooldown: false
      });
    }

    const immediateSelectionResult = selectAllCommentsFromOpenMenu(surface, toggle, state, toggleText, deps);
    if (immediateSelectionResult !== "not-open") {
      return immediateSelectionResult;
    }

    if (toggleExpanded) {
      if (!state.retryObserver) {
        scheduleAllCommentsSelectionRetry(surface, deps);
      }
      debugCommentAutomation("filter-toggle-already-open", {
        target: describeElement(surface),
        toggleText
      });
      return "pending";
    }

    if (state.interactionUntil > now) {
      if (!state.retryObserver) {
        scheduleAllCommentsSelectionRetry(surface, deps);
      }
      debugCommentAutomation("filter-interaction-pending", {
        target: describeElement(surface),
        toggleText
      });
      return "pending";
    }

    if (msSinceLastToggle < 240 && state.retryObserver) {
      debugCommentAutomation("filter-toggle-pending", {
        target: describeElement(surface),
        toggleText
      });
      return "pending";
    }

    if (!activateFilterToggle(surface, toggle, state)) {
      state.lastToggleAt = now;
      state.interactionUntil = now + 240;
      restoreFilterScroll(state);
      debugCommentAutomation("filter-toggle-failed", {
        target: describeElement(surface),
        toggleText
      });
      return "pending";
    }

    state.lastToggleAt = now;
    state.interactionUntil = now + COMMENT_FILTER_SELECTION_WINDOW_MS;
    state.menuPollAttempts = 0;
    state.pendingSelectionStat = false;
    state.selectionAttempts = 0;
    scheduleAllCommentsSelectionRetry(surface, deps);
    debugCommentAutomation("filter-toggle-opened", {
      target: describeElement(surface),
      toggleText
    });
    return "pending";
  }

  function getCommentSurface(root = document) {
    const scopeElement = root instanceof Element ? root : document.body;
    const forcedDialog = getVisiblePostDialog(scopeElement || document);
    if (forcedDialog) {
      return forcedDialog;
    }

    const reelSurface = getActiveReelCommentSurface(scopeElement || document);
    if (reelSurface) {
      return reelSurface;
    }

    const seenSurfaces = new Set();
    const candidates = [];
    const surfaceSelector = '[role="dialog"], div[role="article"], [data-pagelet], main, [role="main"], [role="complementary"]';
    const onDirectPostPage = isDirectPostPage();
    const onMediaViewerPage = isMediaViewerPage();

    function addCandidate(surface, bias = 0) {
      if (!(surface instanceof Element) || !isVisible(surface) || seenSurfaces.has(surface)) {
        return;
      }

      if (onDirectPostPage && !surfaceMatchesCurrentPostRoute(surface)) {
        return;
      }

      if (isMediaViewerSurface(surface)) {
        return;
      }

      if (surface.matches('[role="complementary"]') && !isDirectPageCommentSurface(surface)) {
        return;
      }

      seenSurfaces.add(surface);

      let score = bias;
      const containsScope = scopeElement instanceof Element && surface.contains(scopeElement);
      const insideScope = scopeElement instanceof Element && scopeElement.contains(surface);
      const isScopeSurface = scopeElement instanceof Element && surface === scopeElement;

      if (isScopeSurface) {
        score += 110;
      }

      if (containsScope) {
        score += 60;
      }

      if (insideScope) {
        score += 30;
      }

      const sorterToggles = [...surface.querySelectorAll('[role="button"][aria-haspopup="menu"]')]
        .filter((toggle) => isVisible(toggle))
        .filter((toggle) => !toggle.closest('[role="menu"]'))
        .filter((toggle) => !toggle.closest('[role="toolbar"]'))
        .filter((toggle) => !isPostActionControl(toggle))
        .filter((toggle) => {
          const text = normalizeText(toggle.textContent || toggle.getAttribute("aria-label"));
          return matchesSorterToggleText(text);
        });

      const commentHints = [...surface.querySelectorAll('[role="button"]')]
        .filter((control) => isCommentHintControl(control));

      const hasComposer = !!surface.querySelector('[contenteditable="true"][role="textbox"], textarea');
      const renderedCommentCount = [...surface.querySelectorAll('div[role="article"]')].filter((article) => {
        return article.querySelector('[data-ad-rendering-role="profile_name"], a[role="link"]');
      }).length;
      const hasDiscussionRegion = !!surface.querySelector('[role="list"], [aria-live], ul, ol');
      const hasLoadMoreCommentControl = [...surface.querySelectorAll('[role="button"], [role="link"], [tabindex]')]
        .some((control) => {
          if (!(control instanceof Element) || !isVisible(control) || control.closest('[role="menu"], [role="toolbar"]')) {
            return false;
          }

          const text = normalizeText(control.textContent || control.getAttribute("aria-label"));
          return uiMatchers.loadMoreCommentRegex.test(text) || uiMatchers.moreCommentRegex.test(text);
        });
      const isLeafCommentArticle = surface.matches('div[role="article"]') && !sorterToggles.length && !hasComposer && !hasDiscussionRegion;

      if (sorterToggles.length > 0) {
        score += 90;
      }

      if (commentHints.length > 0) {
        score += 70;
      }

      if (hasComposer) {
        score += 50;
      }

      if (hasDiscussionRegion) {
        score += 40;
      }

      if (renderedCommentCount >= 2) {
        score += 25;
      }

      if (hasLoadMoreCommentControl) {
        score += 60;
      }

      if (onDirectPostPage && surface.matches('main, [role="main"], [data-pagelet]')) {
        score += 80;
      }

      if (!onDirectPostPage && surface.matches('main, [role="main"]')) {
        score -= 60;
      }

      if (!onDirectPostPage && surface.matches('[data-pagelet]') && !surface.matches('div[role="article"]')) {
        score -= 25;
      }

      if (isDirectPageCommentSurface(surface)) {
        score += 120;
      }

      if (isLeafCommentArticle) {
        score -= 140;
      }

      if (surface.matches('[role="dialog"]') && score < bias + 90) {
        return;
      }

      candidates.push({ surface, score });
    }

    if (scopeElement instanceof Element) {
      addCandidate(scopeElement.closest(surfaceSelector), 90);

      if (scopeElement.matches(surfaceSelector)) {
        addCandidate(scopeElement, 100);
      }

      const scopedSurface = scopeElement.querySelector?.(surfaceSelector);
      if (scopedSurface) {
        addCandidate(scopedSurface, 40);
      }
    }

    document.querySelectorAll('[role="dialog"]').forEach((dialog) => addCandidate(dialog, 10));

    if (onMediaViewerPage) {
      document.querySelectorAll('[role="complementary"]').forEach((comp) => addCandidate(comp, 10));
    }

    document
      .querySelectorAll('[role="button"][aria-haspopup="menu"]')
      .forEach((toggle) => addCandidate(toggle.closest(surfaceSelector), 55));

    document
      .querySelectorAll('[contenteditable="true"][role="textbox"], textarea')
      .forEach((composer) => addCandidate(composer.closest(surfaceSelector), 45));

    document
      .querySelectorAll('[role="button"]')
      .forEach((control) => {
        if (isCommentHintControl(control)) {
          addCandidate(control.closest(surfaceSelector), 35);
        }
      });

    candidates.sort((left, right) => right.score - left.score);
    return candidates[0]?.surface || null;
  }

  function canAutomateCommentSurface(surface) {
    if (!(surface instanceof Element)) {
      return false;
    }

    if (isReelCommentSurface(surface)) {
      return true;
    }

    if (isMediaViewerSurface(surface) && !hasCommentSurfaceSignals(surface)) {
      return false;
    }

    if (surface.matches('[role="dialog"]')) {
      return hasAutomatableDialogSignals(surface);
    }

    if (isDirectPageCommentSurface(surface)) {
      return true;
    }

    if (!surface.matches('div[role="article"]')) {
      return false;
    }

    const hasPostSignals =
      hasPostActionControl(surface) ||
      !!surface.querySelector(
        '[data-ad-rendering-role="story_message"], ' +
        '[data-ad-rendering-role="story_body"], ' +
        'a[aria-label="hide post"], ' +
        'a[role="link"][href*="/permalink/"], ' +
        'a[role="link"][href*="/posts/"], ' +
        'a[role="link"][href*="/story.php"], ' +
        'a[role="link"][href*="/reel/"], ' +
        'a[role="link"][href*="/videos/"]'
      );

    if (!hasPostSignals) {
      return false;
    }

    const hasComposer = !!surface.querySelector('[contenteditable="true"][role="textbox"], textarea');
    const renderedCommentCount = [...surface.querySelectorAll('div[role="article"]')].filter((article) => {
      return article !== surface && article.querySelector('[data-ad-rendering-role="profile_name"], a[role="link"]');
    }).length;
    const hasDiscussionRegion = !!surface.querySelector('[role="list"], [aria-live], ul, ol');
    const hasLoadMoreCommentControl = [...surface.querySelectorAll('[role="button"], [role="link"], [tabindex]')]
      .some((control) => {
        if (!(control instanceof Element) || !isVisible(control) || control.closest('[role="menu"], [role="toolbar"]')) {
          return false;
        }

        const text = normalizeText(control.textContent || control.getAttribute("aria-label"));
        return uiMatchers.loadMoreCommentRegex.test(text) || uiMatchers.moreCommentRegex.test(text);
      });

    return hasComposer || hasDiscussionRegion || renderedCommentCount >= 1 || hasLoadMoreCommentControl;
  }

  function hasCommentSurfaceSignals(surface) {
    if (!(surface instanceof Element) || !isVisible(surface)) {
      return false;
    }

    const hasSorterToggle = [...surface.querySelectorAll('[role="button"][aria-haspopup="menu"], [role="link"][aria-haspopup="menu"], [tabindex][aria-haspopup="menu"]')]
      .some((toggle) => {
        if (!isVisible(toggle) || toggle.closest('[role="menu"], [role="toolbar"]') || isPostActionControl(toggle)) {
          return false;
        }

        const text = normalizeText(toggle.textContent || toggle.getAttribute("aria-label"));
        return matchesSorterToggleText(text);
      });

    const hasCommentHints = [...surface.querySelectorAll('[role="button"], [role="link"], [tabindex]')]
      .some((control) => isCommentHintControl(control));

    const hasComposer = !!surface.querySelector('[contenteditable="true"][role="textbox"], textarea');
    return hasSorterToggle || hasCommentHints || hasComposer;
  }

  function getCommentActionControls(surface) {
    if (!(surface instanceof Element)) {
      return [];
    }

    const seen = new Set();
    const controls = [];

    function addControl(candidate) {
      if (!(candidate instanceof Element) || !isVisible(candidate) || seen.has(candidate)) {
        return;
      }

      seen.add(candidate);
      controls.push(candidate);
    }

    surface.querySelectorAll('[role="button"]').forEach((candidate) => {
      const text = normalizeText(candidate.textContent || candidate.getAttribute("aria-label"));
      if (
        isCommentHintControl(candidate) ||
        (candidate.getAttribute("aria-haspopup") === "menu" && matchesSorterToggleText(text))
      ) {
        addControl(candidate);
      }
    });

    surface.querySelectorAll('[role="link"]').forEach((candidate) => {
      const text = normalizeText(candidate.textContent || candidate.getAttribute("aria-label"));
      if (
        candidate.getAttribute("aria-haspopup") === "menu" ||
        isCommentHintControl(candidate) ||
        matchesSorterToggleText(text)
      ) {
        addControl(candidate);
      }
    });

    surface.querySelectorAll('[tabindex][aria-haspopup="menu"]').forEach((candidate) => {
      const text = normalizeText(candidate.textContent || candidate.getAttribute("aria-label"));
      if (matchesSorterToggleText(text)) {
        addControl(candidate);
      }
    });

    surface.querySelectorAll('[data-ad-rendering-role="comment_button"]').forEach((marker) => {
      const control = marker.closest('[role="button"], [role="link"], [tabindex]');
      addControl(control);
    });

    return controls;
  }

  function getControlNavigationHref(control) {
    if (!(control instanceof Element)) {
      return "";
    }

    const link = control.matches('a[href]') ? control : control.closest('a[href]');
    const href = link?.getAttribute('href') || "";
    if (!href) {
      return "";
    }

    try {
      return new URL(href, window.location.href).href;
    } catch {
      return href;
    }
  }

  function isLikelyPostNavigationHref(href) {
    if (!href) {
      return false;
    }

    try {
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) {
        return true;
      }

      if (
        url.pathname !== window.location.pathname &&
        /\/permalink\/|\/posts\/|\/story\.php|\/photo\/|\/videos\/|\/reel\//i.test(url.pathname)
      ) {
        return true;
      }

      if (url.pathname === window.location.pathname && (!url.hash || url.hash === "#")) {
        return false;
      }

      return false;
    } catch {
      return /\/permalink\/|\/posts\/|\/story\.php|\/photo\/|\/videos\/|\/reel\//i.test(href);
    }
  }

  function getDirectPostPrimaryCommentControl(surface, controls = null) {
    if (!(surface instanceof Element)) {
      return null;
    }

    const candidateControls = Array.isArray(controls) ? controls : getCommentActionControls(surface);
    const rankedControls = [];

    for (const control of candidateControls) {
      const text = normalizeText(control.textContent || control.getAttribute("aria-label"));
      const hasCommentMarker = !!control.querySelector('[data-ad-rendering-role="comment_button"]');
      const inCommentThread = !!control.closest('[role="list"], [aria-live], ul, ol');
      const isSummaryControl = !!text && uiMatchers.commentSummaryRegex.test(text);
      const isLoadMoreControl = !!text && (
        uiMatchers.loadMoreCommentRegex.test(text) ||
        uiMatchers.moreCommentRegex.test(text)
      );
      const isReplyControl = /\brepl(?:y|ies)\b/.test(text);
      const hasCommentWord = /\bcomments?\b/.test(text);
      const isNumericCommentCount = /^\d[\d.,km]*\s+comments?$/i.test(text);
      const isBareCommentLabel = /^comments?$/.test(text);
      const navigationHref = getControlNavigationHref(control);
      const isLikelyPostNavigation = isLikelyPostNavigationHref(navigationHref);
      const isInsideLink = !!control.closest('a[href]');

      debugCommentAutomation("opener-candidate", {
        control: describeElement(control),
        controlText: text,
        navigationHref,
        isLikelyPostNavigation,
        isInsideLink
      });

      if (!(control instanceof Element) || !isVisible(control)) {
        debugCommentAutomation("reject-opener-not-visible", { control: describeElement(control) });
        continue;
      }
      if (control.closest('[role="menu"], [role="toolbar"]')) {
        debugCommentAutomation("reject-opener-menu-toolbar", { control: describeElement(control) });
        continue;
      }
      if (control.getAttribute("aria-haspopup") === "menu") {
        debugCommentAutomation("reject-opener-has-popup", { control: describeElement(control) });
        continue;
      }
      if (!hasCommentMarker && !hasCommentWord && !isSummaryControl) {
        debugCommentAutomation("reject-opener-no-comment-marker", { control: describeElement(control) });
        continue;
      }
      if (isLikelyPostNavigation || isInsideLink) {
        debugCommentAutomation("reject-opener-link-or-navigation", {
          control: describeElement(control),
          navigationHref,
          isInsideLink
        });
        continue;
      }
      if (matchesSorterToggleText(text)) {
        debugCommentAutomation("reject-opener-sorter-toggle", { control: describeElement(control) });
        continue;
      }

      let score = 0;
      if (hasCommentMarker) {
        score += 100;
      }
      if (isBareCommentLabel) {
        score += 70;
      }
      if (isNumericCommentCount) {
        score += 55;
      }
      if (isSummaryControl) {
        score += 45;
      }
      if (hasCommentWord) {
        score += 25;
      }
      if (control.matches('[role="button"]')) {
        score += 12;
      }
      if (control.matches('[role="link"]') || isInsideLink) {
        score -= 80;
      }
      if (inCommentThread) {
        score -= 90;
      }
      if (isLoadMoreControl) {
        score -= 60;
      }
      if (isReplyControl) {
        score -= 75;
      }
      if (text.length > 80) {
        score -= 20;
      }

      const rect = control.getBoundingClientRect();
      rankedControls.push({
        control,
        score,
        top: Number.isFinite(rect?.top) ? rect.top : Number.POSITIVE_INFINITY
      });
    }

    rankedControls.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.top - right.top;
    });

    return rankedControls[0]?.control || null;
  }

  function activateCommentControl(element) {
    if (!(element instanceof Element) || !isVisible(element)) {
      return false;
    }

    const targetCandidates = [];

    function pushCandidate(candidate) {
      if (!(candidate instanceof Element) || !isVisible(candidate) || targetCandidates.includes(candidate)) {
        return;
      }

      if (candidate.matches('a[href]') || candidate.closest('a[href]')) {
        return;
      }

      targetCandidates.push(candidate);
    }

    pushCandidate(element.querySelector('[data-ad-rendering-role="comment_button"]'));
    pushCandidate(element.querySelector('span, div'));
    pushCandidate(element);

    const roleParent = element.closest('[role="button"], [role="link"]');
    if (roleParent && roleParent !== element && !roleParent.matches('a[href]')) {
      pushCandidate(roleParent);
    }

    for (const target of targetCandidates) {
      try {
        if (typeof target.click === "function") {
          target.click();
          return true;
        }
      } catch {
        /* Ignore native click failures. */
      }

      if (pressElement(target, {
        dispatchKeyboard: false,
        dispatchSyntheticClick: true,
        dispatchNativeClick: false
      })) {
        return true;
      }
    }

    return false;
  }

  function getActiveCommentAutomationRoot(root = document) {
    if (root instanceof Element) {
      const scopedDialog = getVisiblePostDialog(root);
      if (scopedDialog && hasAutomatableDialogSignals(scopedDialog)) {
        debugCommentAutomation("resolve-root-scoped-dialog", {
          source: describeElement(root),
          resolved: describeElement(scopedDialog)
        });
        return scopedDialog;
      }

      const resolvedSurface = getCommentSurface(root);
      debugCommentAutomation("resolve-root-from-element", {
        source: describeElement(root),
        resolved: describeElement(resolvedSurface),
        canAutomateSurface: resolvedSurface ? canAutomateCommentSurface(resolvedSurface) : false
      });
      if (resolvedSurface && canAutomateCommentSurface(resolvedSurface)) {
        return resolvedSurface;
      }
    }

    const allowDocumentDialogFallback = !(root instanceof Element) || root === document || root === document.body;
    const visibleDialog = allowDocumentDialogFallback ? getVisiblePostDialog(document) : null;

    if (visibleDialog && hasAutomatableDialogSignals(visibleDialog)) {
      debugCommentAutomation("resolve-root-visible-dialog", {
        resolved: describeElement(visibleDialog)
      });
      return visibleDialog;
    }

    /* Restrict page-surface fallback to direct permalink/media pages. Allowing this
       on the feed reintroduces stray comment opens and random post navigation. */
    if (isDirectPostPage() || isMediaViewerPage()) {
      const blockingMediaViewerOverlay = getBlockingMediaViewerOverlay();
      if (blockingMediaViewerOverlay) {
        debugCommentAutomation("resolve-root-blocked-by-media-overlay", {
          overlay: describeElement(blockingMediaViewerOverlay)
        });
        return null;
      }

      const resolvedSurface = getCommentSurface(document);
      if (resolvedSurface && canAutomateCommentSurface(resolvedSurface)) {
        debugCommentAutomation("resolve-root-page-surface", {
          resolved: describeElement(resolvedSurface)
        });
        return resolvedSurface;
      }
    }

    const reelSurface = getActiveReelCommentSurface(document);
    if (reelSurface) {
      debugCommentAutomation("resolve-root-reel-surface", {
        resolved: describeElement(reelSurface)
      });
      return reelSurface;
    }

    debugCommentAutomation("resolve-root-none", {
      directPost: isDirectPostPage() || isMediaViewerPage(),
      reelPage: isReelExperiencePage()
    });

    return null;
  }

  function runCommentAutomation(root = document, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (
      isCommentAutomationSuspended(deps) ||
      (
        settings?.enableCommentSortAll === false &&
        settings?.enableCommentExpansion === false
      )
    ) {
      debugCommentAutomation("run-automation-skip", {
        reason: "route-transition-suspended"
      });
      return false;
    }

    const target = getActiveCommentAutomationRoot(root);
    if (!target) {
      debugCommentAutomation("run-automation-skip", {
        reason: "no-target"
      });
      return false;
    }

    debugCommentAutomation("run-automation", {
      target: describeElement(target),
      directPost: isDirectPostPage() || isMediaViewerPage(),
      reelPage: isReelExperiencePage()
    });

    let filterResult = "disabled";
    if (settings?.enableCommentSortAll !== false) {
      const filterState = getCommentFilterState(target);
      const activeToggle = getCommentSorterToggle(target);
      const filterUiOpen =
        (activeToggle instanceof Element && activeToggle.getAttribute("aria-expanded") === "true") ||
        !!getCommentSortMenu(target, activeToggle);
      if (
        filterState.interactionUntil > Date.now() &&
        filterState.retryObserver
      ) {
        debugCommentAutomation("run-automation-filter-deferred", {
          target: describeElement(target),
          filterUiOpen
        });
        return true;
      }

      filterResult = ensureAllCommentsFilter(target, deps);
    }
    debugCommentAutomation("run-automation-filter", {
      target: describeElement(target),
      filterResult
    });
    /* Wait for the sorter mutation pass before trying to expand replies; otherwise
       expansion can run against pre-filter content and miss newly rendered controls. */
    if (filterResult === "pending") {
      return true;
    }

    if (isCommentComposerActive(target)) {
      debugCommentAutomation("run-automation-skip", {
        reason: "composer-active",
        target: describeElement(target)
      });
      return false;
    }

    const expansionResult = settings?.enableCommentExpansion !== false
      ? clickCommentExpanders(target, deps)
      : "disabled";
    debugCommentAutomation("run-automation-stage", {
      target: describeElement(target),
      expansionResult
    });
    return true;
  }

  function scheduleCommentAutomationPasses(root = document, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (
      isCommentAutomationSuspended(deps) ||
      (
        settings?.enableCommentSortAll === false &&
        settings?.enableCommentExpansion === false
      )
    ) {
      return;
    }

    runCommentAutomation(root, deps);

    const target = getActiveCommentAutomationRoot(root);
    if (!target || activeExpansionWatchers.has(target)) {
      return;
    }

    const watcher = watchSurfaceMutations(target, () => {
      if (target.isConnected && isVisible(target)) {
        runCommentAutomation(target, deps);
      }
    });

    if (watcher) {
      activeExpansionWatchers.set(target, watcher);
    }
  }

  function clickCommentExpanders(root = document, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (
      isCommentAutomationSuspended(deps) ||
      !settings?.enableCommentExpansion
    ) {
      return "none";
    }

    const activeDialog = getCommentSurface(root);
    if (!activeDialog || !canAutomateCommentSurface(activeDialog)) {
      return "none";
    }

    if (isCommentComposerActive(activeDialog)) {
      debugCommentAutomation("expand-comments-skip", {
        target: describeElement(activeDialog),
        reason: "composer-active"
      });
      return "pending";
    }

    const controls = getCommentActionControls(activeDialog);

    function getCommentExpansionState(surface) {
      let state = commentExpansionAttemptState.get(surface);
      if (!state) {
        state = {
          totalAttempts: 0,
          routeHref: ""
        };
        commentExpansionAttemptState.set(surface, state);
      }

      return state;
    }

    const expansionState = getCommentExpansionState(activeDialog);
    const routeHref = window.location.href;
    if (expansionState.routeHref !== routeHref) {
      expansionState.totalAttempts = 0;
      expansionState.routeHref = routeHref;
    }
    const onDirectPostPage = isDirectPostPage() || isMediaViewerPage() || isReelCommentSurface(activeDialog);
    const isDialogSurface = activeDialog.matches('[role="dialog"]');

    function getCommentExpanderKind(control) {
      const text = normalizeText(control?.textContent || control?.getAttribute?.("aria-label"));
      if (!text) {
        return "other";
      }

      const primaryText = getPrimaryControlText(control);
      const effectiveText = primaryText || text;
      const isReplyControl = /\brepl(?:y|ies)\b|\bresponses?\b|\banswers?\b/.test(effectiveText);

      if (effectiveText === "see more" && isCommentTextSeeMoreControl(control)) {
        return "commentText";
      }

      const isLoadMoreCommentControl =
        uiMatchers.loadMoreCommentRegex.test(effectiveText) ||
        uiMatchers.moreCommentRegex.test(effectiveText) ||
        /^(?:view|see|show)\s+(?:more\s+)?(?:comments?|replies?|responses?)$/i.test(effectiveText);
      if (isLoadMoreCommentControl) {
        return isReplyControl ? "replyLoadMore" : "loadMore";
      }

      const isCommentSummaryControl =
        uiMatchers.commentSummaryRegex.test(effectiveText) ||
        /^(?:show|view|see)\s+(?:comments?|replies?|responses?)$/i.test(effectiveText) ||
        /^(?:show|view|see)\s+all\s+\d+\s+(?:comments?|replies?|responses?)$/i.test(effectiveText) ||
        isReplySummaryText(effectiveText);
      if (isCommentSummaryControl) {
        return isReplyControl ? "replySummary" : "summary";
      }

      return "other";
    }

    if (expansionState.totalAttempts >= 24) {
      debugCommentAutomation("expand-comments-skip", {
        target: describeElement(activeDialog),
        reason: "surface-attempt-cap",
        attempts: expansionState.totalAttempts
      });
      return "none";
    }

    function hasVisibleCommentComposer(host) {
      return !!host.querySelector('[contenteditable="true"][role="textbox"], textarea');
    }

    function hasRenderedCommentThread(host) {
      if (!(host instanceof Element)) {
        return false;
      }

      const commentArticles = [...host.querySelectorAll('div[role="article"]')].filter((article) => {
        return article.querySelector('[data-ad-rendering-role="profile_name"], a[role="link"]');
      });

      return commentArticles.length >= 2 || !!host.querySelector('[role="list"] [role="article"], [aria-live] [role="article"]');
    }

    function hasCommentContext(control) {
      const host = control.closest('[role="dialog"], div[role="article"], [data-pagelet], main, [role="main"], [role="complementary"]') || document;
      const hasComposer = hasVisibleCommentComposer(host);
      const nestedArticleCount = host.querySelectorAll('div[role="article"]').length;
      const hasDiscussionRegion = !!host.querySelector('[role="list"], [role="feed"], [aria-live]');

      return hasComposer || nestedArticleCount >= 2 || hasDiscussionRegion || hasCommentSurfaceSignals(host);
    }

    function isPrimaryCommentOpener(control) {
      if (!(control instanceof Element)) {
        return false;
      }

      if (control.closest('[role="menu"], [role="toolbar"]') || control.getAttribute("aria-haspopup") === "menu") {
        return false;
      }

      const text = normalizeText(control.textContent || control.getAttribute("aria-label"));
      const hasCommentMarker = !!control.querySelector('[data-ad-rendering-role="comment_button"]');
      const hasCommentWord = /\bcomments?\b|\breplies?\b/.test(text);

      return hasCommentMarker || hasCommentWord;
    }

    function activateCommentExpanderControl(control, controlKind) {
      if (!(control instanceof Element) || !isVisible(control)) {
        return false;
      }

      /*
        Reply/load-more labels can contain nested spans whose nearest clickable
        ancestor is also a post permalink. Activating a guessed descendant or
        ancestor can therefore navigate instead of expanding. The controls we
        automate must be explicit native buttons, and we click that exact node
        once.
      */
      if (
        !["commentText", "loadMore", "replyLoadMore", "replySummary"].includes(controlKind) ||
        !control.matches('[role="button"], button') ||
        control.closest('a[href]') ||
        control.getAttribute("aria-haspopup") === "menu"
      ) {
        return false;
      }

      /*
        React currently ignores the hand-built pointer/mouse sequence for some
        "View N replies" buttons, especially after a permalink dialog has been
        recycled. HTMLElement.click() reaches the exact button's registered
        click path without generating duplicate pointer events or coordinates
        outside the viewport for controls higher in a scrolled dialog.
      */
      try {
        if (typeof control.click !== "function") {
          return false;
        }

        control.click();
        return true;
      } catch {
        return false;
      }
    }

    function getExactReplySummaryFallbackControls(surface) {
      if (!(surface instanceof Element)) {
        return [];
      }

      const seen = new Set();
      const matches = [];
      const textCandidates = [surface, ...surface.querySelectorAll('span, div')];

      for (const candidate of textCandidates) {
        if (!(candidate instanceof Element) || !isVisible(candidate)) {
          continue;
        }

        const text = getPrimaryControlText(candidate) || normalizeText(candidate.textContent || candidate.getAttribute('aria-label'));
        if (!isReplySummaryText(text)) {
          continue;
        }

        if (!isReplyControlInCommentThread(candidate)) {
          continue;
        }

        const control = candidate.closest('[role="button"], [role="link"], [tabindex], button, a[href]');
        if (!(control instanceof Element) || !isVisible(control) || seen.has(control)) {
          continue;
        }

        const navigationHref = getControlNavigationHref(control);
        if (navigationHref && isLikelyPostNavigationHref(navigationHref)) {
          continue;
        }
        seen.add(control);
        matches.push(control);
      }

      return matches;
    }

    function isReplyControlInCommentThread(control) {
      if (!(control instanceof Element)) {
        return false;
      }

      if (control.closest('[role="list"], [aria-live], ul, ol')) {
        return true;
      }

      /*
        Facebook's current dialog markup renders "View N replies" beside the
        owning comment article rather than inside a semantic list. Walk only to
        the nearest single-comment wrapper and require a real Comment article,
        so a post-level comment count cannot qualify.
      */
      let wrapper = control.parentElement;
      while (wrapper && wrapper !== activeDialog) {
        const commentArticles = [...wrapper.querySelectorAll('div[role="article"]')];
        if (commentArticles.length === 1) {
          const article = commentArticles[0];
          const articleLabel = normalizeText(article.getAttribute("aria-label"));
          const isRenderedComment =
            articleLabel.startsWith("comment by ") ||
            articleLabel.startsWith("reply by ") ||
            (
              !!article.querySelector('[role="button"][aria-label="Reply" i]') &&
              !!article.querySelector('a[role="link"], [data-ad-rendering-role="profile_name"]')
            );

          if (isRenderedComment) {
            return true;
          }
        } else if (commentArticles.length > 1) {
          break;
        }

        wrapper = wrapper.parentElement;
      }

      return false;
    }

    function isLikelyCommentExpander(control) {
      if (!hasCommentContext(control)) {
        return false;
      }

      const inCommentThread = isReplyControlInCommentThread(control);
      if (control.closest('[role="toolbar"]')) {
        return false;
      }

      if (control.closest('[role="menu"]')) {
        return false;
      }

      if (control.getAttribute("aria-haspopup") === "menu") {
        return false;
      }

      const text = normalizeText(control.textContent || control.getAttribute("aria-label"));
      const primaryText = getPrimaryControlText(control);
      const effectiveText = primaryText || text;
      if (!text || text.length > 140) {
        return false;
      }

      if (isReplySummaryText(effectiveText)) {
        return inCommentThread && !control.closest('[role="toolbar"], [role="menu"]');
      }

      const controlKind = getCommentExpanderKind(control);
      if (controlKind === "commentText") {
        return isCommentTextSeeMoreControl(control);
      }

      const isCommentSummaryControl = controlKind === "summary" || controlKind === "replySummary";
      const isLoadMoreCommentControl = controlKind === "loadMore" || controlKind === "replyLoadMore";

      /* A post's top-level comment count is a navigation control, not a thread
         expander. Clicking it from a delayed pass can open a recycled neighbor
         card after Facebook has changed routes. Only explicit load-more controls
         and reply summaries inside an existing thread are safe to automate. */
      if (controlKind === "summary") {
        return false;
      }

      if (controlKind === "replySummary" && !inCommentThread) {
        return false;
      }

      if (
        onDirectPostPage &&
        !hasRenderedCommentThread(activeDialog) &&
        !hasVisibleCommentComposer(activeDialog) &&
        isPrimaryCommentOpener(control)
      ) {
        return true;
      }

      if (!inCommentThread && !isCommentSummaryControl && !isLoadMoreCommentControl) {
        return false;
      }

      if (control.hasAttribute("aria-label") && !isCommentSummaryControl && !isLoadMoreCommentControl) {
        return false;
      }

      if (isCommentSummaryControl || isLoadMoreCommentControl) {
        return true;
      }

      /* Only reject icon-only buttons for "other" kind controls. Verified comment
         expanders (summary/loadMore) often contain a decorative SVG chevron alongside
         their text and should not be blocked by this check. */
      if (control.querySelector("svg, img, video")) {
        return false;
      }

      const hasNumericHint = /\d/.test(text);
      if (!hasNumericHint || text.length < 6) {
        return false;
      }

      return true;
    }

    const directPostPrimaryOpener = null;

    const exactReplySummaryFallbackControls = getExactReplySummaryFallbackControls(activeDialog)
      .filter((control) => !controls.includes(control));

    const prioritizedControls = [
      ...controls.filter((control) => getCommentExpanderKind(control) === "commentText"),
      ...controls.filter((control) => getCommentExpanderKind(control) === "replyLoadMore"),
      ...exactReplySummaryFallbackControls,
      ...controls.filter((control) => getCommentExpanderKind(control) === "loadMore"),
      ...controls.filter((control) => getCommentExpanderKind(control) === "replySummary"),
      ...controls.filter((control) => getCommentExpanderKind(control) === "summary"),
      ...controls.filter((control) => getCommentExpanderKind(control) === "other")
    ];

    let expanded = false;
    for (const control of prioritizedControls) {
      const retryableDirectOpener = control === directPostPrimaryOpener;
      const controlText = normalizeText(control.textContent || control.getAttribute("aria-label"));
      const controlKind = getCommentExpanderKind(control);
      if (!["commentText", "loadMore", "replyLoadMore", "replySummary"].includes(controlKind)) {
        continue;
      }
      const isRepeatableControl =
        controlKind === "loadMore" ||
        controlKind === "replyLoadMore" ||
        controlKind === "replySummary";
      const isInsideLink = !!control.closest('a[href]');
      const navigationHref = getControlNavigationHref(control);
      let isBlockedLink = false;

      if (isInsideLink || navigationHref) {
        try {
          const resolved = new URL(navigationHref, window.location.href).href;
          const isExactSelfLink = resolved === window.location.href;
          const isInlineCommentLink = controlKind !== "other" && !isLikelyPostNavigationHref(resolved);
          const allowDialogInlineLink = isDialogSurface && isInlineCommentLink;
          if (!isExactSelfLink && !isInlineCommentLink) {
            isBlockedLink = true;
          }
          debugCommentAutomation(
            isBlockedLink
              ? "expander-skip-nonself-link"
              : allowDialogInlineLink
                ? "expander-allow-dialog-inline-link"
              : isExactSelfLink
                ? "expander-allow-exact-self-link"
                : "expander-allow-inline-comment-link",
            {
              control: describeElement(control),
              controlKind,
              navigationHref,
              resolved,
              current: window.location.href
            }
          );
        } catch {
          isBlockedLink = true;
          debugCommentAutomation("expander-skip-link-parse-error", {
            control: describeElement(control),
            controlKind,
            navigationHref,
            current: window.location.href
          });
        }

        if (isBlockedLink) {
          continue;
        }
      }

      if (
        (!retryableDirectOpener && !isRepeatableControl && clickedElements.has(control)) ||
        !isVisible(control)
      ) {
        debugCommentAutomation("expander-skip-clicked-or-invisible", { control: describeElement(control) });
        continue;
      }
      if (directPostPrimaryOpener && control !== directPostPrimaryOpener) {
        debugCommentAutomation("expander-skip-not-primary", { control: describeElement(control) });
        continue;
      }
      if (!isLikelyCommentExpander(control)) {
        debugCommentAutomation("expander-skip-not-likely", { control: describeElement(control) });
        continue;
      }
      if (
        window.location.href !== routeHref ||
        !activeDialog.isConnected ||
        !isVisible(activeDialog) ||
        !(retryableDirectOpener
          ? activateCommentControl(control)
          : activateCommentExpanderControl(control, controlKind))
      ) {
        debugCommentAutomation("expander-skip-activation-failed", { control: describeElement(control) });
        continue;
      }
      if (!retryableDirectOpener && !isRepeatableControl) {
        clickedElements.add(control);
      }
      expansionState.totalAttempts += 1;
      debugCommentAutomation("expand-comments-click", {
        target: describeElement(activeDialog),
        control: describeElement(control),
        controlText,
        controlKind
      });
      queueRuntimeStatIncrement(deps, "expandedComments");
      expanded = true;
      break;
    }

    if (!expanded) {
      debugCommentAutomation("expand-comments-no-match", {
        target: describeElement(activeDialog),
        controlCount: controls.length,
        hasDirectPostPrimaryOpener: !!directPostPrimaryOpener
      });
      return "none";
    }

    if (!activeExpansionWatchers.has(activeDialog)) {
      const watcher = watchSurfaceMutations(activeDialog, () => {
        if (activeDialog.isConnected && isVisible(activeDialog)) {
          runCommentAutomation(activeDialog, deps);
        }
      });

      if (watcher) {
        activeExpansionWatchers.set(activeDialog, watcher);
      }
    }

    return "expanded";
  }

  globalThis.FacebergCommentsRuntime = Object.freeze({
    isDirectPostPage,
    isMediaViewerPage,
    isReelExperiencePage,
    getActiveReelCommentSurface,
    getBlockingMediaViewerOverlay,
    getVisiblePostDialog,
    hasPostDialogSignals,
    hasCommentSurfaceSignals,
    runCommentAutomation,
    scheduleCommentAutomationPasses
  });
})();
