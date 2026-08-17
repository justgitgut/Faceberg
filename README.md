<p align="center">
	<img src="icons/logo.png" alt="Faceberg logo" width="420" />
</p>

# Faceberg

Chrome extension that declutters your Facebook feed, auto-expands posts and visible comment threads, keeps the main feed and supported group feeds sorted predictably, and offers optional anti-refresh protection.

- Current development build uses a lightweight compatibility runtime: it leaves
  Facebook-owned Home-feed DOM and normal lifecycle events intact, wakes bounded
  comment automation only after a trusted comment/post click or on a supported
  direct post/media route, and disables only Facebook's named automatic
  stale-Home, pushed-post-close, maintained-route feed cleanup, and independent
  right-column Sponsored renderer/refetch modules.
- Prevents the independent Sponsored sidebar component from rendering or
  running its visibility-return refetch hook. Verified main-feed Sponsored,
  Follow, and Join cards are suppressed only after a stable permalink or
  Facebook context identity is available. Sponsored detection scans all mounted
  cards below the viewport safety buffer; a stable first-viewport ad may be
  suppressed only during a bounded startup window before any trusted input.
  The outer virtualized unit remains connected, and suppression is removed as
  soon as Facebook drops or changes that identity while recycling the unit.
  Faceberg does not use native Hide, visible placeholders, pre-paint card CSS,
  or scroll compensation.
- Auto-expands truncated posts and visible comment/reply threads.
- Switches the active post dialog, direct post page, or supported media comment
  surface to `All comments` before expanding visible comment threads.
- Binds Reel comment automation to the exact current `/reel/<id>` context so a
  recycled sidebar from a previously viewed Reel cannot retain ownership.
- Optionally disables Facebook's internal stale-feed reset hooks, blocks
  automatic same-page or route-reset navigation attempts during tab resume,
  and restores a recent scroll position after an unexpected reload.
- Optionally lands you directly on the All Feed view with chronological sorting when opening Facebook.
- Adds a popup action to copy extension debug information for troubleshooting.
- Shows the current release notes and an expandable recent changelog in the
  popup's About tab.

## Install (Developer Mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (`Faceberg`).

## Publish Prep

- Privacy policy draft: [PRIVACY.md](PRIVACY.md)
- GitHub Pages privacy page: [docs/privacy/index.html](docs/privacy/index.html)
- Chrome Web Store prep notes: [CHROME-STORE.md](CHROME-STORE.md)
- Store listing copy: [STORE-LISTING.md](STORE-LISTING.md)
- Privacy questionnaire guide: [PRIVACY-QUESTIONNAIRE.md](PRIVACY-QUESTIONNAIRE.md)
- Packaging script: [build-release.ps1](build-release.ps1)

## Settings

1. Click the extension icon in Chrome.
2. Open **Faceberg** popup settings.
3. Review live stats in the popup header:
   - Use the Activity tab to switch between `This Session` and `All Time`
   - Review grouped counters for Feed Cleanup and Automated Actions
   - Review estimated time saved and the current tracking start date
   - Reset all accumulated stats with the `Reset` button in the Activity header
4. Toggle features:
	- Enable anti-refresh protection
	- Enable feed cleanup
	- Hide Sponsored feed posts
	- Hide the right-column Sponsored module
	- Remove Sponsored Reels from the full-screen Reels feed using early ad CTA
	  evidence while keeping native Reel navigation synchronized
	- Hide Reels modules
	- Hide the Stories tray
	- Hide People You May Know
	- Hide Follow posts
	- Hide Join posts
	- Auto-expand long posts
	- Switch supported discussions to All comments
	- Auto-expand replies and truncated comment text
	- Choose the default root group feed sort
5. Click **Apply** to save and refresh Facebook tabs.
6. If **Go directly to feeds on activation** is enabled, Apply will open Facebook tabs on:
	- `https://www.facebook.com/?filter=all&sk=h_chr&sorting_setting=CHRONOLOGICAL`

When you open a root group page such as `https://www.facebook.com/groups/<group-id>` or `https://www.facebook.com/groups/<group-id>/`, Faceberg looks for the in-page group feed sorter and switches it to the configured default sort (`Recent activity`, `New posts`, or `Most relevant`). This works on direct loads and SPA navigation back to the root group feed.

Anti-refresh protection is on by default. You can turn it off independently if
you prefer Facebook's native resume behavior.

The extension auto-refreshes open Facebook tabs on install/update so filters apply immediately.

## Notes

- This works on `www.facebook.com` and `web.facebook.com`.
- Facebook changes DOM markup frequently; selectors may need occasional updates.
- Auto-click behavior is scoped to visible post/dialog contexts. You can tune the matching patterns in `content.js`.
- The extension stores settings and aggregate counters locally and does not send Facebook data to external servers.
- Session counters reset once per browser startup or extension restart; they do not reset on ordinary Facebook page loads.
- The Activity tab includes `Copy Debug Information`, which copies extension version, active Facebook tab info, saved settings, activity stats, and page-debug extraction hints to the clipboard.
- The About tab includes the current release notes and a compact history of
  recent releases.

## How It Works

- `stale-feed-guard.js`: while Anti-refresh is enabled, overloads exactly
  `useCometHomeStaleFeedRefresh`, `useCometFeedPushViewCloseRefresh`, and
  `useInvalidateCometNewsFeedConnectionOnMaintainedRouteUnmount`, plus the
  Home-only router refresh handler `useCometNewsFeedRefreshThrottler` and
  `useRefreshCometStoriesTrayOnMaintainedRouteUnmount`, at Facebook
  module-definition time. Manual browser refresh, the feed refresh pill,
  pagination, media, and routing modules remain native.
- `injected.js`: installs a document-start, setting-controlled return guard. It
  observes hidden/visible transitions without suppressing visibility or focus,
  rejects only cancellable automatic reloads and non-user Home-route resets
  during the return window, and leaves `fetch` and XMLHttpRequest untouched.
- `content.js`: uses scoped DOM/navigation observers to react to feed, sidebar,
  Reel-viewer, dialog, sorter, and reply changes. Sponsored feed mutations are
  processed card-locally in the observer turn so a busy Chromium main thread
  cannot starve cleanup. Exact standalone Reels and Stories module roots are
  hidden with a reversible marker while their React-owned nodes remain
  connected; other work is coalesced into the next rendering frame.
- `popup.html` + `popup.js`: UI and storage-backed settings for feature toggles, grouped activity stats, period switching, saved-time estimates, debug-information export, and the in-extension changelog.
- `manifest.json`: MV3 config and script registration.

## Automation Boundary

- Main-feed cleanup leaves React-owned outer feed units intact so Facebook
  retains native scrolling, loading, click routing, and media controls.
  Sponsored, Follow, and Join cards use a verified inner-root-only suppression
  boundary without invoking native Hide and are restored before paint if React
  recycles the unit for ordinary content. Experimental feedback compaction is
  limited to already-rendered native hidden-feedback payloads.
- Reels and Stories are treated as standalone modules rather than ordinary post
  cards. Faceberg hides only roots that pass exact structural checks, keeps
  those roots connected to React, and removes the marker immediately when the
  setting is disabled or Facebook recycles the node.
- Sponsored Reels use a separate full-screen viewer boundary. Faceberg accepts
  a compact `Ad`/`Sponsored` badge or a known ad CTA such as `Play game`, but
  only with Facebook's external redirect or a genuinely non-Facebook
  destination. It still requires one item video, multiple sibling Reel videos,
  and viewport-sized geometry. Active ads advance through Facebook's native
  Next control so the URL and comments remain synchronized; preloaded off-screen
  ads can be suppressed before entry.
- Post expansion clicks visible `See more`-style controls.
- Comment automation remains scoped to the current post context.
- In already-open post dialogs, direct post pages, and supported media comment
  surfaces, the extension resolves the active sorter, selects `All comments`,
  and then expands visible comment/reply controls. Popup replacement and
  selection verification are mutation-driven and remain bounded even when a
  browser delays rendering frames.
- Sidebar cleanup and post expansion do not open random posts or unrelated menus.

See [docs/architecture-v2.md](docs/architecture-v2.md) for the current architecture boundary.
See [docs/regression-checklist.md](docs/regression-checklist.md) for the recommended validation checklist after automation changes.

## Permissions

- `storage`: saves settings and local activity counters.
- `tabs`: refreshes or redirects open Facebook tabs after settings changes and applies tab-specific behavior.
- Host permissions are limited to Facebook web domains.
