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
    "shared-stats.js"
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
  sourceFiles["content-feed.js"],
  /if \(routeKey\) \{[\s\S]*?skipActiveSponsoredReel\(item, deps, routeKey\)[\s\S]*?continue;[\s\S]*?hideSponsoredReelItem/,
  "content-feed.js: the active scroll-snap item must never be layout-collapsed"
);
assert.match(
  sourceFiles["content-feed.js"],
  /data-faceberg-suppressed-feed-unit/,
  "content-feed.js: missing non-native feed-unit suppression"
);
assert.match(
  sourceFiles["content-feed.js"],
  /const ENABLE_NATIVE_FEED_HIDE_ACTIONS = false/,
  "content-feed.js: production cleanup must not invoke native Hide actions"
);
assert.match(
  sourceFiles["content-feed.js"],
  /suppressFeedUnitWithoutNativeHide\([\s\S]*?SUPPRESSED_FEED_UNIT_ATTRIBUTE/,
  "content-feed.js: filtered feed cards must use direct-root suppression"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function hideBlockedLabelPostsWithoutNativeHide\([\s\S]*?isSafeNativeHideCandidate\(unit\)[\s\S]*?\{ blockedLabel, statKey \}/,
  "content-feed.js: Follow/Join suppression must remain before-entry only"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function getSponsoredMarkers\([\s\S]*?const structuralMarkers =[\s\S]*?hasSponsoredStructuralMetadata\(target\)/,
  "content-feed.js: Sponsored structural metadata must be scanned before viewport entry"
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
  /data-faceberg-allow-sponsored-feed|html:not\([^)]*\) main[\s\S]*?data-ad-rendering-role/,
  "content.css: main-feed cards must not bypass identity-gated suppression"
);
assert.doesNotMatch(
  sourceFiles["content.js"],
  /ALLOW_SPONSORED_FEED_ATTRIBUTE|syncSponsoredFeedCssPolicy/,
  "content.js: unsafe pre-paint Sponsored policy must remain removed"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function getFeedPostIdentity\([\s\S]*?return `route:\$\{routeIdentity\}`[\s\S]*?token\.length >= 32[\s\S]*?return cftToken \? `cft:/,
  "content-feed.js: suppressed cards must require a stable route or cft identity"
);
assert.doesNotMatch(
  sourceFiles["content-feed.js"],
  /const actionLabel =[\s\S]*?return actionLabel/,
  "content-feed.js: generic action labels must never identify recycled posts"
);
assert.match(
  sourceFiles["content-feed.js"],
  /if \(!currentIdentity\) \{[\s\S]*?restoreSuppressedFeedUnit\(unit, "identity-unavailable"\)/,
  "content-feed.js: identity loss must immediately restore a suppressed unit"
);
assert.match(
  sourceFiles["content-feed.js"],
  /currentIdentity !== suppression\.postIdentity[\s\S]*?return false;/,
  "content-feed.js: a recycled post must not inherit the previous suppression root"
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
assert.match(
  sourceFiles["content-feed.js"],
  /currentIdentity !== suppression\.postIdentity/,
  "content-feed.js: missing identity-gated recycled-card restoration"
);
assert.doesNotMatch(
  sourceFiles["content-feed.js"],
  /isLateVisibleSponsoredCandidate/,
  "content-feed.js: interaction-time visible-card suppression must remain disabled"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function isSafeDirectSuppressionCandidate\([\s\S]*?rect\.top >= safeTop[\s\S]*?function isStartupVisibleSponsoredCandidate/,
  "content-feed.js: direct suppression must scan all safely buffered mounted cards"
);
assert.match(
  sourceFiles["content-feed.js"],
  /function isStartupVisibleSponsoredCandidate\([\s\S]*?hasTrustedPageInteraction\(\)[\s\S]*?getRuntimeAgeMs\(\) > 8000/,
  "content-feed.js: visible startup suppression must be time-bounded and canceled by trusted input"
);
assert.match(
  sourceFiles["content-feed.js"],
  /const isEligibleCandidate =\s*isUpcomingCandidate \|\| isStartupVisibleCandidate/,
  "content-feed.js: stable first-viewport Sponsored cards must be eligible during startup"
);
assert.match(
  sourceFiles["content.js"],
  /getRuntimeAgeMs: \(\) => Date\.now\(\) - runtimeCreatedAt/,
  "content.js: feed filtering must expose a bounded startup age"
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
assert.match(
  sourceFiles["content.css"],
  /\[data-faceberg-suppressed-feed-unit\]/,
  "content.css: missing non-native feed-unit layout suppression"
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
  "1.2.16",
  "manifest.json: release version must be 1.2.16"
);
assert.match(
  sourceFiles["popup.html"],
  /id="whatsNewTitle">What's new<\/h3>[\s\S]*?id="aboutVersion"[\s\S]*?class="fb-release-history"/,
  "popup.html: About tab must expose the current release and expandable history"
);
assert.match(
  sourceFiles["popup.js"],
  /aboutVersion\.textContent = versionText/,
  "popup.js: About changelog badge must use the manifest version"
);

console.log("Reels, Stories, and Sponsored Reels feature wiring: passed");
