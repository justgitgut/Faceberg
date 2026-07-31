(() => {
  "use strict";

  if (globalThis.FacebergFeedRuntime) {
    return;
  }

  const contentUtils = globalThis.FacebergContentUtils;
  if (!contentUtils) {
    return;
  }

  const {
    normalizeText,
    hasPostActionControl,
    isVisible,
    getRuntimeSettings,
    queueRuntimeStatIncrement
  } = contentUtils;
  const debugFeedCleanup =
    typeof globalThis.FacebergContentDebug?.debugCommentAutomation === "function"
      ? globalThis.FacebergContentDebug.debugCommentAutomation
      : () => {};

  const removedFeedElements = new WeakSet();
  const hiddenFeedModuleElements = new WeakSet();
  const skippedSponsoredReelItems = new WeakSet();
  const removedSponsoredReelRoutes = new Set();
  const countedSponsoredReelRoutes = new Set();
  const compactedHiddenFeedbackMonitors = new WeakMap();
  const pendingNativeHideTransitions = new WeakMap();
  const lateVisibleSponsoredSuppressions = new Map();
  const COMPACT_HIDDEN_FEEDBACK_ATTRIBUTE = "data-faceberg-compact-hidden-feedback";
  const PENDING_NATIVE_HIDE_ATTRIBUTE = "data-faceberg-pending-native-hide";
  const LATE_SPONSORED_ATTRIBUTE = "data-faceberg-late-sponsored";
  const HIDDEN_FEED_MODULE_ATTRIBUTE = "data-faceberg-hidden-feed-module";
  const HIDDEN_SPONSORED_REEL_ATTRIBUTE = "data-faceberg-hidden-sponsored-reel";
  const SPONSORED_LABEL_NOISE_PATTERN =
    /[\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]/gu;
  const HIDDEN_FEEDBACK_LABELS = new Set([
    "ad hidden",
    "post hidden",
    "sponsored post hidden"
  ]);
  const GENERIC_HIDDEN_FEEDBACK_LABEL = "hidden";
  const GENERIC_HIDDEN_FEEDBACK_DESCRIPTION =
    "hiding posts helps facebook personalize your feed.";
  /*
    Physical removal of any React-owned Home-feed unit can invalidate
    Facebook's recycled event targets, stop infinite-feed loading, or leave a
    transparent/inert layer over native controls such as video playback.
    Until feed filtering can use a Facebook-supported boundary, keep all main
    feed units fail-open. Independent sidebar cleanup remains safe. Verified
    standalone Stories/Reels modules are only layout-hidden and stay connected.
  */
  const ENABLE_REACT_FEED_MUTATIONS = false;

  function getEnabledPostLabels(settings) {
    const labels = [];

    if (settings?.enableBlockJoinPosts) {
      labels.push("join");
    }

    if (settings?.enableBlockFollowPosts) {
      labels.push("follow");
    }

    return labels;
  }

  function matchesBlockedLabel(text, blockedLabels) {
    if (!text || text.length > 32) {
      return false;
    }

    return blockedLabels.some((label) => {
      return (
        text === label ||
        text === `${label}.` ||
        text === `${label}!` ||
        text.startsWith(`${label} `)
      );
    });
  }

  function getMainContainers(root = document) {
    const containers = new Set();

    if (root instanceof Element) {
      if (root.matches('main, [role="main"]')) {
        containers.add(root);
      } else {
        root.querySelectorAll('main, [role="main"]').forEach((element) => containers.add(element));

        if (root.closest('main, [role="main"]')) {
          containers.add(
            root.closest('[data-virtualized], [aria-posinset], div[role="article"]') || root
          );
        }
      }
    }

    if (root === document) {
      document.querySelectorAll('main, [role="main"]').forEach((element) => containers.add(element));
    }

    return [...containers];
  }

  function isSafeFeedTarget(target, statKey) {
    if (!(target instanceof Element)) {
      return false;
    }

    const removesMainShell =
      target === document.body ||
      target === document.documentElement ||
      target.matches('main, [role="main"]') ||
      !!target.querySelector('main, [role="main"]');
    if (removesMainShell) {
      return false;
    }

    const removesFeedHeading = [...target.querySelectorAll('h1, h2, h3, h4, [role="heading"]')]
      .some((heading) => normalizeText(heading.textContent) === "feed posts");
    const removesComposer = !!target.querySelector(
      '[role="region"][aria-label="Create a post"]'
    );
    const postActionMenuCount = target.querySelectorAll(
      '[role="button"][aria-label^="Actions for this post" i]'
    ).length;
    const isSinglePostRemoval = [
      "removedSponsored",
      "removedJoinPosts",
      "removedFollowPosts"
    ].includes(statKey);
    const crossesPostBoundary = isSinglePostRemoval
      ? postActionMenuCount > 1
      : postActionMenuCount > 0;
    return !(removesFeedHeading || removesComposer || crossesPostBoundary);
  }

  function removeFeedElement(target, statKey, deps) {
    if (
      !(target instanceof Element) ||
      !isSafeFeedTarget(target, statKey)
    ) {
      return;
    }

    const isFirstRemoval = !removedFeedElements.has(target);
    removedFeedElements.add(target);

    if (statKey && isFirstRemoval) {
      queueRuntimeStatIncrement(deps, statKey);
    }

    // React can reconnect the same DOM node after it has been removed. Keep
    // removing a reconnected node, but count the logical removal only once.
    target.remove();
  }

  function getNativeHideFeedUnit(target, statKey) {
    if (!(target instanceof Element)) {
      return null;
    }

    /*
      Facebook recycles feed cards through an outer virtualized item. Track that
      unit only to verify Facebook's native Hide action; never alter it directly.
    */
    const virtualizedUnit =
      target.closest("[data-virtualized]") ||
      target.closest("[aria-posinset]");

    if (
      virtualizedUnit instanceof Element &&
      isSafeFeedTarget(virtualizedUnit, statKey)
    ) {
      return virtualizedUnit;
    }

    return isSafeFeedTarget(target, statKey) ? target : null;
  }

  function getExactHiddenFeedbackMarkers(scope) {
    if (!(scope instanceof Element)) {
      return [];
    }

    const selector = 'h1, h2, h3, h4, [role="heading"], span, div';
    const candidates = [
      ...(scope.matches(selector) ? [scope] : []),
      ...scope.querySelectorAll(selector)
    ];
    return candidates.filter((element) => {
      const label = normalizeText(element.textContent);
      if (
        !HIDDEN_FEEDBACK_LABELS.has(label) &&
        label !== GENERIC_HIDDEN_FEEDBACK_LABEL
      ) {
        return false;
      }

      return ![...element.children].some((child) => {
        const childLabel = normalizeText(child.textContent);
        return (
          HIDDEN_FEEDBACK_LABELS.has(childLabel) ||
          childLabel === GENERIC_HIDDEN_FEEDBACK_LABEL
        );
      });
    });
  }

  function isGenericHiddenFeedback(scope, marker) {
    if (
      !(scope instanceof Element) ||
      !(marker instanceof Element) ||
      normalizeText(marker.textContent) !== GENERIC_HIDDEN_FEEDBACK_LABEL
    ) {
      return false;
    }

    const descriptionMatches = [...scope.querySelectorAll("span, div")]
      .filter((element) => {
        if (
          normalizeText(element.textContent) !==
          GENERIC_HIDDEN_FEEDBACK_DESCRIPTION
        ) {
          return false;
        }

        return ![...element.children].some((child) => {
          return (
            normalizeText(child.textContent) ===
            GENERIC_HIDDEN_FEEDBACK_DESCRIPTION
          );
        });
      });
    if (descriptionMatches.length !== 1) {
      return false;
    }

    const feedbackOptionCount = [
      ...scope.querySelectorAll('button, [role="button"]')
    ].filter((control) => {
      const label = normalizeText(
        control.getAttribute("aria-label") ||
        control.textContent
      );
      return (
        label === "content preferences" ||
        label.startsWith("unfollow ") ||
        label.startsWith("snooze ") ||
        label.startsWith("report post")
      );
    }).length;
    return feedbackOptionCount >= 1;
  }

  function getExactUndoControls(scope) {
    if (!(scope instanceof Element)) {
      return [];
    }

    const selector = 'button, a, [role="button"], [role="link"]';
    const candidates = [
      ...(scope.matches(selector) ? [scope] : []),
      ...scope.querySelectorAll(selector)
    ];
    return candidates.filter((control) => {
      const label = normalizeText(
        control.getAttribute("aria-label") ||
        control.textContent
      );
      return label === "undo";
    });
  }

  function getHiddenFeedbackContract(
    unit,
    { allowCompacted = false, expectedRoot = null } = {}
  ) {
    if (
      !(unit instanceof Element) ||
      !unit.isConnected ||
      !unit.matches("[data-virtualized], [aria-posinset]") ||
      unit.querySelector('[role="main"], [role="region"][aria-label="Create a post"]')
    ) {
      return null;
    }

    const scope = expectedRoot instanceof Element ? expectedRoot : unit;
    if (
      scope !== unit &&
      (!unit.contains(scope) || scope.parentElement !== unit)
    ) {
      return null;
    }

    const unitText = normalizeText(scope.textContent);
    if (
      ![...HIDDEN_FEEDBACK_LABELS].some((label) => unitText.includes(label)) &&
      !unitText.includes(GENERIC_HIDDEN_FEEDBACK_LABEL)
    ) {
      return null;
    }

    const markers = getExactHiddenFeedbackMarkers(scope);
    const undoControls = getExactUndoControls(scope);
    if (markers.length !== 1 || undoControls.length !== 1) {
      return null;
    }

    const [marker] = markers;
    const [undoControl] = undoControls;
    const markerLabel = normalizeText(marker.textContent);
    if (
      markerLabel === GENERIC_HIDDEN_FEEDBACK_LABEL &&
      !isGenericHiddenFeedback(scope, marker)
    ) {
      return null;
    }
    if (
      !allowCompacted &&
      (!isVisible(marker) ||
        !isVisible(undoControl) ||
        marker.closest('[aria-hidden="true"], [inert]') ||
        undoControl.closest('[aria-hidden="true"], [inert]'))
    ) {
      return null;
    }

    if (
      unit.querySelectorAll(
        '[role="button"][aria-label^="Actions for this post" i]'
      ).length > 0 ||
      hasPostFooterSignals(unit)
    ) {
      return null;
    }

    let contentRoot = expectedRoot instanceof Element
      ? expectedRoot
      : marker;
    while (
      contentRoot.parentElement &&
      contentRoot.parentElement !== unit
    ) {
      contentRoot = contentRoot.parentElement;
    }

    if (
      contentRoot === unit ||
      contentRoot.parentElement !== unit ||
      !contentRoot.contains(marker) ||
      !contentRoot.contains(undoControl) ||
      contentRoot.matches("[data-virtualized], [aria-posinset]") ||
      contentRoot.querySelector("[data-virtualized], [aria-posinset]")
    ) {
      return null;
    }

    if (!allowCompacted) {
      const rect = contentRoot.getBoundingClientRect();
      if (
        rect.width <= 0 ||
        rect.height < 20 ||
        rect.height > 1400 ||
        rect.bottom < -80 ||
        rect.top > window.innerHeight * 2
      ) {
        return null;
      }
    }

    return {
      contentRoot,
      kind: markerLabel,
      marker,
      undoControl
    };
  }

  function stopCompactedHiddenFeedbackMonitor(contentRoot) {
    const monitor = compactedHiddenFeedbackMonitors.get(contentRoot);
    monitor?.disconnect();
    compactedHiddenFeedbackMonitors.delete(contentRoot);
  }

  function stopPendingNativeHideTransition(unit) {
    const transition = pendingNativeHideTransitions.get(unit);
    transition?.observer.disconnect();
    pendingNativeHideTransitions.delete(unit);
  }

  function restorePendingNativeHideRoots(transition) {
    for (const contentRoot of transition?.contentRoots || []) {
      contentRoot.removeAttribute(PENDING_NATIVE_HIDE_ATTRIBUTE);
    }
  }

  function restoreCompactedHiddenFeedback(contentRoot, reason = "disabled") {
    if (!(contentRoot instanceof Element)) {
      return;
    }

    const wasCompacted = contentRoot.hasAttribute(
      COMPACT_HIDDEN_FEEDBACK_ATTRIBUTE
    );
    contentRoot.removeAttribute(COMPACT_HIDDEN_FEEDBACK_ATTRIBUTE);
    stopCompactedHiddenFeedbackMonitor(contentRoot);

    if (wasCompacted) {
      debugFeedCleanup("hidden-feedback-restored", { reason });
    }
  }

  function monitorCompactedHiddenFeedback(unit, contentRoot) {
    stopCompactedHiddenFeedbackMonitor(contentRoot);

    const observer = new MutationObserver(() => {
      if (!unit.isConnected || !contentRoot.isConnected) {
        restoreCompactedHiddenFeedback(contentRoot, "disconnected");
        return;
      }

      const contract = getHiddenFeedbackContract(unit, {
        allowCompacted: true,
        expectedRoot: contentRoot
      });
      if (!contract) {
        /*
          Facebook recycled this DOM node for ordinary content. Mutation
          observers run before paint, so restoring the attribute here prevents
          a recycled organic post from inheriting the compacted style.
        */
        restoreCompactedHiddenFeedback(contentRoot, "react-recycled");
      }
    });
    observer.observe(unit, {
      childList: true,
      subtree: true,
      characterData: true
    });
    compactedHiddenFeedbackMonitors.set(contentRoot, observer);
  }

  function getDirectFeedUnitContentRoot(unit, descendant = null) {
    if (!(unit instanceof Element) || !unit.isConnected) {
      return null;
    }

    if (descendant instanceof Element && unit.contains(descendant)) {
      let contentRoot = descendant;
      while (
        contentRoot.parentElement &&
        contentRoot.parentElement !== unit
      ) {
        contentRoot = contentRoot.parentElement;
      }

      if (contentRoot.parentElement === unit) {
        return contentRoot;
      }
    }

    return unit.children.length === 1
      ? unit.firstElementChild
      : null;
  }

  function restoreLateVisibleSponsoredSuppression(
    unit,
    reason = "restored"
  ) {
    const suppression = lateVisibleSponsoredSuppressions.get(unit);
    if (!suppression) {
      return;
    }

    suppression.observer?.disconnect();
    for (const contentRoot of suppression.contentRoots) {
      contentRoot.removeAttribute(LATE_SPONSORED_ATTRIBUTE);
    }
    lateVisibleSponsoredSuppressions.delete(unit);
    debugFeedCleanup("feed-sponsored-late-restored", { reason });
  }

  function restoreAllLateVisibleSponsoredSuppressions(reason = "disabled") {
    for (const unit of [...lateVisibleSponsoredSuppressions.keys()]) {
      restoreLateVisibleSponsoredSuppression(unit, reason);
    }
  }

  function reconcileLateVisibleSponsoredSuppressions(deps = {}) {
    const settings = getRuntimeSettings(deps);
    for (const unit of [...lateVisibleSponsoredSuppressions.keys()]) {
      const suppression = lateVisibleSponsoredSuppressions.get(unit);
      if (!unit.isConnected) {
        restoreLateVisibleSponsoredSuppression(unit, "disconnected");
      } else if (
        !settings?.enableFeedFilter ||
        settings.enableBlockSponsoredPosts === false
      ) {
        restoreLateVisibleSponsoredSuppression(unit, "setting-disabled");
      } else if (!hasSponsoredMarkerWithin(unit)) {
        const currentTarget = getCompletePostTargetWithin(
          unit,
          suppression?.target
        );
        const currentIdentity = getFeedPostIdentity(currentTarget);
        if (
          currentIdentity &&
          suppression?.postIdentity &&
          currentIdentity !== suppression.postIdentity
        ) {
          restoreLateVisibleSponsoredSuppression(unit, "react-recycled");
        }
      }
    }
  }

  function getFeedPostIdentity(target) {
    if (!(target instanceof Element)) {
      return "";
    }

    const actionLabel = normalizeText(
      target.querySelector(
        '[role="button"][aria-label^="Actions for this post" i]'
      )?.getAttribute("aria-label") || ""
    );
    const cftToken = [
      ...target.querySelectorAll('a[href*="__cft__"], [role="link"][href*="__cft__"]')
    ]
      .slice(0, 24)
      .map((link) => {
        const href = String(link.getAttribute("href") || "");
        return href.match(/[?&]__cft__\[0\]=([^&#]+)/)?.[1] || "";
      })
      .find(Boolean) || "";

    return actionLabel || cftToken
      ? `${actionLabel}|${cftToken}`
      : "";
  }

  function getCompletePostTargetWithin(unit, preferredTarget = null) {
    if (!(unit instanceof Element) || !unit.isConnected) {
      return null;
    }

    if (
      preferredTarget instanceof Element &&
      preferredTarget.isConnected &&
      unit.contains(preferredTarget) &&
      hasPostActionControl(preferredTarget) &&
      hasPostFooterSignals(preferredTarget)
    ) {
      return preferredTarget;
    }

    const targets = new Set();
    const actionControls = [
      ...unit.querySelectorAll(
        '[role="button"][aria-label^="Actions for this post" i]'
      )
    ].slice(0, 3);
    for (const actionControl of actionControls) {
      const target = getSponsoredPostContainer(actionControl);
      if (target instanceof Element && unit.contains(target)) {
        targets.add(target);
      }
    }

    return targets.size === 1 ? [...targets][0] : null;
  }

  function getSponsoredTargetWithin(unit, preferredTarget = null) {
    if (!(unit instanceof Element) || !unit.isConnected) {
      return null;
    }

    if (
      preferredTarget instanceof Element &&
      preferredTarget.isConnected &&
      unit.contains(preferredTarget) &&
      hasSponsoredMarkerWithin(preferredTarget)
    ) {
      return preferredTarget;
    }

    const explicitMarkers = [
      ...unit.querySelectorAll('[data-ad-rendering-role*="sponsored" i]')
    ];
    const metadataMarkers = [
      ...unit.querySelectorAll(
        'a[href*="__cft__"], [role="link"][href*="__cft__"]'
      )
    ].filter((link) => hasSponsoredLabel(link));

    for (const marker of [...explicitMarkers, ...metadataMarkers]) {
      const target = getSponsoredPostContainer(marker);
      if (target instanceof Element && unit.contains(target)) {
        return target;
      }
    }

    return null;
  }

  function suppressLateVisibleSponsored(unit, target, deps = {}) {
    const postIdentity = getFeedPostIdentity(target);
    if (
      !(unit instanceof Element) ||
      !(target instanceof Element) ||
      !postIdentity ||
      pendingNativeHideTransitions.has(unit) ||
      lateVisibleSponsoredSuppressions.has(unit) ||
      !getNativePostHideControl(target, { includeHideAd: true })
    ) {
      return false;
    }

    const contentRoot = getDirectFeedUnitContentRoot(unit, target);
    if (
      !(contentRoot instanceof Element) ||
      contentRoot === unit ||
      contentRoot.parentElement !== unit ||
      contentRoot.matches("[data-virtualized], [aria-posinset]") ||
      contentRoot.querySelector("[data-virtualized], [aria-posinset]")
    ) {
      return false;
    }

    const suppression = {
      contentRoots: new Set(),
      observer: null,
      postIdentity,
      target,
      unit
    };

    const markCurrentRoot = ({ allowIdentityFallback = false } = {}) => {
      let currentTarget = getSponsoredTargetWithin(
        unit,
        suppression.target
      );
      if (
        !(currentTarget instanceof Element) &&
        allowIdentityFallback
      ) {
        const identityTarget = getCompletePostTargetWithin(
          unit,
          suppression.target
        );
        if (
          getFeedPostIdentity(identityTarget) === suppression.postIdentity
        ) {
          currentTarget = identityTarget;
        }
      }
      if (!(currentTarget instanceof Element)) {
        return false;
      }

      const currentRoot = getDirectFeedUnitContentRoot(unit, currentTarget);
      if (
        !(currentRoot instanceof Element) ||
        currentRoot === unit ||
        currentRoot.parentElement !== unit ||
        currentRoot.matches("[data-virtualized], [aria-posinset]") ||
        currentRoot.querySelector("[data-virtualized], [aria-posinset]")
      ) {
        return false;
      }

      suppression.target = currentTarget;
      for (const previousRoot of [...suppression.contentRoots]) {
        if (previousRoot !== currentRoot) {
          previousRoot.removeAttribute(LATE_SPONSORED_ATTRIBUTE);
          suppression.contentRoots.delete(previousRoot);
        }
      }
      suppression.contentRoots.add(currentRoot);
      currentRoot.setAttribute(LATE_SPONSORED_ATTRIBUTE, "removedSponsored");
      return true;
    };

    const reconcile = () => {
      const settings = getRuntimeSettings(deps);
      if (
        !unit.isConnected ||
        !settings?.enableFeedFilter ||
        settings.enableBlockSponsoredPosts === false
      ) {
        restoreLateVisibleSponsoredSuppression(
          unit,
          unit.isConnected ? "setting-disabled" : "disconnected"
        );
        return;
      }

      if (!hasSponsoredMarkerWithin(unit)) {
        /*
          Facebook temporarily removes the accessible Sponsored label while
          rehydrating the same post. Keep that exact post suppressed and restore
          only after the virtualized unit exposes a different verified identity.
        */
        const currentTarget = getCompletePostTargetWithin(
          unit,
          suppression.target
        );
        const currentIdentity = getFeedPostIdentity(currentTarget);
        if (
          currentIdentity &&
          currentIdentity !== suppression.postIdentity
        ) {
          restoreLateVisibleSponsoredSuppression(unit, "react-recycled");
          return;
        }
        if (
          currentIdentity === suppression.postIdentity &&
          !markCurrentRoot({ allowIdentityFallback: true })
        ) {
          restoreLateVisibleSponsoredSuppression(unit, "boundary-changed");
        }
        return;
      }

      if (!markCurrentRoot()) {
        restoreLateVisibleSponsoredSuppression(unit, "boundary-changed");
      }
    };

    suppression.observer = new MutationObserver(reconcile);
    suppression.observer.observe(unit, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "data-ad-rendering-role",
        "hidden",
        "href",
        "role"
      ]
    });
    lateVisibleSponsoredSuppressions.set(unit, suppression);
    if (!markCurrentRoot()) {
      restoreLateVisibleSponsoredSuppression(unit, "initial-boundary-failed");
      return false;
    }

    queueRuntimeStatIncrement(deps, "removedSponsored");
    debugFeedCleanup("feed-sponsored-late-suppressed", {
      actionLabel: target.querySelector(
        '[role="button"][aria-label^="Actions for this post" i]'
      )?.getAttribute("aria-label") || ""
    });
    return true;
  }

  function beginNativeHideTransition(
    unit,
    target,
    {
      controlLabel = "",
      isOriginalContentStillPresent = () => false,
      statKey = ""
    } = {},
    deps = {}
  ) {
    if (!(unit instanceof Element) || !(target instanceof Element)) {
      return null;
    }

    stopPendingNativeHideTransition(unit);

    const settings = getRuntimeSettings(deps);
    const shouldCompact =
      !!settings?.enableFeedFilter &&
      settings.enableCompactHiddenCards !== false;
    const contentRoot = getDirectFeedUnitContentRoot(unit, target);
    const baselineBusyCount = unit.querySelectorAll(
      '[aria-busy="true"], [role="progressbar"], [role="status"]'
    ).length;
    const transition = {
      baselineBusyCount,
      contentRoots: new Set(),
      controlLabel,
      finished: false,
      isOriginalContentStillPresent,
      observer: null,
      sawBusyState: false,
      sawStructuralTransition: false,
      shouldCompact,
      statKey,
      target,
      unit
    };

    const markCurrentContentRoot = () => {
      if (!transition.shouldCompact || !unit.isConnected) {
        return;
      }

      const currentRoot = getDirectFeedUnitContentRoot(
        unit,
        target.isConnected ? target : null
      );
      if (!(currentRoot instanceof Element)) {
        return;
      }

      transition.contentRoots.add(currentRoot);
      currentRoot.setAttribute(PENDING_NATIVE_HIDE_ATTRIBUTE, statKey);
    };

    const finish = (result, contract = null) => {
      if (transition.finished) {
        return;
      }
      transition.finished = true;
      stopPendingNativeHideTransition(unit);
      restorePendingNativeHideRoots(transition);

      if (contract && transition.shouldCompact) {
        contract.contentRoot.setAttribute(
          COMPACT_HIDDEN_FEEDBACK_ATTRIBUTE,
          contract.kind
        );
        monitorCompactedHiddenFeedback(unit, contract.contentRoot);
      }

      if (result === "confirmed" && statKey) {
        queueRuntimeStatIncrement(deps, statKey);
      }

      debugFeedCleanup(`native-hide-${result}`, {
        controlLabel,
        kind: contract?.kind || "",
        statKey
      });
    };

    const reconcile = () => {
      if (transition.finished) {
        return;
      }

      if (!unit.isConnected) {
        finish("confirmed");
        return;
      }

      const contract = getHiddenFeedbackContract(unit, {
        allowCompacted: true
      });
      if (contract) {
        finish("confirmed", contract);
        return;
      }

      const busyCount = unit.querySelectorAll(
        '[aria-busy="true"], [role="progressbar"], [role="status"]'
      ).length;
      const busyNow = busyCount > baselineBusyCount;
      transition.sawBusyState ||= busyNow;
      transition.sawStructuralTransition ||= (
        !target.isConnected ||
        !hasPostActionControl(unit) ||
        !hasPostFooterSignals(unit)
      );

      /*
        Facebook may replace the original post with a spinner or an incomplete
        feedback shell. Collapse each single direct replacement root before
        paint while the observer waits for the exact native result.
      */
      markCurrentContentRoot();

      if (busyNow) {
        return;
      }

      const hasSettledPostShell =
        hasPostActionControl(unit) &&
        hasPostFooterSignals(unit);
      if (
        hasSettledPostShell &&
        (transition.sawBusyState || transition.sawStructuralTransition)
      ) {
        if (isOriginalContentStillPresent()) {
          finish("failed");
        } else {
          finish("confirmed");
        }
      }
    };

    transition.observer = new MutationObserver(reconcile);
    transition.observer.observe(unit, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-busy", "role"]
    });
    pendingNativeHideTransitions.set(unit, transition);

    /*
      Apply the collapse before invoking Facebook's native control. This keeps
      both the original post and Facebook's spinner out of the visible plane.
      MutationObserver then confirms the native result without polling delays.
    */
    markCurrentContentRoot();

    return {
      cancel: () => finish("failed"),
      reconcile
    };
  }

  function compactHiddenFeedbackUnit(unit, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (
      !settings?.enableFeedFilter ||
      settings.enableCompactHiddenCards === false
    ) {
      return false;
    }

    const existingRoot = unit instanceof Element
      ? unit.querySelector(`[${COMPACT_HIDDEN_FEEDBACK_ATTRIBUTE}]`)
      : null;
    if (existingRoot) {
      return true;
    }

    const contract = getHiddenFeedbackContract(unit);
    if (!contract) {
      return false;
    }

    const beforeHeight = Math.round(
      contract.contentRoot.getBoundingClientRect().height
    );
    contract.contentRoot.setAttribute(
      COMPACT_HIDDEN_FEEDBACK_ATTRIBUTE,
      contract.kind
    );
    monitorCompactedHiddenFeedback(unit, contract.contentRoot);
    debugFeedCleanup("hidden-feedback-compacted", {
      beforeHeight,
      kind: contract.kind
    });
    return true;
  }

  function compactHiddenFeedbackWithin(root = document, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (
      !settings?.enableFeedFilter ||
      settings.enableCompactHiddenCards === false
    ) {
      document
        .querySelectorAll(`[${COMPACT_HIDDEN_FEEDBACK_ATTRIBUTE}]`)
        .forEach((contentRoot) => {
          restoreCompactedHiddenFeedback(contentRoot, "setting-disabled");
        });
      document
        .querySelectorAll(`[${PENDING_NATIVE_HIDE_ATTRIBUTE}]`)
        .forEach((contentRoot) => {
          const unit = contentRoot.parentElement;
          if (unit instanceof Element) {
            stopPendingNativeHideTransition(unit);
          }
          contentRoot.removeAttribute(PENDING_NATIVE_HIDE_ATTRIBUTE);
        });
      return 0;
    }

    const units = new Set();
    for (const container of getMainContainers(root)) {
      if (container.matches("[data-virtualized], [aria-posinset]")) {
        units.add(container);
      }
      container
        .querySelectorAll("[data-virtualized], [aria-posinset]")
        .forEach((unit) => units.add(unit));
    }

    let compactedCount = 0;
    for (const unit of units) {
      if (!isSafeNativeHideCandidate(unit)) {
        continue;
      }
      compactedCount += Number(compactHiddenFeedbackUnit(unit, deps));
    }
    return compactedCount;
  }

  function markHidden(target, statKey, deps) {
    removeFeedElement(target, statKey, deps);
  }

  function getExactLabeledRegions(root, label) {
    const normalizedLabel = normalizeText(label);
    return getMatchingElements(root, '[role="region"][aria-label]')
      .filter((region) => {
        return normalizeText(region.getAttribute("aria-label")) === normalizedLabel;
      });
  }

  function restoreHiddenFeedModules(kind) {
    document
      .querySelectorAll(`[${HIDDEN_FEED_MODULE_ATTRIBUTE}="${kind}"]`)
      .forEach((element) => {
        element.removeAttribute(HIDDEN_FEED_MODULE_ATTRIBUTE);
      });
  }

  function hasExactHeading(container, label) {
    const normalizedLabel = normalizeText(label);
    return getMatchingElements(
      container,
      'h1, h2, h3, h4, [role="heading"]'
    ).some((heading) => normalizeText(heading.textContent) === normalizedLabel);
  }

  function isVerifiedStoriesRegion(region) {
    return (
      region instanceof Element &&
      normalizeText(region.getAttribute("aria-label")) === "stories" &&
      !!region.querySelector('[role="grid"][aria-label*="stor" i]') &&
      !hasPostActionControl(region) &&
      !!region.closest('[role="main"]')
    );
  }

  function isVerifiedReelsRegion(region) {
    return (
      region instanceof Element &&
      normalizeText(region.getAttribute("aria-label")) === "reels" &&
      region.querySelectorAll('a[href*="/reel/"]').length >= 2 &&
      !!region.closest('[role="main"]')
    );
  }

  function getReelsModuleRoot(region) {
    if (!isVerifiedReelsRegion(region)) {
      return null;
    }

    const main = region.closest('[role="main"]');
    let node = region;

    while (node && node !== main) {
      const actionMenuCount = node.querySelectorAll(
        '[role="button"][aria-label^="Actions for this post" i]'
      ).length;
      if (actionMenuCount > 1 || hasPostFooterSignals(node)) {
        return null;
      }
      if (
        actionMenuCount === 1 &&
        hasExactHeading(node, "reels")
      ) {
        return node;
      }
      node = node.parentElement;
    }

    return null;
  }

  function markFeedModuleHidden(target, kind, statKey, deps = {}) {
    if (
      !(target instanceof Element) ||
      !target.isConnected ||
      target.matches('main, [role="main"]') ||
      !!target.querySelector('[role="region"][aria-label="Create a post"]') ||
      [...target.querySelectorAll('h1, h2, h3, h4, [role="heading"]')]
        .some((heading) => normalizeText(heading.textContent) === "feed posts")
    ) {
      return false;
    }

    const wasAlreadyHidden =
      target.getAttribute(HIDDEN_FEED_MODULE_ATTRIBUTE) === kind;
    target.setAttribute(HIDDEN_FEED_MODULE_ATTRIBUTE, kind);
    if (!hiddenFeedModuleElements.has(target)) {
      hiddenFeedModuleElements.add(target);
      queueRuntimeStatIncrement(deps, statKey);
    }
    return !wasAlreadyHidden;
  }

  function reconcileHiddenFeedModules(root = document) {
    const hiddenModules = getMatchingElements(
      root,
      `[${HIDDEN_FEED_MODULE_ATTRIBUTE}]`
    );
    for (const module of hiddenModules) {
      const kind = module.getAttribute(HIDDEN_FEED_MODULE_ATTRIBUTE);
      const stillMatches = kind === "stories"
        ? isVerifiedStoriesRegion(module)
        : kind === "reels" &&
          getExactLabeledRegions(module, "reels")
            .some((region) => getReelsModuleRoot(region) === module);
      if (!stillMatches) {
        module.removeAttribute(HIDDEN_FEED_MODULE_ATTRIBUTE);
      }
    }
  }

  function isReelExperiencePage() {
    return /\/reel(?:s)?(?:\/|$)/i.test(String(window.location.pathname || ""));
  }

  function getReelRouteKey(value = window.location.href) {
    try {
      const url = new URL(String(value || ""), window.location.origin);
      return url.pathname.match(/\/reel\/([^/?#]+)/i)?.[1] || "";
    } catch (_error) {
      return "";
    }
  }

  function getExactSponsoredReelMarkers(root = document) {
    return getMatchingElements(root, 'span, a, [role="link"]')
      .filter((element) => {
        if (
          !(element instanceof Element) ||
          normalizeText(element.textContent) !== "sponsored"
        ) {
          return false;
        }

        const hasNestedExactMarker = [...element.children].some((child) => {
          return normalizeText(child.textContent) === "sponsored";
        });
        if (hasNestedExactMarker) {
          return false;
        }

        return !!element.closest(
          '[role="group"][aria-label="Video player" i]'
        );
      });
  }

  function resolveSponsoredReelItem(marker) {
    if (!(marker instanceof Element) || !marker.isConnected) {
      return null;
    }

    const main = marker.closest('main, [role="main"]');
    if (!(main instanceof Element) || marker.closest('[role="dialog"]')) {
      return null;
    }

    const viewportWidth =
      window.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight =
      window.innerHeight || document.documentElement?.clientHeight || 0;
    let node = marker;

    while (node && node !== main) {
      const videoCount = node.querySelectorAll("video").length;
      const parentVideoCount = node.parentElement?.querySelectorAll("video").length || 0;
      if (videoCount === 1 && parentVideoCount >= 2) {
        const rect = node.getBoundingClientRect();
        const hasViewportItemGeometry =
          rect.width >= viewportWidth * 0.75 &&
          rect.height >= viewportHeight * 0.75;
        const hasAdDestination =
          node.querySelectorAll(
            'a[target="_blank"], a[rel*="nofollow"]'
          ).length >= 1;

        if (hasViewportItemGeometry && hasAdDestination) {
          return node;
        }
      }

      node = node.parentElement;
    }

    return null;
  }

  function isVerifiedSponsoredReelItem(item, { allowHidden = false } = {}) {
    if (
      !(item instanceof Element) ||
      !item.isConnected ||
      item.matches('main, [role="main"]') ||
      item.closest('[role="dialog"]') ||
      item.querySelectorAll("video").length !== 1 ||
      (item.parentElement?.querySelectorAll("video").length || 0) < 2
    ) {
      return false;
    }

    const viewportWidth =
      window.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight =
      window.innerHeight || document.documentElement?.clientHeight || 0;
    const rect = item.getBoundingClientRect();
    if (
      (!allowHidden && (
        rect.width < viewportWidth * 0.75 ||
        rect.height < viewportHeight * 0.75
      )) ||
      item.querySelectorAll(
        'a[target="_blank"], a[rel*="nofollow"]'
      ).length < 1
    ) {
      return false;
    }

    return getExactSponsoredReelMarkers(item).some((marker) => {
      return allowHidden
        ? item.contains(marker)
        : resolveSponsoredReelItem(marker) === item;
    });
  }

  function restoreSponsoredReelItems({ clearRemovedRoutes = false } = {}) {
    document
      .querySelectorAll(`[${HIDDEN_SPONSORED_REEL_ATTRIBUTE}]`)
      .forEach((item) => {
        item.removeAttribute(HIDDEN_SPONSORED_REEL_ATTRIBUTE);
        skippedSponsoredReelItems.delete(item);
      });
    if (clearRemovedRoutes) {
      removedSponsoredReelRoutes.clear();
      countedSponsoredReelRoutes.clear();
    }
  }

  function reconcileSponsoredReelItems() {
    document
      .querySelectorAll(`[${HIDDEN_SPONSORED_REEL_ATTRIBUTE}]`)
      .forEach((item) => {
        if (!isVerifiedSponsoredReelItem(item, { allowHidden: true })) {
          item.removeAttribute(HIDDEN_SPONSORED_REEL_ATTRIBUTE);
          skippedSponsoredReelItems.delete(item);
        }
      });
  }

  function countSponsoredReelSkip(item, deps = {}, routeKey = "") {
    const normalizedRouteKey = String(routeKey || "");
    if (
      !(item instanceof Element) ||
      skippedSponsoredReelItems.has(item) ||
      (normalizedRouteKey && countedSponsoredReelRoutes.has(normalizedRouteKey))
    ) {
      return false;
    }

    skippedSponsoredReelItems.add(item);
    if (normalizedRouteKey) {
      countedSponsoredReelRoutes.add(normalizedRouteKey);
    }
    queueRuntimeStatIncrement(deps, "removedSponsoredReels");
    return true;
  }

  function hideSponsoredReelItem(item, deps = {}, routeKey = "") {
    if (!isVerifiedSponsoredReelItem(item)) {
      return false;
    }

    const wasHidden = item.hasAttribute(HIDDEN_SPONSORED_REEL_ATTRIBUTE);
    item.setAttribute(HIDDEN_SPONSORED_REEL_ATTRIBUTE, "true");
    countSponsoredReelSkip(item, deps, routeKey);
    return !wasHidden;
  }

  function isActiveReelItem(item) {
    if (!(item instanceof Element) || !item.isConnected) {
      return false;
    }

    const viewportHeight =
      window.innerHeight || document.documentElement?.clientHeight || 0;
    const viewportCenter = viewportHeight / 2;
    const rect = item.getBoundingClientRect();
    return rect.top <= viewportCenter && rect.bottom >= viewportCenter;
  }

  function runSponsoredReelFiltering(root = document, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (
      !settings?.enableFeedFilter ||
      !settings?.enableBlockSponsoredReels
    ) {
      restoreSponsoredReelItems({ clearRemovedRoutes: true });
      return 0;
    }

    if (!isReelExperiencePage()) {
      restoreSponsoredReelItems();
      return 0;
    }

    if (
      document.visibilityState !== "visible" ||
      [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .some((dialog) => isVisible(dialog))
    ) {
      return 0;
    }

    const currentRouteKey = getReelRouteKey();
    reconcileSponsoredReelItems();

    const items = new Set(
      getExactSponsoredReelMarkers(root)
        .map(resolveSponsoredReelItem)
        .filter((item) => item instanceof Element)
    );
    let actionCount = 0;

    for (const item of items) {
      if (item.hasAttribute(HIDDEN_SPONSORED_REEL_ATTRIBUTE)) {
        continue;
      }

      const routeKey =
        isActiveReelItem(item) ? currentRouteKey : "";
      if (routeKey) {
        removedSponsoredReelRoutes.add(routeKey);
      }
      if (hideSponsoredReelItem(item, deps, routeKey)) {
        actionCount += 1;
        debugFeedCleanup("sponsored-reel-removed", {
          routeKey,
          routeKnown: removedSponsoredReelRoutes.has(routeKey)
        });
      }
    }

    return actionCount;
  }

  function getPostContainerFromLabelButton(button) {
    const main = button.closest('[role="main"]') || document.body;
    let node = button;

    while (node && node !== main) {
      if (hasPostActionControl(node) && hasPostFooterSignals(node)) {
        return node;
      }

      node = node.parentElement;
    }

    return null;
  }

  function hasPeopleYouMayKnowSignals(container) {
    if (!(container instanceof Element)) {
      return false;
    }

    const ownLabel = normalizeText(container.getAttribute("aria-label"));
    const heading = container.querySelector('h1, h2, h3, h4, [role="heading"]');
    const headingText = heading ? normalizeText(heading.textContent) : "";
    const region = container.querySelector('[role="region"][aria-label]');
    const regionLabel = region ? normalizeText(region.getAttribute("aria-label")) : "";
    const hasPeopleLabel = [ownLabel, headingText, regionLabel].some((text) => {
      return /\bpeople you may know\b/i.test(text);
    });

    if (!hasPeopleLabel) {
      return false;
    }

    return (
      !!container.querySelector('a[href*="/friends/suggestions/"]') ||
      !!container.querySelector('[aria-label^="Add friend"], [aria-label^="Remove recommendation"]') ||
      !!container.querySelector('[href="/friends/"]')
    );
  }

  function getPeopleYouMayKnowContainer(start) {
    if (!(start instanceof Element)) {
      return null;
    }

    const main = start.closest('[role="main"]') || document.body;
    let node = start;

    while (node && node !== main) {
      if (
        node.matches('div.html-div, [data-virtualized], [aria-posinset], section, [role="region"]') &&
        hasPeopleYouMayKnowSignals(node)
      ) {
        return node;
      }

      node = node.parentElement;
    }

    return null;
  }

  function getSidebarSponsoredContainer(start) {
    if (!(start instanceof Element)) {
      return null;
    }

    if (start.closest('[role="main"]')) {
      return null;
    }

    let node = start;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.querySelector('[role="main"]')) {
        return null;
      }

      if (
        node.matches(
          '[data-visualcompletion="ignore-late-mutation"], [data-virtualized], section, aside, div'
        ) &&
        hasSponsoredSignals(node)
      ) {
        return node;
      }

      node = node.parentElement;
    }

    return null;
  }

  function getMatchingElements(scope, selector) {
    const elements = [];

    if (scope instanceof Element && scope.matches(selector)) {
      elements.push(scope);
    }

    if (scope instanceof Element) {
      const closestMatch = scope.closest(selector);
      if (closestMatch && !elements.includes(closestMatch)) {
        elements.push(closestMatch);
      }
    }

    scope.querySelectorAll(selector).forEach((element) => elements.push(element));
    return elements;
  }

  function getRenderedText(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const elementRect = element.getBoundingClientRect();
    if (
      elementRect.width < 1 ||
      elementRect.height < 1 ||
      elementRect.width > 140 ||
      elementRect.height > 32 ||
      element.querySelectorAll("*").length > 120
    ) {
      return "";
    }

    const fragments = [];
    const descendants = [element, ...element.querySelectorAll("*")];

    for (const parent of descendants) {
      for (const textNode of parent.childNodes) {
        if (textNode.nodeType !== 3) {
          continue;
        }

        const value = textNode.nodeValue || "";
        if (value.trim()) {
          const style = window.getComputedStyle(parent);
          if (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity) !== 0
          ) {
            const rect = parent.getBoundingClientRect();
            const centerY = rect.top + rect.height / 2;
            const intersectsElement =
              rect.width > 0 &&
              rect.height > 0 &&
              centerY >= elementRect.top - 1 &&
              centerY <= elementRect.bottom + 1 &&
              rect.right >= elementRect.left - 1 &&
              rect.left <= elementRect.right + 1;

            if (intersectsElement) {
              fragments.push({
                left: rect.left,
                top: rect.top,
                value
              });
            }
          }
        }
      }
    }

    fragments.sort((left, right) => {
      return Math.abs(left.top - right.top) > 2
        ? left.top - right.top
        : left.left - right.left;
    });

    return normalizeText(
      fragments
        .map((fragment) => fragment.value)
        .join("")
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    );
  }

  function normalizeSponsoredLabel(value) {
    return normalizeText(
      String(value || "").replace(SPONSORED_LABEL_NOISE_PATTERN, "")
    );
  }

  function hasReferencedSponsoredLabel(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    /*
      Current Facebook ad labels can keep the rendered glyph soup inside the
      link while assigning its clean accessible name through a descendant
      aria-labelledby reference whose target lives outside the link subtree.
      Resolve only a small, bounded set of IDs and still require the exact
      English label.
    */
    const labelledElements = [
      ...(element.hasAttribute("aria-labelledby") ? [element] : []),
      ...element.querySelectorAll("[aria-labelledby]")
    ].slice(0, 12);

    for (const labelledElement of labelledElements) {
      const labelIds = String(
        labelledElement.getAttribute("aria-labelledby") || ""
      )
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4);

      for (const labelId of labelIds) {
        const referencedLabel = document.getElementById(labelId);
        if (
          referencedLabel instanceof Element &&
          normalizeSponsoredLabel(
            referencedLabel.getAttribute("aria-label") ||
            referencedLabel.getAttribute("title") ||
            referencedLabel.textContent
          ) === "sponsored"
        ) {
          return true;
        }
      }
    }

    return false;
  }

  function hasSponsoredLabel(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const directLabel = normalizeSponsoredLabel(
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.textContent
    );

    return (
      directLabel === "sponsored" ||
      normalizeSponsoredLabel(getRenderedText(element)) === "sponsored" ||
      hasReferencedSponsoredLabel(element)
    );
  }

  function hasSponsoredStructuralMetadata(container) {
    if (!(container instanceof Element)) {
      return false;
    }

    /*
      Paid feed cards currently carry this ad-only rendering bundle even while
      Facebook temporarily removes or replaces the visible Sponsored label.
      Requiring all three roles plus an outbound link avoids treating an
      ordinary post with one coincidental rendering role as an advertisement.
    */
    return (
      !!container.querySelector('[data-ad-rendering-role="meta" i]') &&
      !!container.querySelector('[data-ad-rendering-role="title" i]') &&
      !!container.querySelector('[data-ad-rendering-role^="cta" i]') &&
      !!container.querySelector(
        'a[target="_blank"], a[role="link"][target="_blank"], a[rel*="nofollow"]'
      )
    );
  }

  function hasPostFooterSignals(container) {
    if (!(container instanceof Element)) {
      return false;
    }

    return [...container.querySelectorAll('[role="button"][aria-label]')].some((button) => {
      const label = normalizeText(button.getAttribute("aria-label"));
      return (
        label === "like" ||
        label === "react" ||
        label === "comment" ||
        label.startsWith("leave a comment") ||
        label === "share" ||
        label === "send"
      );
    });
  }

  function getSponsoredPostContainer(start) {
    if (!(start instanceof Element)) {
      return null;
    }

    const main = start.closest('[role="main"]');
    if (!main) {
      return null;
    }

    let node = start;
    while (node && node !== main) {
      const hasActionMenu = hasPostActionControl(node);

      if (hasActionMenu && hasPostFooterSignals(node)) {
        return node;
      }

      node = node.parentElement;
    }

    return null;
  }

  function hasSponsoredSignals(container) {
    if (!(container instanceof Element)) {
      return false;
    }

    const sponsoredHeadings = getMatchingElements(
      container,
      'h1, h2, h3, h4, [role="heading"]'
    );
    if (!sponsoredHeadings.some((heading) => hasSponsoredLabel(heading))) {
      return false;
    }

    const hasMenuButton = !!container.querySelector(
      '[role="button"][aria-label*="sponsored content" i], [role="button"][aria-label="More"]'
    );
    const hasOutbound = !!container.querySelector(
      'a[target="_blank"], a[role="link"][target="_blank"], a[rel*="nofollow"]'
    );
    const hasMedia = !!container.querySelector("img, video");

    return hasMenuButton && hasOutbound && hasMedia;
  }

  function hideReelsContainers(root = document, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (!settings?.enableFeedFilter || !settings?.enableBlockReels) {
      restoreHiddenFeedModules("reels");
      return;
    }

    reconcileHiddenFeedModules(root);
    const mainContainers = getMainContainers(root);

    for (const container of mainContainers) {
      for (const region of getExactLabeledRegions(container, "reels")) {
        const moduleRoot = getReelsModuleRoot(region);
        if (moduleRoot) {
          markFeedModuleHidden(
            moduleRoot,
            "reels",
            "removedReels",
            deps
          );
        }
      }
    }
  }

  function hideBlockedLabelContainers(root = document, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (!settings?.enableFeedFilter) {
      return;
    }

    const blockedLabels = getEnabledPostLabels(settings);
    if (blockedLabels.length === 0) {
      return;
    }

    const mainContainers = getMainContainers(root);

    for (const container of mainContainers) {
      const buttons = getMatchingElements(container, '[role="button"]');
      for (const button of buttons) {
        if (!isVisible(button)) {
          continue;
        }

        const spans = button.querySelectorAll("span");
        let matched = false;
        let matchedLabel = "";

        for (const span of spans) {
          const text = normalizeText(span.textContent);
          if (matchesBlockedLabel(text, blockedLabels)) {
            matched = true;
            matchedLabel = text.startsWith("join") ? "join" : text.startsWith("follow") ? "follow" : text;
            break;
          }
        }

        if (!matched) {
          const buttonText = normalizeText(button.textContent);
          matched = matchesBlockedLabel(buttonText, blockedLabels);
          if (matched) {
            matchedLabel = buttonText.startsWith("join") ? "join" : buttonText.startsWith("follow") ? "follow" : "";
          }
        }

        if (!matched) {
          continue;
        }

        const target = getPostContainerFromLabelButton(button);
        if (!target) {
          continue;
        }

        const hasPostContext =
          hasPostActionControl(target) ||
          target.querySelector('[data-ad-rendering-role="profile_name"]') ||
          target.querySelector("h4");

        if (hasPostContext) {
          const statKey = matchedLabel === "join" ? "removedJoinPosts" : "removedFollowPosts";
          markHidden(target, statKey, deps);
        }
      }
    }
  }

  function hideStoriesContainers(root = document, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (
      !settings?.enableFeedFilter ||
      settings.enableBlockStories === false
    ) {
      restoreHiddenFeedModules("stories");
      return;
    }

    reconcileHiddenFeedModules(root);
    const mainContainers = getMainContainers(root);

    for (const container of mainContainers) {
      for (const region of getExactLabeledRegions(container, "stories")) {
        if (isVerifiedStoriesRegion(region)) {
          markFeedModuleHidden(
            region,
            "stories",
            "removedStories",
            deps
          );
        }
      }
    }
  }

  function hidePeopleYouMayKnow(root = document, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (!settings?.enableFeedFilter || !settings?.enableBlockPeopleYouMayKnow) {
      return;
    }

    const mainContainers = getMainContainers(root);

    for (const container of mainContainers) {
      const titleCandidates = container.querySelectorAll('h1, h2, h3, h4, [role="heading"], [role="region"][aria-label]');
      for (const candidate of titleCandidates) {
        const text = normalizeText(candidate.textContent || candidate.getAttribute("aria-label"));
        if (!/\bpeople you may know\b/i.test(text)) {
          continue;
        }

        const target = getPeopleYouMayKnowContainer(candidate);
        if (!target) {
          continue;
        }

        markHidden(target, "removedPeopleYouMayKnow", deps);
      }
    }
  }

  function hideSidebarSponsored(root = document, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (
      !settings?.enableFeedFilter ||
      settings.enableBlockSponsoredSidebar === false
    ) {
      return;
    }

    const scope = root instanceof Element ? root : document;
    const headings = getMatchingElements(scope, 'h1, h2, h3, h4, [role="heading"]');

    for (const heading of headings) {
      if (!hasSponsoredLabel(heading)) {
        continue;
      }

      const candidate = getSidebarSponsoredContainer(heading);
      if (!candidate) {
        continue;
      }

      markHidden(candidate, "removedSponsored", deps);
    }
  }

  function runSidebarSponsoredFiltering(root = document, deps = {}) {
    hideSidebarSponsored(root, deps);
  }

  function isNearViewport(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= -window.innerHeight &&
      rect.top <= window.innerHeight * 2
    );
  }

  function isSafeNativeHideCandidate(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    /*
      Native Hide post/Hide ad replaces a React-owned feed unit. Never remove an
      already-passed or currently visible unit. Facebook can recycle its event
      mapping while the replacement is occurring, causing a click on the next
      visible card to open the hidden card's permalink. Only an upcoming unit
      with a full viewport buffer is safe for native replacement.
    */
    const rect = element.getBoundingClientRect();
    const safeTop = window.innerHeight + Math.max(160, window.innerHeight * 0.2);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top >= safeTop &&
      rect.top <= window.innerHeight * 2
    );
  }

  function isStartupVisibleSponsoredCandidate(element, deps = {}) {
    if (
      !(element instanceof Element) ||
      document.visibilityState !== "visible" ||
      typeof deps.hasTrustedPageInteraction !== "function" ||
      deps.hasTrustedPageInteraction()
    ) {
      return false;
    }

    /*
      A Sponsored unit already inside the first viewport can never satisfy the
      upcoming-card rule. It is safe to start Facebook's native hide before the
      first trusted input because the pointer-down handler cancels any queued
      feed pass before it records that input. beginNativeHideTransition()
      collapses only the unit's direct inner root before invoking the native
      control; the outer virtualized slot and Facebook's event ownership remain
      connected.
    */
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight
    );
  }

  function isLateVisibleSponsoredCandidate(element, deps = {}) {
    if (
      !(element instanceof Element) ||
      document.visibilityState !== "visible" ||
      typeof deps.hasTrustedPageInteraction !== "function" ||
      !deps.hasTrustedPageInteraction() ||
      (
        typeof deps.isRecentlyInteractedFeedUnit === "function" &&
        deps.isRecentlyInteractedFeedUnit(element)
      )
    ) {
      return false;
    }

    /*
      Slow Chromium variants can expose a Sponsored marker only after its card
      is already visible and the user has interacted with the page. Replacing
      that visible React unit through Facebook's native Hide action can recycle
      its permalink handler onto a neighbour. The late path therefore collapses
      only the verified direct inner root and keeps the outer virtualized unit
      connected and owned by Facebook.
    */
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight
    );
  }

  function getSponsoredMarkers(container) {
    const explicitMarkers = getMatchingElements(
      container,
      '[data-ad-rendering-role*="sponsored" i]'
    ).filter((marker) => isNearViewport(marker));
    const structuralMarkers = getMatchingElements(
      container,
      '[data-ad-rendering-role^="cta" i]'
    ).filter((marker) => {
      if (!isNearViewport(marker)) {
        return false;
      }

      const target = getSponsoredPostContainer(marker);
      return hasSponsoredStructuralMetadata(target);
    });
    const candidateLinks = getMatchingElements(
      container,
      'a[href*="__cft__"], [role="link"][href*="__cft__"]'
    ).filter((link) => isNearViewport(link));

    return {
      candidateLinks,
      markers: [
        ...explicitMarkers,
        ...structuralMarkers,
        ...candidateLinks.filter((link) => hasSponsoredLabel(link))
      ]
    };
  }

  function getNativePostHideControl(target, { includeHideAd = false } = {}) {
    if (!(target instanceof Element)) {
      return null;
    }

    const selector = [
      '[role="link"][aria-label^="Hide post by" i]',
      '[role="button"][aria-label^="Hide post by" i]',
      ...(includeHideAd
        ? [
          '[role="link"][aria-label^="Hide ad" i]',
          '[role="button"][aria-label^="Hide ad" i]'
        ]
        : [])
    ].join(", ");
    const controls = [...target.querySelectorAll(selector)]
      .filter((control) => isVisible(control));

    return controls.length === 1 ? controls[0] : null;
  }

  function hasSponsoredMarkerWithin(unit) {
    if (!(unit instanceof Element) || !unit.isConnected) {
      return false;
    }

    if (unit.querySelector('[data-ad-rendering-role*="sponsored" i]')) {
      return true;
    }

    if (hasSponsoredStructuralMetadata(unit)) {
      return true;
    }

    return getMatchingElements(
      unit,
      'a[href*="__cft__"], [role="link"][href*="__cft__"]'
    ).some((link) => hasSponsoredLabel(link));
  }

  function activateNativeSponsoredHide(unit, target, deps) {
    if (
      !(unit instanceof Element) ||
      !(target instanceof Element)
    ) {
      return false;
    }

    if (pendingNativeHideTransitions.has(unit)) {
      return false;
    }

    const control = getNativePostHideControl(target, { includeHideAd: true });
    if (!control) {
      debugFeedCleanup("feed-sponsored-native-hide-unavailable", {
        actionLabel: target.querySelector(
          '[role="button"][aria-label^="Actions for this post" i]'
        )?.getAttribute("aria-label") || ""
      });
      return false;
    }

    const controlLabel = control.getAttribute("aria-label") || "";
    const transition = beginNativeHideTransition(
      unit,
      target,
      {
        controlLabel,
        isOriginalContentStillPresent: () => hasSponsoredMarkerWithin(unit),
        statKey: "removedSponsored"
      },
      deps
    );
    try {
      control.click();
      transition?.reconcile();
    } catch (error) {
      transition?.cancel();
      debugFeedCleanup("feed-sponsored-native-hide-error", {
        controlLabel,
        message: String(error?.message || error || "")
      });
      return false;
    }
    return true;
  }

  function getBlockedPostLabel(button, blockedLabels) {
    if (!(button instanceof Element)) {
      return "";
    }

    const values = [
      normalizeText(button.getAttribute("aria-label")),
      normalizeText(button.textContent),
      ...[...button.querySelectorAll("span")]
        .map((span) => normalizeText(span.textContent))
    ];
    const matchedValue = values.find((value) => matchesBlockedLabel(value, blockedLabels)) || "";
    if (matchedValue.startsWith("join")) {
      return "join";
    }
    if (matchedValue.startsWith("follow")) {
      return "follow";
    }
    return "";
  }

  function isBlockedPostLabelButton(button, blockedLabels) {
    return (
      button instanceof Element &&
      isVisible(button) &&
      isNearViewport(button) &&
      !button.closest('[role="dialog"], [role="menu"], [role="toolbar"], nav, [role="navigation"]') &&
      button.getAttribute("aria-haspopup") !== "menu" &&
      !!getBlockedPostLabel(button, blockedLabels)
    );
  }

  function hasBlockedPostLabelWithin(unit, blockedLabel) {
    if (!(unit instanceof Element) || !unit.isConnected) {
      return false;
    }

    return getMatchingElements(unit, '[role="button"]')
      .some((button) => {
        return isVisible(button) &&
          getBlockedPostLabel(button, [blockedLabel]) === blockedLabel;
      });
  }

  function activateNativeBlockedPostHide(unit, target, blockedLabel, deps) {
    if (
      !(unit instanceof Element) ||
      !(target instanceof Element) ||
      !["follow", "join"].includes(blockedLabel)
    ) {
      return false;
    }

    if (pendingNativeHideTransitions.has(unit)) {
      return false;
    }

    const control = getNativePostHideControl(target);
    if (!control) {
      debugFeedCleanup("feed-blocked-label-native-hide-unavailable", {
        blockedLabel,
        actionLabel: target.querySelector(
          '[role="button"][aria-label^="Actions for this post" i]'
        )?.getAttribute("aria-label") || ""
      });
      return false;
    }

    const controlLabel = control.getAttribute("aria-label") || "";
    const statKey = blockedLabel === "join"
      ? "removedJoinPosts"
      : "removedFollowPosts";
    const transition = beginNativeHideTransition(
      unit,
      target,
      {
        controlLabel,
        isOriginalContentStillPresent: () => {
          return hasBlockedPostLabelWithin(unit, blockedLabel);
        },
        statKey
      },
      deps
    );
    try {
      control.click();
      transition?.reconcile();
    } catch (error) {
      transition?.cancel();
      debugFeedCleanup("feed-blocked-label-native-hide-error", {
        blockedLabel,
        controlLabel,
        message: String(error?.message || error || "")
      });
      return false;
    }
    return true;
  }

  function hideBlockedLabelPostsNatively(root = document, deps = {}) {
    const settings = getRuntimeSettings(deps);
    if (!settings?.enableFeedFilter) {
      return;
    }

    const blockedLabels = getEnabledPostLabels(settings);
    if (blockedLabels.length === 0) {
      return;
    }

    const handledUnits = new Set();
    for (const container of getMainContainers(root)) {
      const buttons = getMatchingElements(container, '[role="button"]');
      for (const button of buttons) {
        if (!isBlockedPostLabelButton(button, blockedLabels)) {
          continue;
        }

        const blockedLabel = getBlockedPostLabel(button, blockedLabels);
        const target = getPostContainerFromLabelButton(button);
        const statKey = blockedLabel === "join"
          ? "removedJoinPosts"
          : "removedFollowPosts";
        const unit = getNativeHideFeedUnit(target, statKey);
        if (!unit || !isSafeNativeHideCandidate(unit) || handledUnits.has(unit)) {
          continue;
        }

        handledUnits.add(unit);
        activateNativeBlockedPostHide(unit, target, blockedLabel, deps);
      }
    }
  }

  function runSponsoredFeedFiltering(root = document, deps = {}) {
    /*
      Remove the extension-owned placeholder left by the short-lived masking
      implementation. This never touches a Facebook-owned node.
    */
    document.querySelector("[data-faceberg-sponsored-mask-host]")?.remove();

    const settings = getRuntimeSettings(deps);
    reconcileLateVisibleSponsoredSuppressions(deps);
    hideStoriesContainers(root, deps);
    hideReelsContainers(root, deps);
    if (!settings?.enableFeedFilter) {
      restoreAllLateVisibleSponsoredSuppressions("feed-filter-disabled");
      compactHiddenFeedbackWithin(root, deps);
      return;
    }

    if (
      window.location.pathname !== "/" ||
      [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .some((dialog) => isVisible(dialog))
    ) {
      return;
    }

    compactHiddenFeedbackWithin(root, deps);
    hideSidebarSponsored(root, deps);
    hideBlockedLabelPostsNatively(root, deps);

    if (settings.enableBlockSponsoredPosts === false) {
      restoreAllLateVisibleSponsoredSuppressions(
        "sponsored-filter-disabled"
      );
      return;
    }

    const mainContainers = getMainContainers(root);
    let candidateCount = 0;
    let markerCount = 0;
    let activatedTargetCount = 0;
    let activatedStartupVisibleCount = 0;
    let suppressedLateVisibleCount = 0;
    const handledUnits = new Set();

    for (const container of mainContainers) {
      const { candidateLinks, markers } = getSponsoredMarkers(container);
      candidateCount += candidateLinks.length;
      markerCount += markers.length;

      for (const marker of new Set(markers)) {
        const target = getSponsoredPostContainer(marker);
        const unit = getNativeHideFeedUnit(target, "removedSponsored");
        const isUpcomingCandidate =
          unit instanceof Element && isSafeNativeHideCandidate(unit);
        const isStartupVisibleCandidate =
          unit instanceof Element &&
          isStartupVisibleSponsoredCandidate(unit, deps);
        const isLateVisibleCandidate =
          unit instanceof Element &&
          isLateVisibleSponsoredCandidate(unit, deps);
        if (
          !unit ||
          (
            !isUpcomingCandidate &&
            !isStartupVisibleCandidate &&
            !isLateVisibleCandidate
          ) ||
          handledUnits.has(unit)
        ) {
          continue;
        }

        handledUnits.add(unit);
        if (
          isLateVisibleCandidate &&
          !isUpcomingCandidate &&
          !isStartupVisibleCandidate
        ) {
          suppressedLateVisibleCount += Number(
            suppressLateVisibleSponsored(unit, target, deps)
          );
        } else if (activateNativeSponsoredHide(unit, target, deps)) {
          activatedTargetCount += 1;
          if (isStartupVisibleCandidate) {
            activatedStartupVisibleCount += 1;
          }
        }
      }
    }

    if (markerCount > 0 || activatedTargetCount > 0) {
      debugFeedCleanup("feed-sponsored-native-hide", {
        candidateCount,
        markerCount,
        activatedTargetCount,
        activatedStartupVisibleCount,
        suppressedLateVisibleCount
      });
    }
  }

  function runFeedCleanup(root = document, deps = {}) {
    hideSidebarSponsored(root, deps);
    hideStoriesContainers(root, deps);
    hideReelsContainers(root, deps);

    if (!ENABLE_REACT_FEED_MUTATIONS) {
      return;
    }

    hidePeopleYouMayKnow(root, deps);
    hideBlockedLabelContainers(root, deps);
  }

  globalThis.FacebergFeedRuntime = Object.freeze({
    runSidebarSponsoredFiltering,
    runSponsoredFeedFiltering,
    runSponsoredReelFiltering,
    runFeedCleanup
  });
})();
