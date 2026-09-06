// Quick test for buildImpactShowcase logic
const stats = {
  removedReels: 10,
  removedSponsored: 5,
  expandedPosts: 20,
  expandedComments: 15,
  preventedRefreshes: 3
};

function formatStat(value) {
  return Number(value || 0).toLocaleString();
}

const impactItems = [
  {
    icon: "🧹",
    text: `Auto-removed ${formatStat(stats.removedReels || 0)} Reels and ${formatStat(stats.removedSponsored || 0)} sponsored posts`,
    meta: "from your feed"
  },
  {
    icon: "📖",
    text: `Expanded ${formatStat(stats.expandedPosts || 0)} posts and ${formatStat(stats.expandedComments || 0)} comment threads`,
    meta: "without clicking 'See more'"
  },
  {
    icon: "🛡️",
    text: `Prevented ${formatStat(stats.preventedRefreshes || 0)} page reloads`,
    meta: "when switching tabs"
  }
].filter(item => {
  // Only show items with non-zero values
  const text = item.text;
  const numbers = text.match(/\d+/g);
  return numbers && numbers.some(num => parseInt(num) > 0);
});

console.log('Filtered impact items:', impactItems.length);
impactItems.forEach(item => console.log(item.text));

const fs = require("fs");
const assert = require("assert");
const vm = require("vm");
const sourceFiles = Object.fromEntries(
  [
    "background.js",
    "content.js",
    "content-feed.js",
    "content-comments.js",
    "content.css",
    "popup.js",
    "popup.html",
    "manifest.json",
    "shared-stats.js",
    "main-feed-sponsored-guard.js",
    "stale-feed-guard.js"
  ]
    .map((name) => [name, fs.readFileSync(name, "utf8")])
);

const booleanSettingKeys = [
  "enableAntiRefresh",
  "enableFeedFilter",
  "enablePostExpansion",
  "enableCommentSortAll",
  "enableCommentExpansion",
  "enableBlockSponsoredPosts",
  "enableBlockSponsoredSidebar",
  "enableBlockSponsoredReels",
  "enableBlockReels",
  "enableBlockStories",
  "enableBlockPeopleYouMayKnow",
  "enableBlockFollowPosts",
  "enableBlockJoinPosts",
  "enableCompactHiddenCards",
  "enableGoDirectlyToFeeds"
];

for (const settingKey of booleanSettingKeys) {
  assert.match(
    sourceFiles["popup.html"],
    new RegExp(`id=["']${settingKey}["']`),
    `popup.html: missing ${settingKey} control`
  );
  assert.match(
    sourceFiles["popup.js"],
    new RegExp(`\\b${settingKey}\\b`),
    `popup.js: missing ${settingKey} persistence wiring`
  );
  assert.match(
    sourceFiles["content.js"],
    new RegExp(`changes\\.${settingKey}`),
    `content.js: missing live ${settingKey} update wiring`
  );
}

assert.match(
  sourceFiles["popup.html"],
  /id="groupFeedDefaultSort"/,
  "popup.html: missing group-feed sort control"
);
assert.match(
  sourceFiles["content.js"],
  /changes\.groupFeedDefaultSort/,
  "content.js: missing live group-feed sort update wiring"
);

const settingsDefaultsFixture = { enableBlockReels: true };
assert.strictEqual(
  {
    ...settingsDefaultsFixture,
    ...{ enableBlockReels: false },
    ...{}
  }.enableBlockReels,
  false,
  "a real local setting must survive when the preferred sync area lacks it"
);

for (const name of ["background.js", "content.js", "popup.js"]) {
  assert.doesNotMatch(
    sourceFiles[name],
    /chrome\.storage\.(?:sync|local)\.get\(DEFAULT_SETTINGS\)/,
    `${name}: default-filled storage reads can overwrite a real fallback value`
  );
  assert.match(
    sourceFiles[name],
    /chrome\.storage\.(?:sync|local)\.get\(settingKeys\)/,
    `${name}: settings reads must request only actually stored values`
  );
}

for (const name of ["content.js", "popup.js"]) {
  assert.match(
    sourceFiles[name],
    /enableBlockStories:\s*true/,
    `${name}: missing the Stories default`
  );
  assert.match(
    sourceFiles[name],
    /enableBlockStories/,
    `${name}: missing the Stories setting wiring`
  );
  assert.match(
    sourceFiles[name],
    /enableBlockSponsoredReels:\s*true/,
    `${name}: missing the Sponsored Reels default`
  );
  assert.match(
    sourceFiles[name],
    /enableBlockSponsoredReels/,
    `${name}: missing the Sponsored Reels setting wiring`
  );
}

for (const name of ["background.js", "content.js", "popup.js"]) {
  assert.match(
    sourceFiles[name],
    /enableAntiRefresh:\s*true/,
    `${name}: anti-refresh protection must default to enabled`
  );
}

assert.match(
  sourceFiles["popup.html"],
  /id="enableBlockStories"/,
  "popup.html: missing the Stories toggle"
);
assert.match(
  sourceFiles["popup.html"],
  /id="enableBlockSponsoredReels"/,
  "popup.html: missing the Sponsored Reels toggle"
);
assert.match(
  sourceFiles["content-feed.js"],
  /isVerifiedStoriesRegion/,
  "content-feed.js: missing the Stories boundary"
);
assert.match(
  sourceFiles["content-feed.js"],
  /isVerifiedReelsRegion/,
  "content-feed.js: missing the Reels boundary"
);
assert.match(
  sourceFiles["content-feed.js"],
  /restoreHiddenFeedModules\("reels"\)/,
  "content-feed.js: disabling Reels must restore its module"
);
assert.match(
  sourceFiles["content-feed.js"],
  /isVerifiedPeopleYouMayKnowModule/,
  "content-feed.js: missing the People You May Know boundary"
);
assert.match(
  sourceFiles["content-feed.js"],
  /restoreHiddenFeedModules\("people-you-may-know"\)/,
  "content-feed.js: disabling People You May Know must restore its module"
);
assert.match(
  sourceFiles["content-feed.js"],
  /markFeedModuleHidden\(\s*target,\s*"people-you-may-know",\s*"removedPeopleYouMayKnow"/s,
  "content-feed.js: People You May Know must use reversible layout suppression"
);
assert.match(
  sourceFiles["content-feed.js"],
  /runSponsoredReelFiltering/,
  "content-feed.js: missing Sponsored Reel filtering"
);
assert.match(
  sourceFiles["content-feed.js"],
  /const SPONSORED_REEL_CTA_LABELS = new Set\([\s\S]*?"learn more"[\s\S]*?"play game"[\s\S]*?"shop now"[\s\S]*?"sign up"/,
  "content-feed.js: missing early Sponsored Reel CTA signals"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function isExternalReelDestinationLink\([\s\S]*?hostname === "l\.facebook\.com"[\s\S]*?!isFacebookHost[\s\S]*?element\.target === "_blank"/,
  "content-feed.js: Reel ads must require an explicit external destination"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function isExactSponsoredReelLabel\([\s\S]*?label !== "sponsored" && label !== "ad"[\s\S]*?markerRect\.height <= 48/,
  "content-feed.js: compact Facebook Ad badges must qualify without matching caption text"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function getSponsoredReelMarkers\([\s\S]*?isExactSponsoredReelLabel\(element\)[\s\S]*?isSponsoredReelCta\(element\)/,
  "content-feed.js: Reel ads must qualify from either the label or the earlier CTA"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function skipActiveSponsoredReel\([\s\S]*?getNextReelControl\(\)[\s\S]*?pressElement\(nextControl[\s\S]*?"sponsored-reel-native-skip"/,
  "content-feed.js: an active ad must advance through Facebook's native Next control"
);
assert.match(
  sourceFiles["manifest.json"],
  /"js"\s*:\s*\["main-feed-sponsored-guard\.js",\s*"injected\.js"\][\s\S]*?"run_at"\s*:\s*"document_start"[\s\S]*?"world"\s*:\s*"MAIN"/,
  "manifest.json: Vivaldi-safe Sponsored stream filtering must start in Facebook's MAIN world"
);
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /RelayPrefetchedStreamCache[\s\S]*?CometNewsFeed_viewerConnection\$stream\$CometNewsFeed_viewer_news_feed/,
  "main-feed-sponsored-guard.js: missing the exact Home-feed stream boundary"
);
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /CometNewsFeedConnectionHandler[\s\S]*?filterConnectionEdges[\s\S]*?replaceConnectionUpdate/,
  "main-feed-sponsored-guard.js: missing the normalized Home-feed connection boundary"
);
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /hasExplicitSponsoredData[\s\S]*?sponsored_data[\s\S]*?th_dat_spo[\s\S]*?rewriteStreamArgs/,
  "main-feed-sponsored-guard.js: suppression must require Facebook's explicit sponsored payload data"
);
assert.match(
  sourceFiles["content.js"],
  /MAIN_FEED_SPONSORED_CONFIG_KIND[\s\S]*?settings\.enableFeedFilter === true[\s\S]*?settings\.enableBlockSponsoredPosts === true/,
  "content.js: the manifest guard must still follow the user's Sponsored-post setting"
);

{
  let registeredFactory = null;
  const forwarded = [];
  const events = [];
  const diagnostics = {};
  const context = {
    CustomEvent: function CustomEvent(type) {
      this.type = type;
    },
    document: {
      documentElement: {
        setAttribute(name, value) {
          diagnostics[name] = value;
        }
      },
      addEventListener() {},
      dispatchEvent(event) {
        events.push(event.type);
      }
    },
    window: {
      addEventListener() {},
      clearTimeout() {},
      setTimeout() {
        return 1;
      },
      __d(moduleName, _dependencies, factory) {
        if (moduleName === "RelayPrefetchedStreamCache") {
          registeredFactory = factory;
        }
      }
    }
  };
  vm.runInNewContext(sourceFiles["main-feed-sponsored-guard.js"], context);
  context.window.__d(
    "RelayPrefetchedStreamCache",
    [],
    function defineRelayPrefetchedStreamCache(
      _global,
      _require,
      _requireDynamic,
      _requireLazy,
      _module,
      _exports,
      exportsObject
    ) {
      exportsObject.next = (...args) => forwarded.push(args);
    }
  );
  assert.strictEqual(
    typeof registeredFactory,
    "function",
    "module guard must replace the stream-cache factory"
  );

  const streamApi = {};
  registeredFactory(null, null, null, null, null, null, streamApi);
  const makePatch = (index, sponsored, label = "CometNewsFeed_viewerConnection$stream$CometNewsFeed_viewer_news_feed") => ({
    __bbox: {
      complete: false,
      result: {
        label,
        path: ["viewer", "news_feed", "edges", index],
        data: {
          node: {
            th_dat_spo: sponsored ? { __typename: "SponsoredData" } : null,
            comet_sections: {
              feedback: {
                story: {
                  sponsored_data: sponsored ? { __typename: "SponsoredData" } : null
                }
              }
            }
          }
        }
      }
    }
  });

  streamApi.next("home-stream", makePatch(1, true));
  streamApi.next("home-stream", makePatch(2, false));
  streamApi.next("other-stream", makePatch(7, true, "Unrelated_stream_label"));

  assert.strictEqual(forwarded.length, 2, "the explicit Sponsored edge must not reach Relay");
  assert.strictEqual(
    forwarded[0][1].__bbox.result.path[3],
    1,
    "organic edges after a removed ad must be compacted to a dense index"
  );
  assert.strictEqual(
    forwarded[1][1].__bbox.result.path[3],
    7,
    "unrelated Relay streams must remain untouched"
  );
  assert.deepStrictEqual(
    events,
    ["__facebergMainFeedSponsoredSuppressedV1"],
    "each suppressed stream ad must emit one stats event"
  );
  assert.strictEqual(
    context.window.__facebergMainFeedSponsoredGuardState.suppressedCount,
    1,
    "guard diagnostics must count only filtered Home-feed ads"
  );
  assert.strictEqual(
    diagnostics["data-faceberg-main-feed-sponsored-guard"],
    "suppressed",
    "the live DOM diagnostic must expose successful stream suppression"
  );
}
{
  let registeredFactory = null;
  let originalUpdateCalls = 0;
  const diagnostics = {};
  const events = [];
  const context = {
    CustomEvent: function CustomEvent(type) {
      this.type = type;
    },
    document: {
      documentElement: {
        setAttribute(name, value) {
          diagnostics[name] = value;
        }
      },
      addEventListener() {},
      dispatchEvent(event) {
        events.push(event.type);
      }
    },
    window: {
      addEventListener() {},
      clearTimeout() {},
      setTimeout() {
        return 1;
      },
      __d(moduleName, _dependencies, factory) {
        if (moduleName === "CometNewsFeedConnectionHandler") {
          registeredFactory = factory;
        }
      }
    }
  };
  vm.runInNewContext(sourceFiles["main-feed-sponsored-guard.js"], context);
  context.window.__d(
    "CometNewsFeedConnectionHandler",
    [],
    function defineConnectionHandler(
      _global,
      _require,
      _requireDynamic,
      _requireLazy,
      _module,
      _exports,
      exportsObject
    ) {
      exportsObject.update = () => {
        originalUpdateCalls += 1;
      };
    }
  );
  assert.strictEqual(
    typeof registeredFactory,
    "function",
    "module guard must replace the Home-feed connection-handler factory"
  );

  const makeNode = (sponsored) => ({
    getLinkedRecord(field) {
      if (field !== "th_dat_spo" || !sponsored) {
        return null;
      }
      return {
        getType() {
          return "SponsoredData";
        }
      };
    }
  });
  const organicEdge = {
    getLinkedRecord(field) {
      return field === "node" ? makeNode(false) : null;
    }
  };
  const sponsoredEdge = {
    getLinkedRecord(field) {
      return field === "node" ? makeNode(true) : null;
    }
  };
  const connection = {
    edges: [organicEdge, sponsoredEdge],
    getLinkedRecords(field) {
      return field === "edges" ? this.edges : null;
    },
    setLinkedRecords(edges, field) {
      if (field === "edges") {
        this.edges = edges;
      }
    }
  };
  const parent = {
    getLinkedRecord(field) {
      return field === "home_handle" ? connection : null;
    }
  };
  const store = {
    get(dataID) {
      return dataID === "client:root:viewer" ? parent : null;
    }
  };
  const handler = {};
  registeredFactory(null, null, null, null, null, null, handler);
  handler.update(store, {
    dataID: "client:root:viewer",
    handleKey: "home_handle"
  });

  assert.strictEqual(originalUpdateCalls, 1, "the native connection update must run once");
  assert.strictEqual(
    connection.edges.length,
    1,
    "the Sponsored edge must be removed from Relay before feed layout consumes it"
  );
  assert.strictEqual(connection.edges[0], organicEdge);
  assert.strictEqual(
    diagnostics["data-faceberg-main-feed-connection-handler"],
    "patched",
    "live diagnostics must confirm the connection handler is patched"
  );
  assert.strictEqual(
    diagnostics["data-faceberg-main-feed-sponsored-guard"],
    "suppressed-at-connection",
    "connection-level suppression must be visible in live diagnostics"
  );
  assert.deepStrictEqual(events, ["__facebergMainFeedSponsoredSuppressedV1"]);
}
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /function interceptBootstrapDefineQueue[\s\S]*?STUB_PUSH_MARKER[\s\S]*?factory-intercepted-stub-push[\s\S]*?function installBootstrapQueueInterceptor[\s\S]*?Object\.defineProperty\(window, "__d_stub"/,
  "main-feed-sponsored-guard.js: Vivaldi startup must synchronously intercept the stub queue before a MutationObserver checkpoint"
);
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /function interceptRequireLazyQueue[\s\S]*?LAZY_STUB_PUSH_MARKER/,
  "main-feed-sponsored-guard.js: the Facebook requireLazy bootstrap queue must be intercepted synchronously"
);
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /function installRequireLazyQueueInterceptor[\s\S]*?Object\.defineProperty\(window, "__rl_stub"[\s\S]*?set\(nextQueue\)[\s\S]*?interceptRequireLazyQueue\(activeQueue\)/,
  "main-feed-sponsored-guard.js: Facebook may assign its requireLazy queue after document_start"
);
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /function wrapRequireLazy[\s\S]*?wrapPayloadListenerCallback[\s\S]*?function installRequireLazyInterceptor[\s\S]*?Object\.defineProperty\(window, "requireLazy"[\s\S]*?set\(nextRequireLazy\)/,
  "main-feed-sponsored-guard.js: later direct requireLazy payload calls must not bypass the queued consumer hook"
);
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /function installModuleRequireInterceptor[\s\S]*?Object\.defineProperty\(window, "require"[\s\S]*?set\(nextRequire\)[\s\S]*?patchExistingModule\(\)/,
  "main-feed-sponsored-guard.js: Facebook's later module-require assignment must trigger a connection-handler patch"
);
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /function maybeStopLoaderProbe\(\)\s*\{\s*if \(patchedConnectionHandler\)/,
  "main-feed-sponsored-guard.js: disproven payload hooks must not stop connection-handler discovery"
);
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /function replacePayloadProcess[\s\S]*?sanitizeExistingPayloadScripts\(\);[\s\S]*?originalProcess\.apply/,
  "main-feed-sponsored-guard.js: the queued payload listener must sanitize exact commands synchronously before Facebook processes them"
);
assert.doesNotMatch(
  sourceFiles["main-feed-sponsored-guard.js"],
  /loaderProbeObserver\s*=\s*new MutationObserver\([\s\S]{0,160}sanitize(?:Payload|Existing)/,
  "main-feed-sponsored-guard.js: payload rewriting must not share the loader probe that stops after API patching"
);
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /function startPayloadObserver[\s\S]*?new MutationObserver\(\(records\)[\s\S]*?sanitizePayloadMutations\(records\)[\s\S]*?function replacePayloadProcess/,
  "main-feed-sponsored-guard.js: a dedicated early observer must precede Facebook's long-lived payload listener"
);
assert.match(
  sourceFiles["main-feed-sponsored-guard.js"],
  /function sanitizePayloadScript[\s\S]*?getAttribute\?\.\("data-processed"\) === "1"[\s\S]*?function stopPayloadObserver/,
  "main-feed-sponsored-guard.js: an already processed Facebook payload must never be rewritten"
);
{
  const forwarded = [];
  const context = {
    CustomEvent: function CustomEvent(type) {
      this.type = type;
    },
    MutationObserver: class MutationObserver {
      constructor() {}
      observe() {}
      disconnect() {}
    },
    document: {
      documentElement: {
        setAttribute() {}
      },
      addEventListener() {},
      dispatchEvent() {}
    },
    window: {
      addEventListener() {},
      clearTimeout() {},
      setTimeout() {
        return 1;
      }
    }
  };
  vm.runInNewContext(sourceFiles["main-feed-sponsored-guard.js"], context);
  context.window.__d_stub = [];
  const originalFactory = function originalFactory(
    _global,
    _require,
    _requireDynamic,
    _requireLazy,
    _module,
    _exports,
    exportsObject
  ) {
    exportsObject.next = (...args) => forwarded.push(args);
  };
  context.window.__d_stub.push([
    "RelayPrefetchedStreamCache",
    [],
    originalFactory,
    98
  ]);
  const queuedFactory = context.window.__d_stub[0][2];
  assert.notStrictEqual(
    queuedFactory,
    originalFactory,
    "the bootstrap queue push must synchronously wrap the stream-cache factory"
  );
  const streamApi = {};
  queuedFactory(null, null, null, null, null, null, streamApi);
  streamApi.next("home-stream", {
    __bbox: {
      complete: false,
      result: {
        label: "CometNewsFeed_viewerConnection$stream$CometNewsFeed_viewer_news_feed",
        path: ["viewer", "news_feed", "edges", 1],
        data: {
          node: {
            th_dat_spo: { __typename: "SponsoredData" }
          }
        }
      }
    }
  });
  assert.strictEqual(
    forwarded.length,
    0,
    "a Sponsored edge delivered through Facebook's queued Vivaldi bootstrap must be rejected"
  );
}

{
  const scripts = [];
  let processCalls = 0;
  const diagnostics = {};
  const context = {
    CustomEvent: function CustomEvent(type) {
      this.type = type;
    },
    document: {
      documentElement: {
        setAttribute(name, value) {
          diagnostics[name] = value;
        }
      },
      addEventListener() {},
      dispatchEvent() {},
      querySelectorAll() {
        return scripts;
      }
    },
    window: {
      addEventListener() {},
      clearTimeout() {},
      setTimeout() {
        return 1;
      }
    }
  };

  vm.runInNewContext(sourceFiles["main-feed-sponsored-guard.js"], context);

  context.window.__rl_stub = [];
  context.window.requireLazy = function requireLazy() {
    context.window.__rl_stub.push(arguments);
  };
  const originalCallback = (listener) => listener.process();
  context.window.requireLazy(
    ["ServerJSPayloadListener"],
    originalCallback,
    null,
    0x100
  );

  assert.strictEqual(
    context.window.__rl_stub.length,
    1,
    "Facebook's post-document_start queue assignment must remain functional"
  );
  const queuedCallback = context.window.__rl_stub[0][1];
  assert.notStrictEqual(
    queuedCallback,
    originalCallback,
    "a queue assigned after the guard starts must still wrap the payload consumer"
  );
  queuedCallback({
    process() {
      processCalls += 1;
    }
  });
  assert.strictEqual(
    processCalls,
    1,
    "the original Facebook payload processor must still run exactly once"
  );
  assert.strictEqual(
    diagnostics["data-faceberg-main-feed-payload-consumer"],
    "patched",
    "live diagnostics must expose the post-assignment payload-consumer hook"
  );
}

{
  const diagnostics = {};
  let processedCommands = null;
  const payload = {
    require: [
      [
        "ScheduledServerJS",
        "handle",
        null,
        [
          {
            __bbox: {
              require: [
                [
                  "RelayPrefetchedStreamCache",
                  "next",
                  [],
                  [
                    "home-stream",
                    {
                      __bbox: {
                        complete: false,
                        result: {
                          label:
                            "CometNewsFeed_viewerConnection$stream$CometNewsFeed_viewer_news_feed",
                          path: ["viewer", "news_feed", "edges", 1],
                          data: {
                            node: {
                              th_dat_spo: { __typename: "SponsoredData" }
                            }
                          }
                        }
                      }
                    }
                  ]
                ]
              ]
            }
          }
        ]
      ]
    ]
  };
  const script = {
    nodeType: 1,
    tagName: "SCRIPT",
    textContent: JSON.stringify(payload),
    getAttribute(name) {
      if (name === "type") {
        return "application/json";
      }
      return null;
    }
  };
  const listener = {
    process() {
      processedCommands =
        JSON.parse(script.textContent).require[0][3][0].__bbox.require;
    }
  };
  const context = {
    CustomEvent: function CustomEvent(type) {
      this.type = type;
    },
    document: {
      documentElement: {
        setAttribute(name, value) {
          diagnostics[name] = value;
        }
      },
      addEventListener() {},
      dispatchEvent() {},
      querySelectorAll(selector) {
        return selector === 'script[type="application/json"]' ? [script] : [];
      }
    },
    window: {
      addEventListener() {},
      clearTimeout() {},
      setTimeout() {
        return 1;
      }
    }
  };

  vm.runInNewContext(sourceFiles["main-feed-sponsored-guard.js"], context);
  const directRequireLazy = function directRequireLazy(_names, callback) {
    return callback(listener);
  };
  context.window.requireLazy = directRequireLazy;
  context.window.requireLazy(
    ["ServerJSPayloadListener"],
    (payloadListener) => payloadListener.process(),
    null,
    0x100
  );

  assert.strictEqual(
    processedCommands.length,
    0,
    "a direct post-bootstrap requireLazy process call must sanitize the adjacent payload synchronously"
  );
  assert.strictEqual(
    diagnostics["data-faceberg-main-feed-require-lazy"],
    "wrapped",
    "live diagnostics must expose interception of Facebook's real requireLazy function"
  );
  assert.strictEqual(
    diagnostics["data-faceberg-main-feed-sponsored-count"],
    "1",
    "direct requireLazy suppression must increment the live count"
  );
}

{
  const diagnostics = {};
  const connectionHandler = {
    update() {}
  };
  const originalUpdate = connectionHandler.update;
  const context = {
    CustomEvent: function CustomEvent(type) {
      this.type = type;
    },
    document: {
      documentElement: {
        setAttribute(name, value) {
          diagnostics[name] = value;
        }
      },
      addEventListener() {},
      dispatchEvent() {}
    },
    window: {
      addEventListener() {},
      clearTimeout() {},
      setTimeout() {
        return 1;
      }
    }
  };
  vm.runInNewContext(sourceFiles["main-feed-sponsored-guard.js"], context);
  context.window.require = function lateFacebookRequire(moduleName) {
    if (moduleName === "CometNewsFeedConnectionHandler") {
      return connectionHandler;
    }
    throw new Error(`Unknown module: ${moduleName}`);
  };
  assert.notStrictEqual(
    connectionHandler.update,
    originalUpdate,
    "a handler exposed by Facebook's late require assignment must be patched immediately"
  );
  assert.strictEqual(
    context.window.__facebergMainFeedSponsoredGuardState.patchedConnectionHandler,
    true
  );
  assert.strictEqual(
    diagnostics["data-faceberg-main-feed-connection-handler"],
    "patched"
  );
}

{
  const streamLabel =
    "CometNewsFeed_viewerConnection$stream$CometNewsFeed_viewer_news_feed";
  const makeCommand = (index, sponsored) => [
    "RelayPrefetchedStreamCache",
    "next",
    [],
    [
      "home-stream",
      {
        __bbox: {
          complete: false,
          result: {
            label: streamLabel,
            path: ["viewer", "news_feed", "edges", index],
            data: {
              node: {
                th_dat_spo: sponsored
                  ? { __typename: "SponsoredData" }
                  : null
              }
            }
          }
        }
      }
    ]
  ];
  const makePayloadScript = (command) => ({
    nodeType: 1,
    tagName: "SCRIPT",
    getAttribute(name) {
      return name === "type" ? "application/json" : null;
    },
    textContent: JSON.stringify({
      require: [
        [
          "ScheduledServerJS",
          "handle",
          null,
          [{ __bbox: { require: [command] } }]
        ]
      ]
    })
  });
  const scripts = [
    makePayloadScript(makeCommand(1, true)),
    makePayloadScript(makeCommand(2, false))
  ];
  let processedPayloads = null;
  const events = [];
  const diagnostics = {};
  const context = {
    CustomEvent: function CustomEvent(type) {
      this.type = type;
    },
    document: {
      documentElement: {
        setAttribute(name, value) {
          diagnostics[name] = value;
        }
      },
      addEventListener() {},
      dispatchEvent(event) {
        events.push(event.type);
      },
      querySelectorAll(selector) {
        return selector === 'script[type="application/json"]' ? scripts : [];
      }
    },
    window: {
      __rl_stub: [],
      addEventListener() {},
      clearTimeout() {},
      setTimeout() {
        return 1;
      }
    }
  };
  context.window.requireLazy = function requireLazy() {
    context.window.__rl_stub.push(arguments);
  };

  vm.runInNewContext(sourceFiles["main-feed-sponsored-guard.js"], context);
  const originalCallback = (listener) => listener.process();
  context.window.requireLazy(
    ["ServerJSPayloadListener"],
    originalCallback,
    null,
    0x100
  );
  assert.strictEqual(
    context.window.__rl_stub.length,
    1,
    "the Facebook requireLazy payload consumer must remain queued"
  );
  const queuedCallback = context.window.__rl_stub[0][1];
  assert.notStrictEqual(
    queuedCallback,
    originalCallback,
    "the queued ServerJSPayloadListener callback must be wrapped before bootstrap consumption"
  );

  const listener = {
    process() {
      processedPayloads = scripts.map((script) => JSON.parse(script.textContent));
    }
  };
  queuedCallback(listener);

  const firstCommands =
    processedPayloads[0].require[0][3][0].__bbox.require;
  const secondCommands =
    processedPayloads[1].require[0][3][0].__bbox.require;
  assert.strictEqual(
    firstCommands.length,
    0,
    "the exact Sponsored Home-feed command must be removed before payload processing"
  );
  assert.strictEqual(
    secondCommands[0][3][1].__bbox.result.path[3],
    1,
    "the later organic command must be compacted before payload processing"
  );
  assert.strictEqual(
    context.window.__facebergMainFeedSponsoredGuardState.patchedPayloadListener,
    true,
    "guard diagnostics must confirm that the payload consumer was patched"
  );
  assert.strictEqual(
    diagnostics["data-faceberg-main-feed-sponsored-guard"],
    "suppressed",
    "payload-level suppression must be visible in live diagnostics"
  );
  assert.deepStrictEqual(
    events,
    ["__facebergMainFeedSponsoredSuppressedV1"],
    "the payload consumer boundary must emit one stats event per removed ad"
  );
}

{
  const observers = [];
  const documentListeners = {};
  const diagnostics = {};
  const context = {
    CustomEvent: function CustomEvent(type) {
      this.type = type;
    },
    MutationObserver: class MutationObserver {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
    document: {
      documentElement: {
        setAttribute(name, value) {
          diagnostics[name] = value;
        }
      },
      addEventListener(type, callback) {
        documentListeners[type] = callback;
      },
      dispatchEvent() {},
      querySelectorAll() {
        return [];
      }
    },
    window: {
      addEventListener() {},
      clearTimeout() {},
      setTimeout() {
        return 1;
      }
    }
  };

  vm.runInNewContext(sourceFiles["main-feed-sponsored-guard.js"], context);
  assert.strictEqual(
    observers.length,
    2,
    "the dedicated payload observer and loader probe must be separate"
  );

  const payload = {
    require: [
      [
        "ScheduledServerJS",
        "handle",
        null,
        [
          {
            __bbox: {
              require: [
                [
                  "RelayPrefetchedStreamCache",
                  "next",
                  [],
                  [
                    "home-stream",
                    {
                      __bbox: {
                        complete: false,
                        result: {
                          label:
                            "CometNewsFeed_viewerConnection$stream$CometNewsFeed_viewer_news_feed",
                          path: ["viewer", "news_feed", "edges", 1],
                          data: {
                            node: {
                              th_dat_spo: { __typename: "SponsoredData" }
                            }
                          }
                        }
                      }
                    }
                  ]
                ]
              ]
            }
          }
        ]
      ]
    ]
  };
  const script = {
    nodeType: 1,
    tagName: "SCRIPT",
    textContent: JSON.stringify(payload),
    getAttribute(name) {
      if (name === "type") {
        return "application/json";
      }
      return null;
    }
  };

  observers[0].callback([
    {
      target: context.document,
      addedNodes: [script]
    }
  ]);
  const sanitized = JSON.parse(script.textContent);
  assert.strictEqual(
    sanitized.require[0][3][0].__bbox.require.length,
    0,
    "the earlier payload observer must remove the ad before Facebook's observer runs"
  );
  assert.strictEqual(
    diagnostics["data-faceberg-main-feed-sponsored-count"],
    "1",
    "observer-boundary suppression must update live diagnostics"
  );
  assert.strictEqual(
    observers[0].disconnected,
    false,
    "loader probing must not disconnect the dedicated payload observer"
  );

  documentListeners.DOMContentLoaded();
  assert.strictEqual(
    observers[0].disconnected,
    true,
    "the initial payload observer must disconnect after parser completion"
  );
  assert.strictEqual(
    diagnostics["data-faceberg-main-feed-payload-observer"],
    "stopped",
    "live diagnostics must expose the bounded payload-observer lifecycle"
  );
}

assert.match(
  sourceFiles["content-feed.js"],
  /if \(routeKey\) \{[\s\S]*?skipActiveSponsoredReel\(item, deps, routeKey\)[\s\S]*?continue;[\s\S]*?hideSponsoredReelItem/,
  "content-feed.js: the active scroll-snap item must never be layout-collapsed"
);
assert.match(
  sourceFiles["content-feed.js"],
  /const ENABLE_REACT_FEED_MUTATIONS = false/,
  "content-feed.js: ordinary React-owned feed-card mutations must fail open"
);
assert.match(
  sourceFiles["content-feed.js"],
  /const ENABLE_NATIVE_FEED_HIDE_ACTIONS = false/,
  "content-feed.js: production cleanup must not invoke native Hide actions"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function restoreAllSuppressedFeedUnits[\s\S]*?querySelectorAll\(`\[\$\{SUPPRESSED_FEED_UNIT_ATTRIBUTE\}\]\`\)/,
  "content-feed.js: compatibility mode must clear stale suppression markers"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function runSponsoredFeedFiltering[\s\S]*?restoreAllSuppressedFeedUnits\("react-feed-compatibility-mode"\)[\s\S]*?if \(!ENABLE_REACT_FEED_MUTATIONS\) \{\s*return;\s*\}[\s\S]*?hideBlockedLabelPostsWithoutNativeHide/,
  "content-feed.js: main-feed filtering must restore legacy state and return before native or CSS suppression"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function restoreSuppressedFeedCards[\s\S]*?restoreAllSuppressedFeedUnits\(reason\)[\s\S]*?Object\.freeze\(\{[\s\S]*?restoreSuppressedFeedCards/,
  "content-feed.js: legacy-card restoration must be available to navigation guards"
);
assert.match(
  sourceFiles["content.js"],
  /function suspendFeedAutomationForNavigation[\s\S]*?restoreSuppressedFeedCards\?\.\("navigation-started"\)[\s\S]*?function suspendFeedAutomationForTrustedInteraction[\s\S]*?restoreSuppressedFeedCards\?\.\("trusted-feed-interaction"\)[\s\S]*?restoreSuppressedFeedCards\?\.\("spa-route-changed"\)/,
  "content.js: clicks and SPA route changes must restore legacy card suppression immediately"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function getSponsoredMarkers\([\s\S]*?const structuralMarkers =[\s\S]*?hasSponsoredStructuralMetadata\(target\)/,
  "content-feed.js: Sponsored structural detection must remain available for future safe integrations"
);
assert.doesNotMatch(
  sourceFiles["content-feed.js"],
  /MASKED_FEED_UNIT_ATTRIBUTE|data-faceberg-masked-feed-unit|preserveLayout/,
  "content-feed.js: blank-space masking must not exist"
);
assert.doesNotMatch(
  sourceFiles["content.css"],
  /data-faceberg-masked-feed-unit/,
  "content.css: blank Sponsored placeholders are forbidden"
);
assert.doesNotMatch(
  sourceFiles["content.css"],
  /data-faceberg-suppressed-feed-unit|data-faceberg-allow-sponsored-feed|html:not\([^)]*\) main[\s\S]*?data-ad-rendering-role/,
  "content.css: ordinary main-feed cards must have no geometry-changing suppression rule"
);
assert.doesNotMatch(
  sourceFiles["content.js"],
  /ALLOW_SPONSORED_FEED_ATTRIBUTE|syncSponsoredFeedCssPolicy/,
  "content.js: unsafe pre-paint Sponsored policy must remain removed"
);
assert.doesNotMatch(
  sourceFiles["content-feed.js"],
  /querySelectorAll\([^)]*data-interactable|top:\s*-10000/,
  "content-feed.js: the fix must not mask or mutate Facebook's off-screen measurement bucket"
);
assert.match(
  sourceFiles["content-feed.js"],
  /\\u034F/,
  "content-feed.js: missing Facebook combining-joiner cleanup"
);
assert.match(
  sourceFiles["content-feed.js"],
  /querySelectorAll\("\[aria-labelledby\]"\)/,
  "content-feed.js: missing referenced Sponsored accessible-label detection"
);
assert.match(
  sourceFiles["content-feed.js"],
  /hasSponsoredStructuralMetadata/,
  "content-feed.js: missing persistent Sponsored structural evidence"
);
assert.doesNotMatch(
  sourceFiles["content.js"],
  /FEED_SCROLL_SETTLE_MS|scheduleSettledSponsoredFeedFiltering|isFeedScrollSettled/,
  "content.js: retired visible-card suppression must not retain delayed scroll passes"
);
assert.match(
  sourceFiles["content.js"],
  /function suspendFeedAutomationForNavigation\(\)[\s\S]*?commentAutomationSuspended = true;/,
  "content.js: post navigation must suspend stale comment controllers before Facebook handles the click"
);
assert.match(
  sourceFiles["content-comments.js"],
  /function isRenderedCommentSurface\([\s\S]*?\[aria-hidden="true"\], \[inert\], \[hidden\][\s\S]*?rect\.width > 0 && rect\.height > 0/,
  "content-comments.js: retained hidden or zero-area dialogs must not remain automatable"
);
assert.match(
  sourceFiles["content-comments.js"],
  /canonicalScopedDialog === documentTopDialog/,
  "content-comments.js: a scoped stale dialog must not outrank the document's top dialog"
);
assert.match(
  sourceFiles["content-comments.js"],
  /function getDocumentTopRenderedDialog\(\)[\s\S]*?filter\(\(dialog\) => isRenderedCommentSurface\(dialog\)\)[\s\S]*?function getVisiblePostDialog[\s\S]*?!isIgnoredDialog\(visibleDialog\)/,
  "content-comments.js: the top error dialog must block access to a stale post dialog underneath"
);
assert.match(
  sourceFiles["content.js"],
  /function suspendFeedAutomationForTrustedInteraction\(\)[\s\S]*?feedAutomationSuspended = true;[\s\S]*?TRUSTED_FEED_INTERACTION_PAUSE_MS[\s\S]*?isTrustedFeedCardInteraction\(event\)[\s\S]*?suspendFeedAutomationForTrustedInteraction\(\)/,
  "content.js: trusted feed-card interactions must pause layout-changing filtering during navigation"
);
assert.match(
  sourceFiles["content.js"],
  /function isTrustedFeedCardInteraction\(event\)[\s\S]*?event\.target\.closest\([\s\S]*?\[data-virtualized\][\s\S]*?feedUnit\.closest\('\[role="main"\], main'\)/,
  "content.js: delegated clicks on plain feed-card descendants must suspend filtering"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function suppressFeedUnitWithoutNativeHide\([\s\S]*?deps\.isFeedInteractionActive\(\)[\s\S]*?return false;/,
  "content-feed.js: direct suppression must fail closed during trusted feed interaction"
);
assert.match(
  sourceFiles["content.js"],
  /SPA_COMMENT_SURFACE_STABILIZE_MS = 1200[\s\S]*?pendingSpaCommentReadyAt = Date\.now\(\) \+ SPA_COMMENT_SURFACE_STABILIZE_MS[\s\S]*?Date\.now\(\) < pendingSpaCommentReadyAt/,
  "content.js: SPA comment automation must wait for the replacement dialog to stabilize"
);
assert.match(
  sourceFiles["content-comments.js"],
  /resolve-root-blocked-by-error-dialog[\s\S]*?return null;/,
  "content-comments.js: a rendered unavailable dialog must block every root fallback"
);
assert.match(
  sourceFiles["content-comments.js"],
  /function ensureCurrentSurfaceWatcher\([\s\S]*?hasCurrentSurfaceOwnership\(target, ownership\)[\s\S]*?activeExpansionWatchers\.delete\(target\)/,
  "content-comments.js: expansion watchers must stop when they lose route or surface ownership"
);
assert.match(
  sourceFiles["content-comments.js"],
  /function scheduleAllCommentsSelectionRetry\([\s\S]*?const ownership = captureSurfaceRouteOwnership\(\)[\s\S]*?!hasCurrentSurfaceOwnership\(surface, ownership\)/,
  "content-comments.js: sorter retries must remain bound to their original route and surface"
);
assert.match(
  sourceFiles["content-comments.js"],
  /exactOrderingMenus\.length === 1/,
  "content-comments.js: missing unique Comment Ordering popup recovery"
);
assert.match(
  sourceFiles["content-comments.js"],
  /new MutationObserver\(runGuardedRetry\)/,
  "content-comments.js: comment selection is not mutation-driven"
);
assert.doesNotMatch(
  sourceFiles["content-comments.js"],
  /selectionStartedAt/,
  "content-comments.js: elapsed time must not reset the bounded selection count"
);
assert.match(
  sourceFiles["content.js"],
  /const reelSurface = isReelExperiencePath\(\)[\s\S]*?getActiveReelCommentSurface\(document\)[\s\S]*?commentAutomationSuspended = false;[\s\S]*?debouncedRunAll\(reelSurface\);/,
  "content.js: Reel SPA navigation must resume comment automation when its sidebar resolves"
);
assert.match(
  sourceFiles["content-comments.js"],
  /match = path\.match\(\/\\\/reels\?\\\/\(\[\^\/\?#\]\+\)\/i\);[\s\S]*?return `reel:\$\{match\[1\]\}`;/,
  "content-comments.js: Reel routes must have a stable per-Reel identity"
);
assert.match(
  sourceFiles["content-comments.js"],
  /function getActiveReelCommentSurface\([\s\S]*?if \(!hasExactCurrentReelRouteLink\(surface\)\)[\s\S]*?return;/,
  "content-comments.js: the comment sidebar itself must identify the current Reel"
);
assert.match(
  sourceFiles["content-comments.js"],
  /function getActiveReelCommentSurface\([\s\S]*?const selectors = '\[role="complementary"\], div\[role="article"\], \[data-pagelet\]'[\s\S]*?surface\.matches\('main, \[role="main"\]'\)[\s\S]*?hasVisibleLargeReelMedia\(surface\)/,
  "content-comments.js: a broad Reel main or video container must never own comment automation"
);
assert.match(
  sourceFiles["content-comments.js"],
  /function isControlOwnedByCurrentCommentSurface\([\s\S]*?isReelCommentSurface\(activeDialog\)[\s\S]*?getOwningCommentArticle\(control\)[\s\S]*?hasExactCurrentRouteIdentityLink\(owningArticle\)/,
  "content-comments.js: Reel reply controls must belong to a current-route comment article"
);
assert.match(
  sourceFiles["content-comments.js"],
  /expander-skip-unowned-control/,
  "content-comments.js: unowned recycled Reel controls must fail closed before activation"
);
assert.doesNotMatch(
  sourceFiles["content-comments.js"],
  /addCandidate\(reelContext/,
  "content-comments.js: the broad Reel container must not proxy a stale sidebar"
);
assert.match(
  sourceFiles["content-comments.js"],
  /function isReelCommentSurface\(surface\)[\s\S]*?getActiveReelCommentSurface\(document\)/,
  "content-comments.js: a retained Reel sidebar must not validate itself as active"
);
assert.doesNotMatch(
  sourceFiles["content-comments.js"],
  /getActiveReelCommentSurface\((?:surface|scopeElement|root)\)/,
  "content-comments.js: Reel surface resolution must not be biased by mutation roots"
);
assert.doesNotMatch(
  sourceFiles["content.js"],
  /getActiveReelCommentSurface\(root\)/,
  "content.js: Reel automation must resolve ownership from the document"
);
assert.match(
  sourceFiles["content.js"],
  /previousReelId[\s\S]*?currentReelId[\s\S]*?previousReelId !== currentReelId[\s\S]*?phase: "close"/,
  "content.js: changing Reel IDs must arm stale-sidebar recovery"
);
assert.match(
  sourceFiles["content.js"],
  /function recoverStaleReelSidebar\([\s\S]*?refresh\.phase === "close"[\s\S]*?refresh\.phase = "reopen"[\s\S]*?refresh\.phase === "reopen"[\s\S]*?refresh\.phase = "wait-for-current"/,
  "content.js: stale Reel recovery must perform one bounded close/reopen cycle"
);
assert.match(
  sourceFiles["content.css"],
  /\[data-faceberg-hidden-feed-module\]\s*\{[^}]*display:\s*none\s*!important/s,
  "content.css: missing standalone-module layout suppression"
);
assert.doesNotMatch(
  sourceFiles["content.css"],
  /\[data-faceberg-suppressed-feed-unit\]/,
  "content.css: retired main-feed suppression must not change card geometry"
);
assert.match(
  sourceFiles["content.css"],
  /\[data-faceberg-hidden-sponsored-reel\]\s*\{[^}]*display:\s*none\s*!important/s,
  "content.css: missing Sponsored Reel layout suppression"
);
assert.match(
  sourceFiles["shared-stats.js"],
  /removedSponsoredReels/,
  "shared-stats.js: missing Sponsored Reel activity tracking"
);
assert.match(
  sourceFiles["manifest.json"],
  /"css"\s*:\s*\["content\.css"\]/,
  "manifest.json: content.css is not registered"
);
assert.strictEqual(
  JSON.parse(sourceFiles["manifest.json"].replace(/^\uFEFF/, "")).version,
  "1.2.32",
  "manifest.json: release version must be 1.2.32"
);
assert.match(
  sourceFiles["popup.html"],
  /id="whatsNewTitle">What's new<\/h3>[\s\S]*?id="aboutVersion"[\s\S]*?class="fb-release-history"/,
  "popup.html: About tab must expose the current release and expandable history"
);
assert.match(
  sourceFiles["popup.html"],
  /id="enableBlockSponsoredPosts" type="checkbox"(?! disabled)[\s\S]*?data-compatibility-disabled="true"[\s\S]*?Follow[\s\S]*?data-compatibility-disabled="true"[\s\S]*?Join/,
  "popup.html: Sponsored filtering must be enabled while Follow and Join stay compatibility-paused"
);
assert.match(
  sourceFiles["popup.js"],
  /data-compatibility-disabled[\s\S]*?input\.disabled = disabled/,
  "popup.js: dependent-toggle synchronization must preserve compatibility-disabled controls"
);
assert.match(
  sourceFiles["popup.js"],
  /aboutVersion\.textContent = versionText/,
  "popup.js: About changelog badge must use the manifest version"
);

console.log("Reels, Stories, and Sponsored Reels feature wiring: passed");
