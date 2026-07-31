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
  /runSponsoredReelFiltering/,
  "content-feed.js: missing Sponsored Reel filtering"
);
assert.match(
  sourceFiles["content-feed.js"],
  /data-faceberg-late-sponsored/,
  "content-feed.js: missing late-visible Sponsored suppression"
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
assert.match(
  sourceFiles["content.js"],
  /isRecentlyInteractedFeedUnit/,
  "content.js: missing the trusted-card interaction guard"
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
  sourceFiles["content.css"],
  /\[data-faceberg-hidden-feed-module\]\s*\{[^}]*display:\s*none\s*!important/s,
  "content.css: missing standalone-module layout suppression"
);
assert.match(
  sourceFiles["content.css"],
  /\[data-faceberg-late-sponsored\]/,
  "content.css: missing late-visible Sponsored layout suppression"
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

console.log("Reels, Stories, and Sponsored Reels feature wiring: passed");
