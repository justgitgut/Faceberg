(() => {
  "use strict";

  const COMMENT_INTENT_BRIDGE_VERSION = 7;
  const COMMENT_INTENT_REQUEST_EVENT = "__facebergCommentIntentRequestV7";
  const COMMENT_INTENT_RESULT_EVENT = "__facebergCommentIntentResultV7";

  /*
    Facebook's current comment-order toggle and menu rows are implemented by
    Pressable/FDSMenuItem. Programmatic DOM clicks from an isolated
    content-script world can either be ignored or produce a transient popup
    without committing the React state. Keep this bridge in the page world and
    accept only the exact visible sorter toggle or All comments row.
  */
  function installCommentIntentBridge() {
    if (
      Number(window.__facebergCommentIntentBridgeState?.version || 0) >=
      COMMENT_INTENT_BRIDGE_VERSION
    ) {
      return;
    }

    const bridgeState = {
      version: COMMENT_INTENT_BRIDGE_VERSION,
      lastResult: null
    };

    function normalizeBridgeText(value) {
      return String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    function getPrimaryRowText(row) {
      const visibleText = String(row?.innerText || "")
        .split(/\r?\n/)
        .map((part) => normalizeBridgeText(part))
        .find(Boolean);
      return visibleText || normalizeBridgeText(row?.getAttribute?.("aria-label"));
    }

    function isVisibleBridgeElement(element) {
      if (!(element instanceof Element) || !element.isConnected) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0
      );
    }

    function getHandlerFromProps(props, candidate, source) {
      if (!props || (typeof props !== "object" && typeof props !== "function")) {
        return null;
      }

      if (typeof props.onClick === "function") {
        return {
          candidate,
          handler: props.onClick,
          handlerName: "onClick",
          source
        };
      }

      if (typeof props.onPress === "function") {
        return {
          candidate,
          handler: props.onPress,
          handlerName: "onPress",
          source
        };
      }

      return null;
    }

    function getEventHandlePressHandler(listeners, candidate, source) {
      if (
        !listeners ||
        typeof listeners[Symbol.iterator] !== "function"
      ) {
        return null;
      }

      const matchingListeners = [];
      for (const listener of listeners) {
        if (!listener || typeof listener !== "object") {
          continue;
        }

        const type = normalizeBridgeText(listener.type);
        if (
          typeof listener.callback === "function" &&
          (type === "click" || type === "press")
        ) {
          matchingListeners.push({
            callback: listener.callback,
            capture: listener.capture === true,
            type
          });
        }
      }

      /*
        ReactDOM.createEventHandle stores one record per event type. Prefer the
        bubbling click listener used by Pressable; a capture listener is still
        valid when it is the only exact activation callback on this element.
      */
      matchingListeners.sort(
        (left, right) => Number(left.capture) - Number(right.capture)
      );
      const listener = matchingListeners[0];
      if (listener) {
        return {
          candidate,
          handler: listener.callback,
          handlerName: `eventHandle:${listener.type}`,
          source,
          eventHandleType: listener.type
        };
      }

      /*
        Facebook's current Pressable registers pointer/mouse state through
        createEventHandle but keeps the committed action in React's delegated
        click path. The exact validated control can therefore use its one native
        HTMLElement click without a synthetic pointer prelude.
      */
      const eventTypes = new Set(
        [...listeners]
          .map((entry) => normalizeBridgeText(entry?.type))
          .filter(Boolean)
      );
      if (
        eventTypes.has("pointerdown") ||
        eventTypes.has("mousedown") ||
        eventTypes.has("keydown")
      ) {
        return {
          candidate,
          dispatchNativeClick: true,
          handlerName: "eventHandle:native-click",
          source
        };
      }

      return null;
    }

    function createEventHandleArgument(target, type) {
      const rect = target.getBoundingClientRect();
      const clientX = Math.max(0, rect.left + Math.min(rect.width / 2, 8));
      const clientY = Math.max(0, rect.top + Math.min(rect.height / 2, 8));
      const nativeEvent = new MouseEvent(type === "press" ? "click" : type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        detail: 1,
        button: 0,
        buttons: 0,
        clientX,
        clientY
      });
      let propagationStopped = false;

      /*
        createEventHandle callbacks receive a React SyntheticEvent. Facebook's
        Pressable callback uses only this public event surface, so provide that
        shape without redispatching a second DOM event or crossing feed cards.
      */
      return {
        _reactName: null,
        bubbles: true,
        button: 0,
        buttons: 0,
        cancelable: true,
        clientX,
        clientY,
        currentTarget: target,
        defaultPrevented: false,
        detail: 1,
        eventPhase: Event.AT_TARGET,
        isDefaultPrevented() {
          return this.defaultPrevented;
        },
        isPropagationStopped() {
          return propagationStopped;
        },
        isTrusted: false,
        nativeEvent,
        persist() {},
        preventDefault() {
          this.defaultPrevented = true;
          nativeEvent.preventDefault();
        },
        stopPropagation() {
          propagationStopped = true;
          nativeEvent.stopPropagation();
        },
        target,
        timeStamp: nativeEvent.timeStamp,
        type: nativeEvent.type
      };
    }

    function getReactPressHandler(row) {
      const candidates = [row, ...row.querySelectorAll("*")].slice(0, 40);
      for (const candidate of candidates) {
        for (const propertyName of Object.getOwnPropertyNames(candidate)) {
          if (
            propertyName.startsWith("__reactProps$") ||
            propertyName.startsWith("__reactEventHandlers$")
          ) {
            const handler = getHandlerFromProps(
              candidate[propertyName],
              candidate,
              propertyName.split("$")[0]
            );
            if (handler) {
              return handler;
            }
          }

          if (propertyName.startsWith("__reactListeners$")) {
            const handler = getEventHandlePressHandler(
              candidate[propertyName],
              candidate,
              "__reactListeners"
            );
            if (handler) {
              return handler;
            }
          }

          if (!propertyName.startsWith("__reactFiber$")) {
            continue;
          }

          /*
            Current Facebook builds can expose only the host Fiber on Pressable
            nodes. Walk through wrapper components but stop before crossing into
            a different host DOM element, so the resolved callback still belongs
            to this exact sorter control or menu row.
          */
          let fiber = candidate[propertyName];
          for (let depth = 0; fiber && depth < 14; depth += 1) {
            if (
              depth > 0 &&
              fiber.stateNode instanceof Element &&
              fiber.stateNode !== candidate
            ) {
              break;
            }

            for (const [propsName, props] of [
              ["memoizedProps", fiber.memoizedProps],
              ["pendingProps", fiber.pendingProps]
            ]) {
              const handler = getHandlerFromProps(
                props,
                candidate,
                `fiber.${propsName}`
              );
              if (handler) {
                return handler;
              }
            }

            fiber = fiber.return;
          }
        }
      }

      return null;
    }

    function describeReactBindings(target) {
      const candidates = [target, ...target.querySelectorAll("*")].slice(0, 40);
      const propertyNames = [];
      const listenerStores = [];
      for (const candidate of candidates) {
        for (const propertyName of Object.getOwnPropertyNames(candidate)) {
          if (
            propertyName.startsWith("__react") &&
            !propertyNames.includes(propertyName.split("$")[0])
          ) {
            propertyNames.push(propertyName.split("$")[0]);
          }

          if (
            propertyName.startsWith("__reactListeners$") &&
            candidate[propertyName] &&
            typeof candidate[propertyName][Symbol.iterator] === "function"
          ) {
            const eventTypes = [];
            let listenerCount = 0;
            for (const listener of candidate[propertyName]) {
              listenerCount += 1;
              const type = normalizeBridgeText(listener?.type);
              if (type && !eventTypes.includes(type)) {
                eventTypes.push(type);
              }
            }
            listenerStores.push({
              eventTypes: eventTypes.slice(0, 16),
              listenerCount,
              target: candidate === target ? "target" : candidate.tagName.toLowerCase()
            });
          }
        }
      }

      return {
        candidateCount: candidates.length,
        listenerStores: listenerStores.slice(0, 12),
        propertyNames: propertyNames.slice(0, 12)
      };
    }

    function emitBridgeResult(row, result) {
      bridgeState.lastResult = result;
      try {
        row.dispatchEvent(
          new CustomEvent(COMMENT_INTENT_RESULT_EVENT, {
            bubbles: true,
            composed: true,
            detail: JSON.stringify(result)
          })
        );
      } catch (_error) {
        /* A diagnostic response must never affect Facebook's UI. */
      }
    }

    document.addEventListener(COMMENT_INTENT_REQUEST_EVENT, (event) => {
      let request = null;
      try {
        request = JSON.parse(String(event.detail || ""));
      } catch (_error) {
        return;
      }

      const target = event.target;
      const intent = String(request?.intent || "");
      const menu = target instanceof Element
        ? target.closest('[role="menu"][aria-label="Comment Ordering"]')
        : null;
      const result = {
        requestId: String(request?.requestId || ""),
        activated: false,
        bridgeVersion: COMMENT_INTENT_BRIDGE_VERSION,
        handlerName: "",
        reason: ""
      };

      const isAllCommentsRow =
        intent === "all-comments" &&
        target instanceof Element &&
        target.matches(
          '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="radio"]'
        ) &&
        menu instanceof Element &&
        isVisibleBridgeElement(menu) &&
        getPrimaryRowText(target) === "all comments";
      const isSorterToggle =
        intent === "toggle-comment-ordering" &&
        target instanceof Element &&
        target.matches(
          '[role="button"][aria-haspopup="menu"], [role="link"][aria-haspopup="menu"], [tabindex][aria-haspopup="menu"]'
        ) &&
        !target.closest('[role="menu"], [role="toolbar"]') &&
        target.closest('[role="dialog"][aria-modal="true"]') instanceof Element &&
        /^(?:most relevant|newest|all comments|oldest|top comments|recent)$/i.test(
          getPrimaryRowText(target)
        );

      if (
        !result.requestId ||
        !(target instanceof Element) ||
        !isVisibleBridgeElement(target) ||
        (!isAllCommentsRow && !isSorterToggle)
      ) {
        result.reason = "invalid-target";
        if (target instanceof Element) {
          emitBridgeResult(target, result);
        }
        return;
      }

      const pressHandler = getReactPressHandler(target);
      if (!pressHandler) {
        result.reason = "react-handler-not-found";
        result.diagnostic = describeReactBindings(target);
        emitBridgeResult(target, result);
        return;
      }

      try {
        if (pressHandler.dispatchNativeClick) {
          pressHandler.candidate.click();
        } else if (pressHandler.eventHandleType) {
          pressHandler.handler(
            createEventHandleArgument(
              pressHandler.candidate,
              pressHandler.eventHandleType
            )
          );
        } else {
          /*
            Direct FDS menu-row props are closures over their intended action
            and are explicitly zero-argument. Do not pass an event to that
            separate callback shape.
          */
          pressHandler.handler();
        }
        result.activated = true;
        result.handlerName = pressHandler.handlerName;
        result.handlerSource = pressHandler.source;
        result.reason = pressHandler.dispatchNativeClick
          ? "native-click-invoked"
          : "react-handler-invoked";
      } catch (error) {
        result.reason = "react-handler-threw";
        result.error = String(error?.message || error || "").slice(0, 200);
      }

      emitBridgeResult(target, result);
    }, true);

    window.__facebergCommentIntentBridgeState = bridgeState;
  }

  installCommentIntentBridge();

  const COMPATIBILITY_GUARD_VERSION = 13;
  const COMPATIBILITY_CONFIG_KIND = "anti-refresh-config-v13";
  const SPA_NAVIGATION_EVENT = "__facebergSpaNavigationV1";
  const existingGuardVersion = Number(
    window.__facebergAntiRefreshState?.version || 0
  );

  if (
    window.__facebergNoRefreshInstalled &&
    existingGuardVersion >= COMPATIBILITY_GUARD_VERSION
  ) {
    return;
  }

  /*
    An extension reload can reinject this file into an existing Facebook
    document. Disable an older listener through its legacy config channel, then
    install the replacement through a versioned channel that the retired
    listener cannot observe or re-enable.
  */
  if (window.__facebergNoRefreshInstalled && existingGuardVersion > 0) {
    for (const kind of [
      "anti-refresh-config",
      "anti-refresh-config-v4",
      "anti-refresh-config-v5",
      "anti-refresh-config-v6",
      "anti-refresh-config-v7",
      "anti-refresh-config-v8",
      "anti-refresh-config-v9",
      "anti-refresh-config-v10",
      "anti-refresh-config-v11",
      "anti-refresh-config-v12"
    ]) {
      window.postMessage(
        {
          source: "faceberg",
          kind,
          enabled: false
        },
        "*"
      );
    }
  }

  window.__facebergNoRefreshInstalled = true;

  /*
    Compatibility mode keeps the old broad anti-refresh implementation below
    disabled. Install only a narrow navigation guard during the hidden/return
    interval. Visibility and focus remain untouched because Facebook and the
    browser use them to coordinate media playback. Only Navigation API reloads
    and pushState/replaceState Home resets are guarded; no DOM, timer, fetch,
    location, or browser method is changed.
  */
  const COMPATIBILITY_SAFE_MODE = true;
  if (COMPATIBILITY_SAFE_MODE) {
    const GUARD_VERSION = COMPATIBILITY_GUARD_VERSION;
    const RESUME_GUARD_WINDOW_MS = 8000;
    const USER_NAVIGATION_GRACE_MS = 1500;
    let enabled = false;
    let wasHidden = document.visibilityState === "hidden";
    let resumeGuardUntil = 0;
    let lastTrustedInteractionAt = 0;
    let blockedNavigationCount = 0;
    let lastConfigAt = 0;
    let lastNavigationEvent = null;

    function beginResumeGuard(now = Date.now()) {
      resumeGuardUntil = Math.max(resumeGuardUntil, now + RESUME_GUARD_WINDOW_MS);
    }

    function noteTrustedInteraction(event) {
      if (event?.isTrusted === true) {
        lastTrustedInteractionAt = Date.now();
      }
    }

    function isResumeGuardWindow(now = Date.now()) {
      return (
        wasHidden ||
        document.visibilityState === "hidden" ||
        now < resumeGuardUntil
      );
    }

    function isAutomaticResumeNavigation() {
      const now = Date.now();
      return enabled &&
        isResumeGuardWindow(now) &&
        (lastTrustedInteractionAt === 0 || now - lastTrustedInteractionAt > USER_NAVIGATION_GRACE_MS);
    }

    function normalizePathname(pathname) {
      const normalized = String(pathname || "/").replace(/\/+$/, "");
      return normalized || "/";
    }

    function isRootFeedPath(pathname) {
      const normalized = normalizePathname(pathname);
      return normalized === "/" || normalized === "/home.php";
    }

    function isAutomaticHomeRouteReset(target) {
      if (!isAutomaticResumeNavigation()) {
        return false;
      }

      try {
        const destination = new URL(String(target), window.location.href);
        const current = new URL(window.location.href);
        return (
          destination.origin === current.origin &&
          !isRootFeedPath(current.pathname) &&
          isRootFeedPath(destination.pathname)
        );
      } catch (_error) {
        return false;
      }
    }

    function emitNavigationDiagnostic(details) {
      try {
        document.dispatchEvent(
          new CustomEvent("__facebergAntiRefreshNavigation", {
            detail: JSON.stringify(details)
          })
        );
      } catch (_error) {
        /* Diagnostics must never affect navigation handling. */
      }
    }

    function emitSpaNavigation(methodName, destination) {
      try {
        document.dispatchEvent(
          new CustomEvent(SPA_NAVIGATION_EVENT, {
            detail: JSON.stringify({
              method: methodName,
              destination: destination == null ? "" : String(destination),
              url: window.location.href
            })
          })
        );
      } catch (_error) {
        /* SPA wake diagnostics must never affect Facebook navigation. */
      }
    }

    function reportBlockedNavigation(kind, target = "", details = {}) {
      blockedNavigationCount += 1;
      window.postMessage(
        {
          source: "faceberg",
          kind: "stat",
          stat: "preventedRefreshes",
          count: 1
        },
        "*"
      );

      const diagnostic = {
        ...details,
        at: Date.now(),
        blocked: true,
        destination: target,
        eventKind: details.eventKind || kind,
        navigationType: details.navigationType || (
          kind === "reload" ? "reload" : "route-reset"
        ),
        visibilityState: document.visibilityState,
        guardVersion: GUARD_VERSION
      };
      lastNavigationEvent = diagnostic;
      emitNavigationDiagnostic(diagnostic);
    }

    function guardHistoryRouteResets() {
      for (const methodName of ["pushState", "replaceState"]) {
        try {
          const original = window.history?.[methodName];
          if (
            typeof original !== "function" ||
            original.__facebergGuardVersion >= GUARD_VERSION
          ) {
            continue;
          }

          const wrapped = function (...args) {
            const destination = args[2];
            if (
              destination != null &&
              isAutomaticHomeRouteReset(destination)
            ) {
              reportBlockedNavigation(
                `history.${methodName}`,
                String(destination)
              );
              return undefined;
            }

            const result = original.apply(this, args);
            emitSpaNavigation(methodName, destination);
            return result;
          };
          Object.defineProperty(wrapped, "__facebergGuardVersion", {
            value: GUARD_VERSION
          });
          window.history[methodName] = wrapped;
        } catch (_error) {
          /* History methods are normally writable; Navigation API remains the fallback. */
        }
      }
    }

    const handledVisibilityEvents = new WeakSet();
    function handleVisibilityChange(event) {
      if (handledVisibilityEvents.has(event)) {
        return;
      }
      handledVisibilityEvents.add(event);

      if (document.visibilityState === "hidden") {
        wasHidden = true;
        emitNavigationDiagnostic({
          at: Date.now(),
          blocked: false,
          eventKind: "visibility-hidden",
          navigationType: "",
          userInitiated: false,
          visibilityState: document.visibilityState,
          enabled,
          resumeGuardUntil,
          guardVersion: GUARD_VERSION
        });
        return;
      }

      if (wasHidden) {
        wasHidden = false;
        beginResumeGuard();
        const details = {
          at: Date.now(),
          blocked: false,
          eventKind: "visibility-visible",
          navigationType: "",
          userInitiated: false,
          visibilityState: document.visibilityState,
          enabled,
          resumeGuardUntil,
          suppression: "none",
          guardVersion: GUARD_VERSION
        };
        lastNavigationEvent = details;
        emitNavigationDiagnostic(details);
      }
    }

    /*
      Record the return transition but never suppress it. Blocking visibility
      and focus did not prevent Facebook's soft feed reset, while those events
      are required for reliable Reel playback.
    */
    window.addEventListener("visibilitychange", handleVisibilityChange, true);
    document.addEventListener("visibilitychange", handleVisibilityChange, true);

    for (const eventType of ["pointerdown", "keydown", "touchstart"]) {
      document.addEventListener(eventType, noteTrustedInteraction, {
        capture: true,
        passive: true
      });
    }

    window.addEventListener("message", (event) => {
      if (
        event.source !== window ||
        event.data?.source !== "faceberg" ||
        event.data?.kind !== COMPATIBILITY_CONFIG_KIND
      ) {
        return;
      }

      enabled = event.data.enabled === true;
      lastConfigAt = Date.now();
      if (!enabled) {
        resumeGuardUntil = 0;
        wasHidden = document.visibilityState === "hidden";
      }
    }, true);

    if (window.navigation?.addEventListener) {
      window.navigation.addEventListener("navigate", (event) => {
        if (!enabled || !isResumeGuardWindow()) {
          return;
        }

        const details = {
          at: Date.now(),
          cancelable: event.cancelable === true,
          destination: event.destination?.url || "",
          eventKind: "navigate",
          navigationType: event.navigationType || "",
          userInitiated: event.userInitiated === true,
          visibilityState: document.visibilityState,
          enabled,
          resumeGuardUntil,
          automaticResumeNavigation: isAutomaticResumeNavigation(),
          guardVersion: GUARD_VERSION
        };
        lastNavigationEvent = details;

        const blocksReload = event.navigationType === "reload";
        const blocksRouteReset = isAutomaticHomeRouteReset(
          event.destination?.url || ""
        );
        if (
          (!blocksReload && !blocksRouteReset) ||
          event.userInitiated === true ||
          event.cancelable !== true ||
          !isAutomaticResumeNavigation()
        ) {
          emitNavigationDiagnostic({
            ...details,
            blocked: false,
            rejectionReason:
              !blocksReload && !blocksRouteReset
                ? "not-reload-or-route-reset"
                : event.userInitiated === true
                  ? "user-initiated"
                  : event.cancelable !== true
                    ? "not-cancelable"
                    : "trusted-input-grace"
          });
          return;
        }

        event.preventDefault();
        reportBlockedNavigation(
          blocksReload ? "reload" : "route-reset",
          event.destination?.url || "",
          details
        );
      }, true);
    }

    guardHistoryRouteResets();

    window.__facebergAntiRefreshState = Object.freeze({
      version: GUARD_VERSION,
      get enabled() {
        return enabled;
      },
      get active() {
        return isAutomaticResumeNavigation();
      },
      get resumeGuardUntil() {
        return resumeGuardUntil;
      },
      get lastTrustedInteractionAt() {
        return lastTrustedInteractionAt;
      },
      get blockedNavigationCount() {
        return blockedNavigationCount;
      },
      get lastConfigAt() {
        return lastConfigAt;
      },
      get lastNavigationEvent() {
        return lastNavigationEvent ? { ...lastNavigationEvent } : null;
      },
      networkDiagnosticsInstalled: false,
      networkEvents: Object.freeze([]),
      safeMode: true,
      reason: "navigation-only-reload-and-home-route-reset"
    });
    return;
  }

  const GUARD_VERSION = 3;
  const RESUME_GUARD_WINDOW_MS = 10000;
  const USER_NAVIGATION_GRACE_MS = 1800;
  const VOLATILE_REFRESH_PARAM_PATTERN =
    /^(?:__.*|fbclid|ref|refsrc|notif_id|notif_t|notif_type|acontext|paipv|locale|ti|eav|av|mibextid|_rdc|_rdr|__tn__|__xts__|utm_[a-z0-9_]+)$/i;
  let enabled = false;
  let wasHidden = document.visibilityState === "hidden";
  let resumeGuardUntil = 0;
  let lastTrustedInteractionAt = 0;
  let blockedNavigationCount = 0;
  let lastConfigAt = 0;
  let lastNavigationEvent = null;

  function emitNavigationDiagnostic(details) {
    try {
      document.dispatchEvent(
        new CustomEvent("__facebergAntiRefreshNavigation", {
          detail: JSON.stringify(details)
        })
      );
    } catch (_error) {
      /* Diagnostics must never affect navigation handling. */
    }
  }

  function reportBlockedNavigation(kind, target = "") {
    blockedNavigationCount += 1;
    console.debug("[Faceberg] Blocked automatic resume navigation.", kind, target);
    window.postMessage(
      {
        source: "faceberg",
        kind: "stat",
        stat: "preventedRefreshes",
        count: 1
      },
      "*"
    );
  }

  function beginResumeGuard(now = Date.now()) {
    resumeGuardUntil = Math.max(resumeGuardUntil, now + RESUME_GUARD_WINDOW_MS);
  }

  function noteTrustedInteraction(event) {
    if (event?.isTrusted === true) {
      lastTrustedInteractionAt = Date.now();
    }
  }

  function isAutomaticResumeNavigation() {
    const now = Date.now();
    return enabled &&
      now < resumeGuardUntil &&
      (lastTrustedInteractionAt === 0 || now - lastTrustedInteractionAt > USER_NAVIGATION_GRACE_MS);
  }

  function safeUrl(input) {
    try {
      return new URL(String(input), window.location.href);
    } catch (_error) {
      return null;
    }
  }

  function normalizePathname(pathname) {
    const trimmed = String(pathname || "/").replace(/\/+$/, "");
    return trimmed || "/";
  }

  function isRootFeedPath(pathname) {
    const normalized = normalizePathname(pathname);
    return normalized === "/" || normalized === "/home.php";
  }

  function getCanonicalSearch(url) {
    return [...url.searchParams.entries()]
      .filter(([key]) => !VOLATILE_REFRESH_PARAM_PATTERN.test(key))
      .sort((left, right) => {
        const leftValue = `${left[0]}\u0000${left[1]}`;
        const rightValue = `${right[0]}\u0000${right[1]}`;
        return leftValue.localeCompare(rightValue);
      })
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
  }

  function getNavigationRelation(input) {
    const target = safeUrl(input);
    if (!target) {
      return null;
    }

    const current = new URL(window.location.href);
    const sameOrigin = target.origin === current.origin;
    const samePath = sameOrigin &&
      normalizePathname(target.pathname) === normalizePathname(current.pathname);
    const sameCanonicalSearch = samePath &&
      getCanonicalSearch(target) === getCanonicalSearch(current);
    const sameHash = target.hash === current.hash;

    return {
      target,
      current,
      sameOrigin,
      isDuplicateRoute: sameCanonicalSearch && sameHash,
      isRouteReset: sameOrigin &&
        !isRootFeedPath(current.pathname) &&
        isRootFeedPath(target.pathname)
    };
  }

  function shouldBlockNavigationTarget(input) {
    if (!isAutomaticResumeNavigation()) {
      return false;
    }

    const relation = getNavigationRelation(input);
    return !!relation && (relation.isDuplicateRoute || relation.isRouteReset);
  }

  function createAbortedNavigationResult() {
    const aborted = Promise.reject(new DOMException("Blocked by Faceberg", "AbortError"));
    aborted.catch(() => {});
    return { committed: aborted, finished: aborted };
  }

  function wrapMethod(holder, methodName, shouldBlock, onBlocked) {
    try {
      const original = holder?.[methodName];
      if (typeof original !== "function" || original.__facebergOriginal) {
        return;
      }

      const wrapped = function (...args) {
        if (shouldBlock(...args)) {
          return onBlocked(...args);
        }
        return original.apply(this, args);
      };
      wrapped.__facebergOriginal = original;
      holder[methodName] = wrapped;
    } catch (_error) {
      /* Location and Navigation methods are not writable in every Chrome build. */
    }
  }

  function guardExplicitReloads() {
    const shouldBlockReload = () => isAutomaticResumeNavigation();
    const blockReload = () => {
      reportBlockedNavigation("reload");
      return undefined;
    };

    wrapMethod(window.location, "reload", shouldBlockReload, blockReload);
    wrapMethod(window.Location?.prototype, "reload", shouldBlockReload, blockReload);

    wrapMethod(
      window.history,
      "go",
      (delta) => (delta === undefined || Number(delta) === 0) && isAutomaticResumeNavigation(),
      () => {
        reportBlockedNavigation("history.go(0)");
        return undefined;
      }
    );
  }

  function guardLocationMethods() {
    for (const methodName of ["assign", "replace"]) {
      const shouldBlock = (target) => shouldBlockNavigationTarget(target);
      const onBlocked = (target) => {
        reportBlockedNavigation(`location.${methodName}`, target);
        return undefined;
      };
      wrapMethod(window.location, methodName, shouldBlock, onBlocked);
      wrapMethod(window.Location?.prototype, methodName, shouldBlock, onBlocked);
    }

    try {
      const hrefDescriptor = Object.getOwnPropertyDescriptor(window.Location?.prototype, "href");
      if (hrefDescriptor?.get && hrefDescriptor?.set && hrefDescriptor.configurable) {
        Object.defineProperty(window.Location.prototype, "href", {
          configurable: true,
          enumerable: hrefDescriptor.enumerable ?? true,
          get: hrefDescriptor.get,
          set(value) {
            if (shouldBlockNavigationTarget(value)) {
              reportBlockedNavigation("location.href", value);
              return;
            }
            hrefDescriptor.set.call(this, value);
          }
        });
      }
    } catch (_error) {
      /* Chrome normally exposes Location.href as non-configurable. */
    }
  }

  function guardHistoryRouteResets() {
    for (const methodName of ["pushState", "replaceState"]) {
      wrapMethod(
        window.history,
        methodName,
        (_state, _unused, url) => url != null && shouldBlockNavigationTarget(url),
        (_state, _unused, url) => {
          reportBlockedNavigation(`history.${methodName}`, url);
          return undefined;
        }
      );
    }
  }

  function guardNavigationApi() {
    if (!window.navigation) {
      return;
    }

    window.navigation.addEventListener("navigate", (event) => {
      if (enabled && Date.now() < resumeGuardUntil) {
        lastNavigationEvent = {
          at: Date.now(),
          cancelable: event.cancelable === true,
          destination: event.destination?.url || "",
          navigationType: event.navigationType || "",
          userInitiated: event.userInitiated === true,
          visibilityState: document.visibilityState
        };
        emitNavigationDiagnostic({
          ...lastNavigationEvent,
          guardActive: isAutomaticResumeNavigation(),
          lastTrustedInteractionAt,
          resumeGuardUntil
        });
      }

      if (
        !isAutomaticResumeNavigation() ||
        event.defaultPrevented ||
        event.userInitiated === true ||
        event.cancelable !== true
      ) {
        return;
      }

      const target = event.destination?.url || "";
      const blocksReload = event.navigationType === "reload";
      const blocksRouteReset = shouldBlockNavigationTarget(target);
      if (!blocksReload && !blocksRouteReset) {
        return;
      }

      event.preventDefault();
      reportBlockedNavigation(
        blocksReload ? "navigate-event:reload" : "navigate-event:route-reset",
        target
      );
    }, true);

    wrapMethod(
      window.navigation,
      "navigate",
      (url) => shouldBlockNavigationTarget(url),
      (url) => {
        reportBlockedNavigation("navigation.navigate", url);
        return createAbortedNavigationResult();
      }
    );
    wrapMethod(
      window.navigation,
      "reload",
      () => isAutomaticResumeNavigation(),
      () => {
        reportBlockedNavigation("navigation.reload");
        return createAbortedNavigationResult();
      }
    );
  }

  function removeMetaRefresh(root = document) {
    if (!enabled) {
      return;
    }

    const candidates = [];
    if (root instanceof HTMLMetaElement && root.hasAttribute("http-equiv")) {
      candidates.push(root);
    }
    if (root instanceof Document || root instanceof Element) {
      candidates.push(...root.querySelectorAll("meta[http-equiv]"));
    }

    for (const meta of candidates) {
      if ((meta.getAttribute("http-equiv") || "").toLowerCase() !== "refresh") {
        continue;
      }
      meta.remove();
      reportBlockedNavigation("meta-refresh", meta.getAttribute("content") || "");
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      wasHidden = true;
      beginResumeGuard();
      return;
    }

    if (wasHidden) {
      wasHidden = false;
      beginResumeGuard();
    }
  }, true);
  window.addEventListener("pagehide", () => {
    wasHidden = true;
    beginResumeGuard();
  }, true);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted === true || wasHidden) {
      wasHidden = false;
      beginResumeGuard();
    }
  }, true);
  window.addEventListener("freeze", () => {
    wasHidden = true;
    beginResumeGuard();
  }, true);
  window.addEventListener("resume", () => {
    if (wasHidden) {
      wasHidden = false;
    }
    beginResumeGuard();
  }, true);
  window.addEventListener("focus", () => {
    if (wasHidden) {
      wasHidden = false;
      beginResumeGuard();
    }
  }, true);

  for (const eventType of ["pointerdown", "keydown", "touchstart"]) {
    document.addEventListener(eventType, noteTrustedInteraction, { capture: true, passive: true });
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.source !== "faceberg" ||
      event.data?.kind !== "anti-refresh-config"
    ) {
      return;
    }

    enabled = event.data.enabled === true;
    lastConfigAt = Date.now();
    if (!enabled) {
      resumeGuardUntil = 0;
      wasHidden = document.visibilityState === "hidden";
      return;
    }

    removeMetaRefresh(document);
  }, true);

  guardExplicitReloads();
  guardLocationMethods();
  guardHistoryRouteResets();
  guardNavigationApi();
  removeMetaRefresh();

  const metaObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          removeMetaRefresh(node);
        }
      }
    }

    if (document.head && metaObserverTarget !== document.head) {
      metaObserver.disconnect();
      metaObserverTarget = document.head;
      metaObserver.observe(metaObserverTarget, {
        childList: true,
        subtree: true
      });
    }
  });
  let metaObserverTarget = document.head || document.documentElement || document;
  metaObserver.observe(metaObserverTarget, {
    childList: true,
    subtree: metaObserverTarget === document.head
  });

  window.__facebergAntiRefreshState = {
    version: GUARD_VERSION,
    get enabled() {
      return enabled;
    },
    get active() {
      return isAutomaticResumeNavigation();
    },
    get resumeGuardUntil() {
      return resumeGuardUntil;
    },
    get lastTrustedInteractionAt() {
      return lastTrustedInteractionAt;
    },
    get blockedNavigationCount() {
      return blockedNavigationCount;
    },
    get lastConfigAt() {
      return lastConfigAt;
    },
    get lastNavigationEvent() {
      return lastNavigationEvent ? { ...lastNavigationEvent } : null;
    }
  };
})();
