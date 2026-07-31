(() => {
  "use strict";

  /*
    Facebook exposes a small number of named modules for two independent
    behaviors Faceberg can disable without touching shared feed transport:

    Anti-refresh:
    - useCometHomeStaleFeedRefresh
    - useCometFeedPushViewCloseRefresh
    - useInvalidateCometNewsFeedConnectionOnMaintainedRouteUnmount
    - useCometNewsFeedRefreshThrottler
    - useRefreshCometStoriesTrayOnMaintainedRouteUnmount

    Right-column Sponsored module:
    - CometHomeRightSideEgo.react
    - useSideAdsRefreshHandler

    The background worker registers this document-start interceptor with
    feature flags that mirror the user's settings. It replaces only the active
    group's exact module factories. Manual refresh, the normal feed query,
    pagination, routing, visibility, media playback, fetch, XMLHttpRequest, and
    Facebook's timer functions are deliberately left untouched.
  */
  const GUARD_VERSION = 4;
  const STATE_KEY = "__facebergStaleFeedGuardState";
  const DEFINE_MARKER = "__facebergStaleFeedDefineVersion";
  const FACTORY_MARKER = "__facebergStaleFeedFactoryVersion";
  const ANTI_REFRESH_TARGET_MODULES = Object.freeze([
    "useCometHomeStaleFeedRefresh",
    "useCometFeedPushViewCloseRefresh",
    "useInvalidateCometNewsFeedConnectionOnMaintainedRouteUnmount",
    "useCometNewsFeedRefreshThrottler",
    "useRefreshCometStoriesTrayOnMaintainedRouteUnmount"
  ]);
  const FEED_FILTER_TARGET_MODULES = Object.freeze([
    "CometHomeRightSideEgo.react",
    "useSideAdsRefreshHandler"
  ]);
  const moduleGuardConfig = Object.freeze({
    antiRefresh:
      window.__facebergModuleGuardConfig?.antiRefresh === true,
    feedFilter:
      window.__facebergModuleGuardConfig?.feedFilter === true
  });
  const TARGET_MODULES = Object.freeze([
    ...(moduleGuardConfig.antiRefresh ? ANTI_REFRESH_TARGET_MODULES : []),
    ...(moduleGuardConfig.feedFilter ? FEED_FILTER_TARGET_MODULES : [])
  ]);
  const TARGET_MODULE_SET = new Set(TARGET_MODULES);

  if (Number(window[STATE_KEY]?.version || 0) >= GUARD_VERSION) {
    return;
  }

  const inheritedLoaderWrapper =
    window[STATE_KEY]?.loaderWrapped === true;
  const installedAt = Date.now();
  const interceptedModules = [];
  const disabledModules = [];
  const lateDetectedModules = [];
  const latePatchedModules = [];
  const errors = [];
  let loaderWrapped = false;
  let loaderMode = "not-found";
  let latePatchRequiresReload = false;
  let releaseLoaderAccessor = null;

  function addUnique(target, value) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }

  function recordError(stage, error) {
    errors.push({
      at: Date.now(),
      message: String(error?.message || error || "Unknown error").slice(0, 240),
      stage
    });
    if (errors.length > 20) {
      errors.splice(0, errors.length - 20);
    }
  }

  const inertDisposable = Object.freeze({
    dispose() {}
  });
  const disabledHomeResult = Object.freeze({
    blockStaleFeedRefresh() {
      return inertDisposable;
    }
  });

  function useDisabledHomeStaleFeedRefresh() {
    return disabledHomeResult;
  }

  function useDisabledFeedLifecycleRefresh() {}

  const disabledNewsFeedRefreshHandler = Object.freeze(function () {});

  function useDisabledNewsFeedRefreshThrottler() {
    return disabledNewsFeedRefreshHandler;
  }

  function renderDisabledRightSideSponsored() {
    return null;
  }

  function disabledSideAdsRef() {}

  function useDisabledSideAdsRefreshHandler() {
    return disabledSideAdsRef;
  }

  Object.defineProperty(useDisabledHomeStaleFeedRefresh, "displayName", {
    value: "FacebergDisabledHomeStaleFeedRefresh"
  });
  Object.defineProperty(useDisabledFeedLifecycleRefresh, "displayName", {
    value: "FacebergDisabledFeedLifecycleRefresh"
  });
  Object.defineProperty(useDisabledNewsFeedRefreshThrottler, "displayName", {
    value: "FacebergDisabledNewsFeedRefreshThrottler"
  });
  Object.defineProperty(renderDisabledRightSideSponsored, "displayName", {
    value: "FacebergDisabledRightSideSponsored"
  });
  Object.defineProperty(useDisabledSideAdsRefreshHandler, "displayName", {
    value: "FacebergDisabledSideAdsRefreshHandler"
  });

  function getDisabledExport(moduleName) {
    if (moduleName === "useCometHomeStaleFeedRefresh") {
      return useDisabledHomeStaleFeedRefresh;
    }
    if (moduleName === "useCometNewsFeedRefreshThrottler") {
      return useDisabledNewsFeedRefreshThrottler;
    }
    if (moduleName === "CometHomeRightSideEgo.react") {
      return renderDisabledRightSideSponsored;
    }
    if (moduleName === "useSideAdsRefreshHandler") {
      return useDisabledSideAdsRefreshHandler;
    }
    return useDisabledFeedLifecycleRefresh;
  }

  function createDisabledFactory(moduleName) {
    const disabledFactory = function () {
      const factoryArguments = arguments;
      const exportsObject = factoryArguments[factoryArguments.length - 1];
      if (
        !exportsObject ||
        (typeof exportsObject !== "object" &&
          typeof exportsObject !== "function")
      ) {
        recordError(moduleName, "Facebook module factory did not expose exports.");
        return;
      }

      exportsObject.default = getDisabledExport(moduleName);
      addUnique(disabledModules, moduleName);
    };

    Object.defineProperty(disabledFactory, FACTORY_MARKER, {
      value: GUARD_VERSION
    });
    return disabledFactory;
  }

  function replaceFactory(moduleName, factory) {
    if (
      !TARGET_MODULE_SET.has(moduleName) ||
      typeof factory !== "function" ||
      Number(factory[FACTORY_MARKER] || 0) >= GUARD_VERSION
    ) {
      return factory;
    }

    addUnique(interceptedModules, moduleName);
    return createDisabledFactory(moduleName);
  }

  function maybeReleaseLoaderAccessor() {
    if (
      typeof releaseLoaderAccessor !== "function" ||
      TARGET_MODULES.length === 0 ||
      !TARGET_MODULES.every((moduleName) => interceptedModules.includes(moduleName))
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
      const replacementFactory = replaceFactory(moduleName, arguments[2]);
      let result;
      if (replacementFactory === arguments[2]) {
        result = defineFunction.apply(this, arguments);
      } else {
        const nextArguments = Array.prototype.slice.call(arguments);
        nextArguments[2] = replacementFactory;
        result = defineFunction.apply(this, nextArguments);
      }
      maybeReleaseLoaderAccessor();
      return result;
    };

    Object.defineProperty(wrappedDefine, DEFINE_MARKER, {
      value: GUARD_VERSION
    });
    loaderWrapped = true;
    return wrappedDefine;
  }

  function patchFinishedModule(moduleName, moduleRecord) {
    addUnique(interceptedModules, moduleName);
    addUnique(lateDetectedModules, moduleName);
    latePatchRequiresReload = true;

    /*
      Replacing a hook or mounted component after React has already rendered it
      can change the active hook chain. Leave the live page untouched and let
      the document-start interceptor handle it on reload.
    */
    if (FEED_FILTER_TARGET_MODULES.includes(moduleName)) {
      return;
    }

    const replacement = getDisabledExport(moduleName);
    if (
      moduleRecord.exports &&
      (typeof moduleRecord.exports === "object" ||
        typeof moduleRecord.exports === "function")
    ) {
      moduleRecord.exports.default = replacement;
    }
    moduleRecord.defaultExport = replacement;
    addUnique(disabledModules, moduleName);
    addUnique(latePatchedModules, moduleName);
  }

  function patchExistingModuleRecords() {
    try {
      if (typeof window.require !== "function") {
        return;
      }

      const modulesMap = window.require("__debug")?.modulesMap;
      if (!modulesMap || typeof modulesMap !== "object") {
        return;
      }

      for (const moduleName of TARGET_MODULES) {
        const moduleRecord = modulesMap[moduleName];
        if (!moduleRecord) {
          continue;
        }

        if (moduleRecord.factoryFinished === true) {
          patchFinishedModule(moduleName, moduleRecord);
          continue;
        }

        if (typeof moduleRecord.factory === "function") {
          moduleRecord.factory = replaceFactory(
            moduleName,
            moduleRecord.factory
          );
          moduleRecord.factoryLength = -1;
        }
      }
    } catch (error) {
      recordError("patch-existing-modules", error);
    }
  }

  function installDefineInterceptor() {
    try {
      if (inheritedLoaderWrapper) {
        /*
          An extension update can inject v2 into a document still carrying the
          v1 accessor. Replacing that accessor would detach v1's setter. Keep
          the existing wrapper intact, patch only safe finished anti-refresh
          exports, and require a normal page reload for the full v2 target set.
        */
        patchExistingModuleRecords();
        loaderMode = "legacy-reload-required";
        latePatchRequiresReload = true;
        return;
      }

      const descriptor = Object.getOwnPropertyDescriptor(window, "__d");
      const currentDefine = wrapDefine(window.__d);

      if (!descriptor || descriptor.configurable === true) {
        let activeDefine = currentDefine;
        const enumerable = descriptor?.enumerable !== false;
        Object.defineProperty(window, "__d", {
          configurable: true,
          enumerable,
          get() {
            return activeDefine;
          },
          set(nextDefine) {
            activeDefine = wrapDefine(nextDefine);
            patchExistingModuleRecords();
            maybeReleaseLoaderAccessor();
          }
        });
        releaseLoaderAccessor = () => {
          Object.defineProperty(window, "__d", {
            configurable: true,
            enumerable,
            writable: true,
            value: activeDefine
          });
          loaderMode = "direct-after-targets";
        };
        loaderMode = "accessor";
      } else if (
        descriptor.writable === true &&
        typeof currentDefine === "function"
      ) {
        window.__d = currentDefine;
        loaderMode = "direct";
      } else {
        loaderMode = "unavailable";
        recordError(
          "install-loader-interceptor",
          "Facebook's __d module loader is not replaceable."
        );
      }

      patchExistingModuleRecords();
      maybeReleaseLoaderAccessor();
    } catch (error) {
      loaderMode = "failed";
      recordError("install-loader-interceptor", error);
    }
  }

  window[STATE_KEY] = Object.freeze({
    version: GUARD_VERSION,
    installedAt,
    activeFeatures: moduleGuardConfig,
    targetModules: TARGET_MODULES,
    get loaderWrapped() {
      return loaderWrapped;
    },
    get loaderMode() {
      return loaderMode;
    },
    get interceptedModules() {
      return [...interceptedModules];
    },
    get disabledModules() {
      return [...disabledModules];
    },
    get lateDetectedModules() {
      return [...lateDetectedModules];
    },
    get latePatchedModules() {
      return [...latePatchedModules];
    },
    get latePatchRequiresReload() {
      return latePatchRequiresReload;
    },
    get errors() {
      return errors.map((entry) => ({ ...entry }));
    }
  });

  installDefineInterceptor();
})();
