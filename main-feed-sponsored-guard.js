(() => {
  "use strict";

  /*
    This guard is manifest-injected into Facebook's MAIN world at
    document_start. Vivaldi accepted the dynamic registration used by the
    shared module guard, but did not run that registration early enough to
    intercept initial Relay payload processing. The primary boundary is now
    CometNewsFeedConnectionHandler: exact Sponsored records are removed from
    the normalized connection before Relay publishes layout updates. Earlier
    stream and payload hooks remain bounded fallbacks. No React-owned card or
    geometry is touched.
  */
  const GUARD_VERSION = 9;
  const STATE_KEY = "__facebergMainFeedSponsoredGuardState";
  const DEFINE_MARKER = "__facebergMainFeedSponsoredDefineVersion";
  const FACTORY_MARKER = "__facebergMainFeedSponsoredFactoryVersion";
  const STUB_PUSH_MARKER = "__facebergMainFeedSponsoredStubPushVersion";
  const LAZY_STUB_PUSH_MARKER =
    "__facebergMainFeedSponsoredLazyStubPushVersion";
  const LAZY_CALLBACK_MARKER =
    "__facebergMainFeedSponsoredLazyCallbackVersion";
  const PAYLOAD_PROCESS_MARKER =
    "__facebergMainFeedSponsoredPayloadProcessVersion";
  const REQUIRE_LAZY_MARKER =
    "__facebergMainFeedSponsoredRequireLazyVersion";
  const CONNECTION_FACTORY_MARKER =
    "__facebergMainFeedSponsoredConnectionFactoryVersion";
  const CONNECTION_UPDATE_MARKER =
    "__facebergMainFeedSponsoredConnectionUpdateVersion";
  const CONFIG_KIND = "main-feed-sponsored-config-v1";
  const STREAM_MODULE = "RelayPrefetchedStreamCache";
  const PAYLOAD_LISTENER_MODULE = "ServerJSPayloadListener";
  const CONNECTION_MODULE = "CometNewsFeedConnectionHandler";
  const STREAM_LABEL =
    "CometNewsFeed_viewerConnection$stream$CometNewsFeed_viewer_news_feed";
  const SUPPRESSED_EVENT = "__facebergMainFeedSponsoredSuppressedV1";
  const STATUS_ATTRIBUTE = "data-faceberg-main-feed-sponsored-guard";
  const COUNT_ATTRIBUTE = "data-faceberg-main-feed-sponsored-count";
  const VERSION_ATTRIBUTE = "data-faceberg-main-feed-sponsored-version";
  const PAYLOAD_STATUS_ATTRIBUTE =
    "data-faceberg-main-feed-payload-consumer";
  const PAYLOAD_OBSERVER_ATTRIBUTE =
    "data-faceberg-main-feed-payload-observer";
  const REQUIRE_LAZY_STATUS_ATTRIBUTE =
    "data-faceberg-main-feed-require-lazy";
  const CONNECTION_STATUS_ATTRIBUTE =
    "data-faceberg-main-feed-connection-handler";

  if (Number(window[STATE_KEY]?.version || 0) >= GUARD_VERSION) {
    return;
  }

  let enabled = true;
  let installedAt = Date.now();
  let interceptedFactory = false;
  let patchedApi = false;
  let interceptedPayloadConsumer = false;
  let patchedPayloadListener = false;
  let interceptedConnectionFactory = false;
  let patchedConnectionHandler = false;
  let connectionHandlerStatus = "not-seen";
  let loaderMode = "not-found";
  let suppressedCount = 0;
  let lastStatus = "installing";
  let releaseLoaderAccessor = null;
  let releaseStubAccessor = null;
  let releaseLazyStubAccessor = null;
  let releaseRequireLazyAccessor = null;
  let releaseModuleRequireAccessor = null;
  let loaderProbeObserver = null;
  let payloadObserver = null;
  let payloadObserverStatus = "not-started";
  let requireLazyStatus = "not-seen";
  const loaderProbeTimers = new Set();
  let loaderProbeCount = 0;
  const errors = [];
  const skippedEdgeIndexes = new Map();
  const processedPayloadScripts = new WeakSet();

  function publishStatus(status = lastStatus) {
    lastStatus = status;
    const root = document.documentElement;
    if (!root) {
      return;
    }
    root.setAttribute(STATUS_ATTRIBUTE, status);
    root.setAttribute(COUNT_ATTRIBUTE, String(suppressedCount));
    root.setAttribute(VERSION_ATTRIBUTE, String(GUARD_VERSION));
    root.setAttribute(
      PAYLOAD_STATUS_ATTRIBUTE,
      patchedPayloadListener
        ? "patched"
        : interceptedPayloadConsumer
          ? "queued"
          : "not-seen"
    );
    root.setAttribute(PAYLOAD_OBSERVER_ATTRIBUTE, payloadObserverStatus);
    root.setAttribute(REQUIRE_LAZY_STATUS_ATTRIBUTE, requireLazyStatus);
    root.setAttribute(CONNECTION_STATUS_ATTRIBUTE, connectionHandlerStatus);
  }

  function recordError(stage, error) {
    errors.push({
      at: Date.now(),
      message: String(error?.message || error || "Unknown error").slice(0, 240),
      stage
    });
    if (errors.length > 12) {
      errors.splice(0, errors.length - 12);
    }
    publishStatus(`error:${stage}`);
  }

  function stopLoaderProbe() {
    loaderProbeObserver?.disconnect();
    loaderProbeObserver = null;
    for (const timer of loaderProbeTimers) {
      window.clearTimeout(timer);
    }
    loaderProbeTimers.clear();
    if (typeof releaseStubAccessor === "function") {
      const release = releaseStubAccessor;
      releaseStubAccessor = null;
      release();
    }
    if (typeof releaseLazyStubAccessor === "function") {
      const release = releaseLazyStubAccessor;
      releaseLazyStubAccessor = null;
      release();
    }
    if (typeof releaseModuleRequireAccessor === "function") {
      const release = releaseModuleRequireAccessor;
      releaseModuleRequireAccessor = null;
      release();
    }
  }

  function maybeStopLoaderProbe() {
    if (patchedConnectionHandler) {
      stopLoaderProbe();
    }
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.source !== "faceberg" ||
      event.data?.kind !== CONFIG_KIND
    ) {
      return;
    }
    enabled = event.data.enabled === true;
    publishStatus(
      patchedApi || patchedPayloadListener
        ? suppressedCount > 0
          ? "suppressed"
          : patchedPayloadListener
            ? "payload-listener-patched"
            : "api-patched"
        : lastStatus
    );
  });

  function getStreamPatch(args) {
    const streamKey = args?.[0];
    const envelope = args?.[1];
    const bbox = envelope?.__bbox;
    const result = bbox?.result;
    const path = result?.path;
    if (
      typeof streamKey !== "string" ||
      result?.label !== STREAM_LABEL ||
      !Array.isArray(path) ||
      path.length !== 4 ||
      path[0] !== "viewer" ||
      path[1] !== "news_feed" ||
      path[2] !== "edges" ||
      !Number.isInteger(path[3]) ||
      !result?.data?.node
    ) {
      return null;
    }

    return {
      bbox,
      edgeIndex: path[3],
      envelope,
      path,
      result,
      sequenceKey: `${streamKey}\u0000${STREAM_LABEL}`
    };
  }

  function hasExplicitSponsoredData(root) {
    const pending = [{ depth: 0, value: root }];
    let visited = 0;

    while (pending.length > 0 && visited < 12000) {
      const entry = pending.pop();
      const value = entry?.value;
      if (!value || typeof value !== "object") {
        continue;
      }
      visited += 1;

      if (
        value.__typename === "SponsoredData" ||
        (!Array.isArray(value) &&
          Object.prototype.hasOwnProperty.call(value, "sponsored_data") &&
          value.sponsored_data != null) ||
        (!Array.isArray(value) &&
          Object.prototype.hasOwnProperty.call(value, "th_dat_spo") &&
          value.th_dat_spo != null)
      ) {
        return true;
      }

      if (entry.depth >= 16) {
        continue;
      }
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          pending.push({ depth: entry.depth + 1, value: value[index] });
        }
      } else {
        for (const key of Object.keys(value)) {
          pending.push({ depth: entry.depth + 1, value: value[key] });
        }
      }
    }

    return false;
  }

  function isExplicitSponsoredRelayRecord(record) {
    if (!record || typeof record !== "object") {
      return false;
    }
    try {
      return (
        record.getType?.() === "SponsoredData" ||
        record.getValue?.("__typename") === "SponsoredData"
      );
    } catch (_error) {
      return false;
    }
  }

  function isSponsoredConnectionEdge(edge) {
    if (!edge || typeof edge.getLinkedRecord !== "function") {
      return false;
    }
    try {
      const node = edge.getLinkedRecord("node");
      if (!node || typeof node.getLinkedRecord !== "function") {
        return false;
      }
      return (
        isExplicitSponsoredRelayRecord(node.getLinkedRecord("th_dat_spo")) ||
        isExplicitSponsoredRelayRecord(node.getLinkedRecord("sponsored_data"))
      );
    } catch (_error) {
      return false;
    }
  }

  function filterConnectionEdges(store, payload) {
    if (
      !enabled ||
      !store ||
      typeof store.get !== "function" ||
      !payload ||
      typeof payload.dataID !== "string" ||
      typeof payload.handleKey !== "string"
    ) {
      return 0;
    }

    const parent = store.get(payload.dataID);
    const connection = parent?.getLinkedRecord?.(payload.handleKey);
    const edges = connection?.getLinkedRecords?.("edges");
    if (!Array.isArray(edges) || edges.length === 0) {
      return 0;
    }

    const keptEdges = [];
    let removed = 0;
    for (const edge of edges) {
      if (isSponsoredConnectionEdge(edge)) {
        removed += 1;
      } else {
        keptEdges.push(edge);
      }
    }
    if (removed === 0) {
      return 0;
    }

    connection.setLinkedRecords(keptEdges, "edges");
    suppressedCount += removed;
    for (let index = 0; index < removed; index += 1) {
      document.dispatchEvent(new CustomEvent(SUPPRESSED_EVENT));
    }
    publishStatus("suppressed-at-connection");
    return removed;
  }

  function replaceConnectionUpdate(handler) {
    if (
      !handler ||
      (typeof handler !== "object" && typeof handler !== "function") ||
      typeof handler.update !== "function"
    ) {
      return false;
    }
    if (
      Number(handler.update[CONNECTION_UPDATE_MARKER] || 0) >= GUARD_VERSION
    ) {
      patchedConnectionHandler = true;
      connectionHandlerStatus = "patched";
      return true;
    }

    const originalUpdate = handler.update;
    const filteredUpdate = function (store, payload) {
      const result = originalUpdate.apply(this, arguments);
      try {
        filterConnectionEdges(store, payload);
      } catch (error) {
        recordError("connection-filter", error);
      }
      return result;
    };
    Object.defineProperty(filteredUpdate, CONNECTION_UPDATE_MARKER, {
      value: GUARD_VERSION
    });

    try {
      handler.update = filteredUpdate;
      if (handler.update !== filteredUpdate) {
        const descriptor = Object.getOwnPropertyDescriptor(handler, "update");
        if (descriptor?.configurable !== true) {
          return false;
        }
        Object.defineProperty(handler, "update", {
          ...descriptor,
          value: filteredUpdate
        });
      }
    } catch (error) {
      recordError("patch-connection-update", error);
      return false;
    }

    patchedConnectionHandler = true;
    connectionHandlerStatus = "patched";
    maybeStopLoaderProbe();
    publishStatus(
      suppressedCount > 0 ? "suppressed-at-connection" : "connection-patched"
    );
    return true;
  }

  function getSkippedIndexes(sequenceKey) {
    let skipped = skippedEdgeIndexes.get(sequenceKey);
    if (!skipped) {
      skipped = new Set();
      skippedEdgeIndexes.set(sequenceKey, skipped);
    }
    return skipped;
  }

  function rewriteStreamArgs(args) {
    const patch = getStreamPatch(args);
    if (!patch) {
      return { args, skip: false };
    }

    const skipped = getSkippedIndexes(patch.sequenceKey);
    if (enabled && hasExplicitSponsoredData(patch.result.data.node)) {
      skipped.add(patch.edgeIndex);
      suppressedCount += 1;
      publishStatus("suppressed");
      document.dispatchEvent(new CustomEvent(SUPPRESSED_EVENT));
      return { args, skip: true };
    }

    let precedingSkippedCount = 0;
    for (const skippedIndex of skipped) {
      if (skippedIndex < patch.edgeIndex) {
        precedingSkippedCount += 1;
      }
    }
    if (precedingSkippedCount === 0) {
      return { args, skip: false };
    }

    const nextArgs = Array.prototype.slice.call(args);
    const nextPath = patch.path.slice();
    nextPath[3] = patch.edgeIndex - precedingSkippedCount;
    nextArgs[1] = {
      ...patch.envelope,
      __bbox: {
        ...patch.bbox,
        result: {
          ...patch.result,
          path: nextPath
        }
      }
    };
    return { args: nextArgs, skip: false };
  }

  function replaceNext(api) {
    if (
      !api ||
      (typeof api !== "object" && typeof api !== "function") ||
      typeof api.next !== "function" ||
      Number(api.next[FACTORY_MARKER] || 0) >= GUARD_VERSION
    ) {
      return false;
    }

    const originalNext = api.next;
    const filteredNext = function () {
      const rewrite = rewriteStreamArgs(arguments);
      if (rewrite.skip) {
        return undefined;
      }
      return originalNext.apply(this, rewrite.args);
    };
    Object.defineProperty(filteredNext, FACTORY_MARKER, {
      value: GUARD_VERSION
    });

    try {
      api.next = filteredNext;
      if (api.next !== filteredNext) {
        const descriptor = Object.getOwnPropertyDescriptor(api, "next");
        if (descriptor?.configurable !== true) {
          return false;
        }
        Object.defineProperty(api, "next", {
          ...descriptor,
          value: filteredNext
        });
      }
    } catch (error) {
      recordError("patch-next", error);
      return false;
    }

    patchedApi = true;
    maybeStopLoaderProbe();
    publishStatus(suppressedCount > 0 ? "suppressed" : "api-patched");
    return true;
  }

  function isPayloadScript(node) {
    return (
      node?.nodeType === 1 &&
      String(node.tagName || "").toLowerCase() === "script" &&
      String(node.getAttribute?.("type") || "").toLowerCase() ===
        "application/json" &&
      (typeof node.hasAttribute !== "function" || node.hasAttribute("data-sjs"))
    );
  }

  function transformPayloadValue(value) {
    let changed = false;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const child = value[index];
        if (
          Array.isArray(child) &&
          child[0] === STREAM_MODULE &&
          child[1] === "next" &&
          Array.isArray(child[3])
        ) {
          const rewrite = rewriteStreamArgs(child[3]);
          if (rewrite.skip) {
            value.splice(index, 1);
            changed = true;
            continue;
          }
          if (rewrite.args !== child[3]) {
            child[3] = rewrite.args;
            changed = true;
          }
        }
        if (transformPayloadValue(child)) {
          changed = true;
        }
      }
      return changed;
    }

    if (!value || typeof value !== "object") {
      return false;
    }
    for (const key of Object.keys(value)) {
      if (transformPayloadValue(value[key])) {
        changed = true;
      }
    }
    return changed;
  }

  function sanitizePayloadScript(script) {
    if (!isPayloadScript(script) || processedPayloadScripts.has(script)) {
      return false;
    }

    const source = String(script.textContent || "");
    if (!source) {
      return false;
    }
    if (script.getAttribute?.("data-processed") === "1") {
      processedPayloadScripts.add(script);
      return false;
    }
    if (!source.includes(STREAM_MODULE) || !source.includes(STREAM_LABEL)) {
      processedPayloadScripts.add(script);
      return false;
    }

    try {
      const payload = JSON.parse(source);
      const changed = transformPayloadValue(payload);
      processedPayloadScripts.add(script);
      if (!changed) {
        return false;
      }
      script.textContent = JSON.stringify(payload);
      publishStatus(suppressedCount > 0 ? "suppressed" : "payload-rewritten");
      return true;
    } catch (error) {
      recordError("payload-json", error);
      return false;
    }
  }

  function sanitizeExistingPayloadScripts() {
    if (typeof document.querySelectorAll !== "function") {
      return false;
    }
    let changed = false;
    for (const script of document.querySelectorAll(
      'script[type="application/json"]'
    )) {
      changed = sanitizePayloadScript(script) || changed;
    }
    return changed;
  }

  function sanitizePayloadNode(node) {
    let changed = sanitizePayloadScript(node);
    if (typeof node?.querySelectorAll === "function") {
      for (const script of node.querySelectorAll(
        'script[type="application/json"][data-sjs]'
      )) {
        changed = sanitizePayloadScript(script) || changed;
      }
    }
    return changed;
  }

  function sanitizePayloadMutations(records) {
    for (const record of records || []) {
      sanitizePayloadScript(record?.target);
      for (const node of record?.addedNodes || []) {
        sanitizePayloadNode(node);
      }
    }
  }

  function stopPayloadObserver() {
    payloadObserver?.disconnect();
    payloadObserver = null;
    payloadObserverStatus = "stopped";
    publishStatus();
  }

  function startPayloadObserver() {
    if (typeof MutationObserver !== "function") {
      payloadObserverStatus = "unavailable";
      publishStatus();
      return;
    }
    payloadObserver = new MutationObserver((records) => {
      sanitizePayloadMutations(records);
    });
    payloadObserver.observe(document, {
      childList: true,
      subtree: true
    });
    payloadObserverStatus = "watching";
    publishStatus();
  }

  function replacePayloadProcess(listener) {
    if (
      !listener ||
      (typeof listener !== "object" && typeof listener !== "function") ||
      typeof listener.process !== "function"
    ) {
      return false;
    }
    if (Number(listener.process[PAYLOAD_PROCESS_MARKER] || 0) >= GUARD_VERSION) {
      patchedPayloadListener = true;
      return true;
    }

    const originalProcess = listener.process;
    const filteredProcess = function () {
      sanitizeExistingPayloadScripts();
      return originalProcess.apply(this, arguments);
    };
    Object.defineProperty(filteredProcess, PAYLOAD_PROCESS_MARKER, {
      value: GUARD_VERSION
    });

    try {
      listener.process = filteredProcess;
      if (listener.process !== filteredProcess) {
        const descriptor = Object.getOwnPropertyDescriptor(listener, "process");
        if (descriptor?.configurable !== true) {
          return false;
        }
        Object.defineProperty(listener, "process", {
          ...descriptor,
          value: filteredProcess
        });
      }
    } catch (error) {
      recordError("patch-payload-process", error);
      return false;
    }

    patchedPayloadListener = true;
    maybeStopLoaderProbe();
    publishStatus(
      suppressedCount > 0 ? "suppressed" : "payload-listener-patched"
    );
    return true;
  }

  function wrapPayloadListenerCallback(moduleNames, callback) {
    if (
      !Array.isArray(moduleNames) ||
      typeof callback !== "function" ||
      Number(callback[LAZY_CALLBACK_MARKER] || 0) >= GUARD_VERSION
    ) {
      return callback;
    }
    const listenerIndex = moduleNames.indexOf(PAYLOAD_LISTENER_MODULE);
    if (listenerIndex < 0) {
      return callback;
    }

    interceptedPayloadConsumer = true;
    const wrappedCallback = function () {
      if (!replacePayloadProcess(arguments[listenerIndex])) {
        sanitizeExistingPayloadScripts();
      }
      return callback.apply(this, arguments);
    };
    Object.defineProperty(wrappedCallback, LAZY_CALLBACK_MARKER, {
      value: GUARD_VERSION
    });
    publishStatus("payload-listener-queued");
    return wrappedCallback;
  }

  function wrapRequireLazy(requireLazyFunction) {
    if (
      typeof requireLazyFunction !== "function" ||
      Number(requireLazyFunction[REQUIRE_LAZY_MARKER] || 0) >= GUARD_VERSION
    ) {
      return requireLazyFunction;
    }

    const wrappedRequireLazy = function () {
      const nextArguments = Array.prototype.slice.call(arguments);
      nextArguments[1] = wrapPayloadListenerCallback(
        nextArguments[0],
        nextArguments[1]
      );
      return requireLazyFunction.apply(this, nextArguments);
    };
    Object.defineProperty(wrappedRequireLazy, REQUIRE_LAZY_MARKER, {
      value: GUARD_VERSION
    });
    requireLazyStatus = "wrapped";
    publishStatus();
    return wrappedRequireLazy;
  }

  function installRequireLazyInterceptor() {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, "requireLazy");
      const currentRequireLazy = wrapRequireLazy(window.requireLazy);
      if (!descriptor || descriptor.configurable === true) {
        let activeRequireLazy = currentRequireLazy;
        Object.defineProperty(window, "requireLazy", {
          configurable: true,
          enumerable: descriptor?.enumerable !== false,
          get() {
            return activeRequireLazy;
          },
          set(nextRequireLazy) {
            activeRequireLazy = wrapRequireLazy(nextRequireLazy);
          }
        });
        releaseRequireLazyAccessor = () => {
          Object.defineProperty(window, "requireLazy", {
            configurable: true,
            enumerable: descriptor?.enumerable !== false,
            writable: true,
            value: activeRequireLazy
          });
          publishStatus();
        };
      } else if (
        descriptor.writable === true &&
        typeof currentRequireLazy === "function"
      ) {
        window.requireLazy = currentRequireLazy;
      }
    } catch (error) {
      requireLazyStatus = "failed";
      recordError("install-require-lazy", error);
    }
  }

  function releaseRequireLazyInterceptor() {
    if (typeof releaseRequireLazyAccessor !== "function") {
      return;
    }
    const release = releaseRequireLazyAccessor;
    releaseRequireLazyAccessor = null;
    release();
  }

  function patchRequireLazyEntry(entry) {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const wrappedCallback = wrapPayloadListenerCallback(entry[0], entry[1]);
    if (wrappedCallback === entry[1]) {
      return false;
    }
    try {
      entry[1] = wrappedCallback;
      return entry[1] === wrappedCallback;
    } catch (error) {
      recordError("patch-require-lazy-entry", error);
      return false;
    }
  }

  function interceptRequireLazyQueue(queue = window.__rl_stub) {
    if (!Array.isArray(queue)) {
      return false;
    }
    let found = false;
    for (const entry of queue) {
      found = patchRequireLazyEntry(entry) || found;
    }

    const currentPush = queue.push;
    if (
      typeof currentPush !== "function" ||
      Number(currentPush[LAZY_STUB_PUSH_MARKER] || 0) >= GUARD_VERSION
    ) {
      return found;
    }
    const interceptedPush = function () {
      for (const entry of arguments) {
        patchRequireLazyEntry(entry);
      }
      return currentPush.apply(this, arguments);
    };
    Object.defineProperty(interceptedPush, LAZY_STUB_PUSH_MARKER, {
      value: GUARD_VERSION
    });
    try {
      Object.defineProperty(queue, "push", {
        configurable: true,
        writable: true,
        value: interceptedPush
      });
    } catch (error) {
      recordError("patch-require-lazy-push", error);
    }
    return found;
  }

  function installRequireLazyQueueInterceptor() {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, "__rl_stub");
      const canInstallAccessor =
        !descriptor ||
        (descriptor.configurable === true && !descriptor.get && !descriptor.set);
      if (!canInstallAccessor) {
        interceptRequireLazyQueue(window.__rl_stub);
        return;
      }

      let activeQueue = descriptor?.value;
      interceptRequireLazyQueue(activeQueue);
      Object.defineProperty(window, "__rl_stub", {
        configurable: true,
        enumerable: descriptor?.enumerable !== false,
        get() {
          return activeQueue;
        },
        set(nextQueue) {
          activeQueue = nextQueue;
          interceptRequireLazyQueue(activeQueue);
        }
      });
      releaseLazyStubAccessor = () => {
        Object.defineProperty(window, "__rl_stub", {
          configurable: true,
          enumerable: descriptor?.enumerable !== false,
          writable: true,
          value: activeQueue
        });
      };
    } catch (error) {
      recordError("install-require-lazy-queue", error);
    }
  }

  function patchFactoryExports(factoryArguments, factoryResult) {
    const candidates = [factoryResult];
    for (let index = factoryArguments.length - 1; index >= 0; index -= 1) {
      const candidate = factoryArguments[index];
      candidates.push(
        candidate,
        candidate?.default,
        candidate?.exports,
        candidate?.exports?.default
      );
    }
    return candidates.some((candidate) => replaceNext(candidate));
  }

  function patchConnectionFactoryExports(factoryArguments, factoryResult) {
    const candidates = [factoryResult];
    for (let index = factoryArguments.length - 1; index >= 0; index -= 1) {
      const candidate = factoryArguments[index];
      candidates.push(
        candidate,
        candidate?.default,
        candidate?.exports,
        candidate?.exports?.default
      );
    }
    return candidates.some((candidate) => replaceConnectionUpdate(candidate));
  }

  function wrapFactory(factory) {
    if (
      typeof factory !== "function" ||
      Number(factory[FACTORY_MARKER] || 0) >= GUARD_VERSION
    ) {
      return factory;
    }

    interceptedFactory = true;
    publishStatus("factory-intercepted");
    const wrappedFactory = function () {
      const result = factory.apply(this, arguments);
      if (!patchFactoryExports(arguments, result)) {
        recordError(
          "factory-exports",
          "RelayPrefetchedStreamCache did not expose a writable next method."
        );
      }
      return result;
    };
    Object.defineProperty(wrappedFactory, FACTORY_MARKER, {
      value: GUARD_VERSION
    });
    return wrappedFactory;
  }

  function wrapConnectionFactory(factory) {
    if (
      typeof factory !== "function" ||
      Number(factory[CONNECTION_FACTORY_MARKER] || 0) >= GUARD_VERSION
    ) {
      return factory;
    }

    interceptedConnectionFactory = true;
    connectionHandlerStatus = "factory-intercepted";
    publishStatus("connection-factory-intercepted");
    const wrappedFactory = function () {
      const result = factory.apply(this, arguments);
      if (!patchConnectionFactoryExports(arguments, result)) {
        connectionHandlerStatus = "factory-unpatchable";
        recordError(
          "connection-factory-exports",
          "CometNewsFeedConnectionHandler did not expose a writable update method."
        );
      }
      return result;
    };
    Object.defineProperty(wrappedFactory, CONNECTION_FACTORY_MARKER, {
      value: GUARD_VERSION
    });
    return wrappedFactory;
  }

  function patchBootstrapEntry(entry, status = "factory-intercepted-stub") {
    if (
      !Array.isArray(entry) ||
      typeof entry[2] !== "function"
    ) {
      return false;
    }
    let wrappedFactory = entry[2];
    if (entry[0] === STREAM_MODULE) {
      wrappedFactory = wrapFactory(entry[2]);
    } else if (entry[0] === CONNECTION_MODULE) {
      wrappedFactory = wrapConnectionFactory(entry[2]);
      status = "connection-factory-intercepted-stub";
    } else {
      return false;
    }
    if (wrappedFactory !== entry[2]) {
      entry[2] = wrappedFactory;
    }
    publishStatus(status);
    return true;
  }

  function patchBootstrapDefineQueue(defineStub = window.__d_stub) {
    if (!Array.isArray(defineStub)) {
      return false;
    }

    let found = false;
    for (const entry of defineStub) {
      found = patchBootstrapEntry(entry) || found;
    }
    return found;
  }

  function interceptBootstrapDefineQueue(defineStub) {
    if (!Array.isArray(defineStub)) {
      return false;
    }

    const found = patchBootstrapDefineQueue(defineStub);
    const currentPush = defineStub.push;
    if (
      typeof currentPush !== "function" ||
      Number(currentPush[STUB_PUSH_MARKER] || 0) >= GUARD_VERSION
    ) {
      return found;
    }

    const interceptedPush = function () {
      for (const entry of arguments) {
        patchBootstrapEntry(entry, "factory-intercepted-stub-push");
      }
      return currentPush.apply(this, arguments);
    };
    Object.defineProperty(interceptedPush, STUB_PUSH_MARKER, {
      value: GUARD_VERSION
    });
    try {
      Object.defineProperty(defineStub, "push", {
        configurable: true,
        writable: true,
        value: interceptedPush
      });
    } catch (error) {
      recordError("patch-stub-push", error);
    }
    return found;
  }

  function installBootstrapQueueInterceptor() {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, "__d_stub");
      const canInstallAccessor =
        !descriptor ||
        (descriptor.configurable === true &&
          !descriptor.get &&
          !descriptor.set);
      if (!canInstallAccessor) {
        interceptBootstrapDefineQueue(window.__d_stub);
        return;
      }

      let activeStub = descriptor?.value;
      interceptBootstrapDefineQueue(activeStub);
      Object.defineProperty(window, "__d_stub", {
        configurable: true,
        enumerable: descriptor?.enumerable !== false,
        get() {
          return activeStub;
        },
        set(nextStub) {
          activeStub = nextStub;
          interceptBootstrapDefineQueue(activeStub);
        }
      });
      releaseStubAccessor = () => {
        Object.defineProperty(window, "__d_stub", {
          configurable: true,
          enumerable: descriptor?.enumerable !== false,
          writable: true,
          value: activeStub
        });
      };
    } catch (error) {
      recordError("install-stub", error);
    }
  }

  function patchExistingModule() {
    try {
      if (typeof window.require !== "function") {
        return false;
      }

      let found = false;

      try {
        found =
          replaceConnectionUpdate(window.require(CONNECTION_MODULE)) || found;
      } catch (_error) {
        /* The connection handler may not be registered until its static bundle loads. */
      }

      try {
        found =
          replacePayloadProcess(window.require(PAYLOAD_LISTENER_MODULE)) || found;
      } catch (_error) {
        /* The transient payload listener may only be exposed to requireLazy. */
      }

      try {
        const directExport = window.require(STREAM_MODULE);
        if (replaceNext(directExport)) {
          publishStatus("api-patched-direct");
          found = true;
        }
      } catch (_error) {
        /* The named module is not registered yet; the startup probe will retry. */
      }

      const moduleRecord = window.require("__debug")?.modulesMap?.[STREAM_MODULE];
      if (moduleRecord) {
        if (moduleRecord.factoryFinished === true) {
          interceptedFactory = true;
          if (
            replaceNext(moduleRecord.exports) ||
            replaceNext(moduleRecord.defaultExport)
          ) {
            publishStatus("api-patched-late");
          }
          found = patchedApi || found;
        } else if (typeof moduleRecord.factory === "function") {
          moduleRecord.factory = wrapFactory(moduleRecord.factory);
          moduleRecord.factoryLength = -1;
          found = true;
        }
      }

      const connectionRecord =
        window.require("__debug")?.modulesMap?.[CONNECTION_MODULE];
      if (connectionRecord) {
        if (connectionRecord.factoryFinished === true) {
          interceptedConnectionFactory = true;
          found =
            replaceConnectionUpdate(connectionRecord.exports) ||
            replaceConnectionUpdate(connectionRecord.defaultExport) ||
            found;
        } else if (typeof connectionRecord.factory === "function") {
          connectionRecord.factory = wrapConnectionFactory(
            connectionRecord.factory
          );
          connectionRecord.factoryLength = -1;
          found = true;
        }
      }
      return found;
    } catch (error) {
      if (!/not found|unknown module|Cannot find/i.test(String(error?.message || error))) {
        recordError("patch-existing", error);
      }
    }
    return false;
  }

  function installModuleRequireInterceptor() {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, "require");
      if (!descriptor || descriptor.configurable === true) {
        let activeRequire = window.require;
        Object.defineProperty(window, "require", {
          configurable: true,
          enumerable: descriptor?.enumerable !== false,
          get() {
            return activeRequire;
          },
          set(nextRequire) {
            activeRequire = nextRequire;
            patchExistingModule();
          }
        });
        releaseModuleRequireAccessor = () => {
          Object.defineProperty(window, "require", {
            configurable: true,
            enumerable: descriptor?.enumerable !== false,
            writable: true,
            value: activeRequire
          });
        };
      }
      patchExistingModule();
    } catch (error) {
      recordError("install-module-require", error);
    }
  }

  function probeLoader() {
    if (patchedConnectionHandler) {
      stopLoaderProbe();
      return true;
    }
    loaderProbeCount += 1;
    const queued = patchBootstrapDefineQueue();
    const existing = patchExistingModule();
    if (patchedConnectionHandler) {
      stopLoaderProbe();
      return true;
    }
    if (queued || existing) {
      publishStatus("factory-intercepted");
    } else if (loaderProbeCount === 1) {
      publishStatus("probing-loader");
    }
    return queued || existing;
  }

  function startLoaderProbe() {
    if (typeof MutationObserver === "function") {
      loaderProbeObserver = new MutationObserver(() => probeLoader());
      loaderProbeObserver.observe(document, {
        childList: true,
        subtree: true
      });
    }

    for (const delay of [0, 25, 100, 500, 2000, 5000]) {
      const timer = window.setTimeout(() => {
        loaderProbeTimers.delete(timer);
        probeLoader();
        if (delay === 5000 && !patchedConnectionHandler) {
          connectionHandlerStatus = "missed";
          publishStatus("connection-handler-missed");
          stopLoaderProbe();
        }
      }, delay);
      loaderProbeTimers.add(timer);
    }
    probeLoader();
  }

  function maybeReleaseLoaderAccessor() {
    if (
      (!interceptedFactory && !patchedApi) ||
      (!interceptedConnectionFactory && !patchedConnectionHandler) ||
      typeof releaseLoaderAccessor !== "function"
    ) {
      return;
    }
    const release = releaseLoaderAccessor;
    releaseLoaderAccessor = null;
    release();
  }

  function wrapDefine(defineFunction) {
    if (
      typeof defineFunction !== "function" ||
      Number(defineFunction[DEFINE_MARKER] || 0) >= GUARD_VERSION
    ) {
      return defineFunction;
    }

    const wrappedDefine = function () {
      const moduleName = arguments[0];
      const factory = arguments[2];
      let result;
      if (moduleName === STREAM_MODULE && typeof factory === "function") {
        const nextArguments = Array.prototype.slice.call(arguments);
        nextArguments[2] = wrapFactory(factory);
        result = defineFunction.apply(this, nextArguments);
      } else if (
        moduleName === CONNECTION_MODULE &&
        typeof factory === "function"
      ) {
        const nextArguments = Array.prototype.slice.call(arguments);
        nextArguments[2] = wrapConnectionFactory(factory);
        result = defineFunction.apply(this, nextArguments);
      } else {
        result = defineFunction.apply(this, arguments);
      }
      maybeReleaseLoaderAccessor();
      return result;
    };
    Object.defineProperty(wrappedDefine, DEFINE_MARKER, {
      value: GUARD_VERSION
    });
    return wrappedDefine;
  }

  function installLoaderInterceptor() {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, "__d");
      const currentDefine = wrapDefine(window.__d);
      if (!descriptor || descriptor.configurable === true) {
        let activeDefine = currentDefine;
        Object.defineProperty(window, "__d", {
          configurable: true,
          enumerable: descriptor?.enumerable !== false,
          get() {
            return activeDefine;
          },
          set(nextDefine) {
            activeDefine = wrapDefine(nextDefine);
            patchExistingModule();
            maybeReleaseLoaderAccessor();
          }
        });
        releaseLoaderAccessor = () => {
          Object.defineProperty(window, "__d", {
            configurable: true,
            enumerable: descriptor?.enumerable !== false,
            writable: true,
            value: activeDefine
          });
          loaderMode = "direct-after-target";
        };
        loaderMode = "accessor";
        publishStatus("waiting-for-factory");
      } else if (
        descriptor.writable === true &&
        typeof currentDefine === "function"
      ) {
        window.__d = currentDefine;
        loaderMode = "direct";
        publishStatus("waiting-for-factory");
      } else {
        loaderMode = "unavailable";
        recordError("install-loader", "Facebook's __d loader is not replaceable.");
      }
      patchExistingModule();
      maybeReleaseLoaderAccessor();
    } catch (error) {
      loaderMode = "failed";
      recordError("install-loader", error);
    }
  }

  window[STATE_KEY] = Object.freeze({
    version: GUARD_VERSION,
    installedAt,
    get enabled() {
      return enabled;
    },
    get interceptedFactory() {
      return interceptedFactory;
    },
    get patchedApi() {
      return patchedApi;
    },
    get interceptedPayloadConsumer() {
      return interceptedPayloadConsumer;
    },
    get patchedPayloadListener() {
      return patchedPayloadListener;
    },
    get interceptedConnectionFactory() {
      return interceptedConnectionFactory;
    },
    get patchedConnectionHandler() {
      return patchedConnectionHandler;
    },
    get connectionHandlerStatus() {
      return connectionHandlerStatus;
    },
    get payloadObserverStatus() {
      return payloadObserverStatus;
    },
    get requireLazyStatus() {
      return requireLazyStatus;
    },
    get loaderMode() {
      return loaderMode;
    },
    get suppressedCount() {
      return suppressedCount;
    },
    get errors() {
      return errors.map((entry) => ({ ...entry }));
    }
  });

  publishStatus();
  startPayloadObserver();
  installRequireLazyInterceptor();
  installRequireLazyQueueInterceptor();
  installBootstrapQueueInterceptor();
  installLoaderInterceptor();
  installModuleRequireInterceptor();
  startLoaderProbe();
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      sanitizeExistingPayloadScripts();
      stopPayloadObserver();
      releaseRequireLazyInterceptor();
      probeLoader();
      if (
        !patchedApi &&
        !interceptedFactory &&
        !interceptedPayloadConsumer &&
        !patchedConnectionHandler &&
        !interceptedConnectionFactory
      ) {
        publishStatus("probe-missed-after-dom");
        stopLoaderProbe();
      } else {
        publishStatus();
      }
    },
    { once: true }
  );
})();
