# Faceberg Architecture v2

## Lightweight compatibility mode

The current development build leaves React-owned Home-feed units and MAIN-world
browser methods untouched. It installs no global subtree observer. A lightweight
scroll-driven pass detects nearby Sponsored cards and activates their single
native `Hide post`/`Hide ad` control; Facebook performs the removal. A trusted
comment/post click schedules three bounded checks for a real dialog or supported
direct post/media route; once found, the existing surface-local comment watcher
handles that context.

## Goal

Faceberg is scoped to four stable behaviors:

1. Filter unwanted Facebook feed content without destabilizing Facebook's virtualized feed.
2. Expand truncated post bodies.
3. Keep supported Facebook feed and root-group feeds on the intended sort mode.
4. Expand visible comment and reply threads inside an already-open post context.

## Active Boundaries

### Feed Cleanup

- Runs against feed/main-content roots.
- Destructive main-feed cleanup runs in fail-open compatibility mode because live testing showed that hiding or removing React-owned feed units can desynchronize click routing, stall infinite loading, and make native video controls unresponsive.
- Reels and Stories are the narrow exception to the ordinary-card rule: each is
  a verified standalone module. Faceberg applies a reversible CSS marker to the
  exact module root, keeps the React-owned node connected, and removes the
  marker if the setting is disabled or React recycles that node.
- A Stories target must be the exact `Stories` region inside `main`, contain its
  labelled stories grid, and contain no ordinary post action menu.
- A Reels target must be the exact `Reels` region inside `main`, contain at
  least two `/reel/` links, have the exact Reels heading, and resolve to a
  wrapper with one module action menu and no ordinary post footer.
- Sponsored Reels in the full-screen viewer are handled independently from the
  Home-feed Reels module. A match requires an exact `Sponsored` marker inside
  the labelled video-player group, exactly one video in the full-screen item,
  multiple videos in its parent Reel list, viewport-sized item geometry, and
  at least one outbound ad link.
- Faceberg removes the exact Sponsored Reel item from the scroll-snap layout
  without disconnecting its React node. The same structural verification runs
  again when Facebook remounts or rehydrates Reel items, so backward navigation
  cannot restore a previously removed ad.
- Sponsored-Reel detection uses one Reel-route-scoped observer and reacts only
  to relevant DOM/text/link/video hydration. It uses no polling or timer.
- Main-feed Sponsored cards are hidden through the one visible native `Hide post`/`Hide ad` control inside the verified post boundary. Faceberg never removes, reparents, collapses, or makes the outer virtualized slot inert.
- During initial Home hydration only, a verified Sponsored unit already inside
  the viewport may enter the same native-hide transition before the first
  trusted page input. The transition collapses the direct inner root before the
  native click. After the first pointer, wheel, touch, or keyboard input, only
  upcoming units with a full viewport buffer qualify.
- Slow Chromium variants can reveal the Sponsored marker or native Hide control
  only after an already-visible card has passed the initial-input gate. That
  late-visible case never invokes Facebook's native Hide replacement. Faceberg
  collapses only the verified direct inner root, keeps the outer
  `[data-virtualized]`/`[aria-posinset]` unit connected, and uses a unit-scoped
  observer to restore the root before paint if React recycles it for ordinary
  content. A card that received recent trusted input remains fail-open.
- The experimental compact-feedback setting may mark only the direct inner root of a confirmed `Ad hidden`/`Post hidden` payload. Confirmation requires one exact feedback heading, one exact `Undo` control, no post action menu or post footer, and one outer `[data-virtualized]`/`[aria-posinset]` boundary. A unit-scoped observer removes the mark before paint if React recycles the root for ordinary content.
- Mutation and scroll events coalesce Sponsored detection into the next
  rendering frame. A unit already undergoing Facebook's native hide transition
  is not activated twice, and the activity counter changes only after Facebook
  confirms the removal structurally.
- The exact `CometHomeRightSideEgo.react` renderer and
  `useSideAdsRefreshHandler` hook are replaced at document start while feed
  filtering is enabled. This prevents the independently rendered sidebar ad
  block and its visibility-return `CometHomeRightSideEgoRefetchQuery`.
- Resolves the right-column Sponsored module from its heading, sponsored-content menu controls, outbound links, and media instead of depending on one generic button label.
- Detects feed Sponsored labels even when Facebook splits, reorders, and pads the visible word with decoy DOM glyphs; rendered-label decoding is bounded to Facebook's compact `__cft__` metadata links.
- Hides a Sponsored feed unit only after its action menu and footer controls establish the complete post boundary and exactly one native hide control is available.
- Re-removes an already-counted filtered module if React reconnects the same DOM node.
- Resolves sidebar and recommendation modules from the smallest ancestor that satisfies their full signal set.
- Refuses every removal target that contains the main region, composer, or Feed posts heading.
- Non-post modules cannot remove any target containing a post action menu; Sponsored and Follow/Join detection require one complete card and refuse multi-post targets.
- Follow/Join post filtering uses the card's unique native `Hide post by …`
  control and verifies that Facebook removed or replaced the CTA before counting
  it. The optional compact-feedback contract may visually collapse the confirmed
  inner replacement while leaving Facebook's outer virtualized unit connected.
- Does not open posts, dialogs, or menus.
- Native hiding cannot prevent a main-feed Sponsored card's initial shared
  GraphQL payload or media request. The initial
  `CometRightSideHeaderCardsQuery` is also shared with useful non-ad right-rail
  cards, so Faceberg leaves that request intact while preventing the separate
  ad renderer and later ad-only refetch. Selective blocking of shared feed
  transport is not claimed.

### Post Expansion

- Clicks visible `See more`-style controls for truncated posts.
- Operates on the current visible root only.
- Does not attempt menu interaction.
- Waits for saved settings and initial DOM readiness before acting, then reacts
  to story-body mutations without delayed follow-up passes.
- Treats first-feed story-preview hydration as a timing problem first: a valid `See more` button may exist before Facebook finishes wiring its live handler.
- Allows bounded retries for the same visible expander during startup stabilization instead of permanently suppressing the first no-op press.
- On Home, runs independently from destructive feed cleanup and scans only exact
  visible story-body buttons after startup, scrolling, or resizing.
- Refuses links, navigation/sidebar controls, menus, toolbars, hidden dialogs,
  and off-screen virtualized controls.
- See [post-expansion-notes.md](post-expansion-notes.md) for the first-post startup failure mode and the regression rules that protect it.

### Comment Expansion

- Runs only on:
  - direct post/permalink pages, or
  - already-open post dialogs.
- Also supports direct media surfaces such as Facebook photo/watch pages when the
  comment UI lives outside a modal dialog.
- Reels are handled only through a separate active-reel resolver that must identify
  one visible reel comment surface without falling back into older dialogs or broad
  document scans.
- Resolves one active comment surface at a time and never shares execution between feed dialogs, direct posts, media surfaces, and reel surfaces.
- Canonicalizes nested Facebook dialog shells to the deepest visible modal so one post cannot receive two competing controllers.
- On already-open post dialogs, opens the Facebook comment-ordering popup for the active post only.
- On direct post and supported media surfaces, resolves the current sorter inside that surface only.
- Uses anchored popup matching and a targeted MutationObserver to react when a
  spinner-loaded sorter menu becomes ready, without polling or reopening
  unrelated UI.
- A unique visible exact `Comment Ordering` menu may bypass the geometric
  proximity check. This recovers slow-browser popup placement differences
  without permitting generic or ambiguous page menus.
- Reveals an off-screen sorter inside its existing scroll container before clicking and restores the prior scroll position after the sorter settles.
- Selects `All comments` before expanding visible comment/reply controls.
- Runs sorter verification directly from mutation delivery, and counts at most
  two row activations for one opening regardless of elapsed time or delayed
  rendering frames.
- Treats exact `View all N replies` and answer-labelled variants as reply-summary expanders so fallback matching can recover when Facebook changes wrapper markup.
- Expands visible comment/reply controls such as summary and load-more actions.
- Leaves both the sorter and reply controls untouched when comment expansion is disabled.
- Does not interact with unrelated menus or other posts.

### Media Viewer Handling

- Media viewers are split into two cases:
  - media dialogs with inline comment UI
  - direct media pages where comments live in `role="complementary"`, `main`, `role="main"`, `data-pagelet`, or `div[role="article"]`
- A media viewer without visible comment UI must not trigger fallback to an older post dialog underneath it.
- Mutation-driven reruns should prefer a newly added dialog root over a broad document rescan.
- Follow-up comment-automation passes must resolve from the current document state, not from a stale previously viewed dialog.

### Observer and Startup Handling

- The runtime does not mutate Facebook's document before saved settings and the initial DOM are ready.
- Mutation reruns start from the smallest connected added subtree that covers the change.
- Feed mutations are normalized to their nearest virtualized post card and batched as separate local roots; mutations in chat, contacts, or navigation no longer fall back to a whole-feed scan.
- Text-node hydration participates in the same local mutation batching because Facebook may finalize obfuscated labels after their element wrappers exist.
- Newly added dialogs are canonicalized to the deepest visible modal before automation.
- SPA URL changes are handled by navigation, history, and DOM events; there is
  no periodic heartbeat.
- Scroll and resize work is coalesced into the next rendering frame; it does
  not rerun comment or dialog automation.
- A trusted post/comment pointer-down cancels already queued Home-feed work.
  Feed automation resumes from an actual route/dialog/inline-comment mutation,
  never from elapsed time.
- Dedicated observers watch the current Home feed and right sidebar. Added
  nodes plus Sponsored-label text and ARIA hydration trigger local filtering
  in the same observer turn; root-locator observers reconnect when Facebook
  replaces either container or a higher-confidence feed root replaces a
  provisional startup `main`.
- A hidden-to-visible transition does not suppress native visibility or focus
  events. It reconnects the scoped observers and runs one scoped Sponsored
  scan in the visibility event turn; it does not start a delayed feed pass or
  quiet-window timer.
- Comment and feed watchers remain attached only to their live scoped surfaces;
  composer-only mutations do not trigger comment automation reruns.

### Anti-Refresh Compatibility

- Anti-refresh is optional and off by default.
- When Anti-refresh is enabled, the background worker registers
  `stale-feed-guard.js` in the MAIN world at `document_start`. It wraps
  Facebook's module-definition function before Home modules are evaluated.
- The overload is an exact-name allowlist:
  - `useCometHomeStaleFeedRefresh`
  - `useCometFeedPushViewCloseRefresh`
  - `useInvalidateCometNewsFeedConnectionOnMaintainedRouteUnmount`
  - `useCometNewsFeedRefreshThrottler`
  - `useRefreshCometStoriesTrayOnMaintainedRouteUnmount`
- These are the observed production modules that refresh Home after
  inactivity/backgrounding, refresh or rebuild Home after a pushed post
  closes, refresh Stories during a maintained-route transition, and invalidate
  the maintained Home Relay connection. Their replacement hooks preserve the
  return contract expected by `CometHomeContent.react`.
- `useCometNewsFeedRefreshThrottler`, `CometOnRefresh`, the normal Home query,
  feed pagination, and explicit user refresh paths are not modified.
- The hidden `visibilitychange` transition is observed and allowed through normally.
- Visibility and focus events always remain native; guard v13 does not stop
  propagation or spoof visibility state.
- During the return guard state, a cancellable Navigation API event is rejected
  only when it is a non-user reload or automatic Home-route reset.
- Recent trusted user input bypasses the guard so normal navigation remains intact.
- Content code stores a short-lived per-tab scroll snapshot and makes one
  next-frame restoration attempt after an unexpected same-URL reload. It never
  runs a delayed restoration ladder.
- Anti-refresh does not replace timers, event registration, Location, focus
  checks, visibility properties, media functions, or DOM structures, and it
  installs no DOM observer. Guard v13 also leaves `fetch` and XMLHttpRequest
  completely native. Its temporary Facebook module-loader accessor becomes a
  direct function property after all exact target factories are intercepted.

### URL Normalization

- Redirects the optional feed landing page to:
  - `https://www.facebook.com/?filter=all&sk=h_chr&sorting_setting=CHRONOLOGICAL`
- On root group feeds such as `/groups/<id>` or `/groups/<id>/`, resolves the in-page group feed sorter and applies the configured default sort instead of rewriting the URL.
- Group-sort activation uses one native control action and verifies it only
  when the rendered sort menu or label actually changes.
- Uses in-place URL normalization for SPA navigation instead of forcing a full reload.

## Explicit Non-Goals

- No automation of comment filter popups outside the active post dialog.
- No React-internal event bridging for menu item selection.
- No feed-to-modal auto-opening behavior.
- No recovery heuristics based on random outside clicks.
- No feed-wide fallback from `document` into arbitrary post/comment surfaces.
- No fallback from a topmost media viewer into older dialogs underneath it.
- No generic direct comment automation on Reels tab or `/reel/` surfaces.
- No reel fallback from `document` into arbitrary page surfaces when the active reel root is ambiguous.

## Design Principle

Prefer stable DOM transformations and narrowly scoped UI workflows over broad transient popup automation.

If a behavior requires broad popup steering, React internals, or synthetic recovery clicks outside the active dialog, it is outside the default Faceberg automation boundary and should remain disabled unless reintroduced as a clearly isolated experimental feature.

## Regression Triggers To Avoid

- Treating the first visible dialog as the active post by default.
- Allowing `document`-level comment automation to search the feed for any plausible surface.
- Letting watcher callbacks rerun against the stale dialog that originally created the watcher.
- Counting a filter-toggle click as success without verifying that the popup actually opened.
- Treating a CSS-visible but off-screen sorter as actionable without first revealing it.
- Letting nested dialog shells create separate automation state for the same modal.
- Letting a sorter popup watcher keep tracking a stale popup after Facebook replaces the menu node during hydration.
- Reopening old post dialogs when a photo/media viewer appears without comments yet.
- Resolving a reel comment surface unless one active reel root clearly outranks all other visible candidates.
- Permanently blacklisting a first-post `See more` button after one early synthetic click during startup hydration.
- Assuming top-of-feed expansion failures are always selector problems; the first visible post can fail because Facebook attaches the live handler after the initial pass.
- Blocking Facebook's shared `/api/graphql/` endpoint or broad CDN media classes to save bandwidth; those requests also carry content the user chose to keep.

See [regression-checklist.md](regression-checklist.md) for the expected validation steps after any automation changes.
