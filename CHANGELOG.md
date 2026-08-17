# Changelog

## 2026-08-16 - v1.2.16

### Fixed

- Restored Chrome main-feed ad coverage without weakening the v1.2.15 recycled
  post safeguards. Faceberg now scans every mounted, identity-verified
  Sponsored card below the viewport safety buffer instead of waiting for a
  narrow two-viewport window.
- A stable Sponsored card already in the first viewport may be suppressed only
  during the first eight seconds and before any trusted page interaction. This
  covers first-load ads without reintroducing interaction-time feed jumps.
- Validated the missed Chrome card against its live compact `Ad` marker, long
  `__cft__` identity, ad-only rendering roles, and external CTA bundle.

## 2026-08-16 - v1.2.15

### Fixed

- Main-feed suppression now requires a stable post permalink identity or a
  sufficiently specific Facebook context token. The generic `Actions for this
  post` label is no longer treated as an identity shared across recycled cards.
- A suppressed card is restored immediately if its marker or identity
  disappears or changes while Facebook recycles the virtualized feed unit.
- Removed the structural pre-paint CSS shortcut, which could collapse a
  React-owned card before Faceberg proved that the current card was still the
  Sponsored post. This closes the intermittent wrong-post or unavailable-post
  route seen during slower Vivaldi feed hydration.

## 2026-08-13 - v1.2.14

### Fixed

- Added Facebook's compact `Ad` badge and `Play game` CTA to Sponsored Reel
  detection after validating both signals against a live missed ad.
- Tightened Reel ad destinations so internal Facebook profile links no longer
  satisfy the outbound-link requirement. A qualifying destination must use
  Facebook's external redirect or a genuinely non-Facebook hostname.

## 2026-08-13 - v1.2.13

### Fixed

- Sponsored Reels no longer wait for Facebook's delayed visible `Sponsored`
  label. Faceberg now recognizes the earlier ad CTA plus its explicit external
  destination while retaining the full-screen Reel geometry checks.
- An active Sponsored Reel now advances through Facebook's native `Next Card`
  control instead of being removed from the scroll-snap layout. This keeps the
  URL, visible Reel, and comment sidebar on the same item. Preloaded off-screen
  ad items can still be suppressed before entry.

## 2026-08-13 - v1.2.12

### Fixed

- Removed the v1.2.11 height-preserving Sponsored mask because it could leave
  full-card blank gaps in the feed.
- Main-feed filtering now uses Facebook's ad-only structural rendering bundle
  to suppress verified Sponsored cards during style calculation, before they
  participate in a painted feed layout. The JavaScript fallback scans the
  mounted feed but collapses cards only while safely below the viewport; it no
  longer masks visible cards, reserves their height, or compensates scrolling.

## 2026-08-13 - v1.2.11

### Fixed

- Attempted to restore late Vivaldi filtering with a height-preserving mask.
  Superseded by v1.2.12 because the mask left unacceptable full-card gaps.

## 2026-08-13 - v1.2.10

### Fixed

- Stopped feed cleanup from collapsing Sponsored, Follow, or Join cards while
  they are visible or already above the viewport. Those layout changes could
  make Facebook's virtualized feed repeatedly jump backward when scrolling up.
- Main-feed suppression now acts only on verified cards safely below the
  viewport. A card detected too late remains visible instead of changing feed
  height underneath the user's active scroll.

## 2026-08-11 - v1.2.9

### Fixed

- Stopped the first Reel's comment sidebar from retaining automation ownership
  after moving to another Reel. Reel resolution now ignores mutation-local
  roots, binds `/reel/<id>` pages to the exact current permalink, and waits
  until the matching Reel context mounts before sorting or expanding comments.
- Added a bounded recovery for Facebook's own recycled sidebar: when a new Reel
  URL appears but the mounted comment timestamps still belong to the previous
  Reel, Faceberg toggles the current Reel's Comment control closed and open once
  to request the correct discussion.
- Improved `/reels` browsing without a route ID by preferring the visible Reel
  nearest the viewport center instead of a previously populated comment panel.

## 2026-08-11 - v1.2.8

### Fixed

- Stopped retained or recycled comment-dialog observers from acting on an old
  post after a newer post begins opening. Comment automation now suspends at
  pointer-down, rejects hidden, inert, zero-area, non-topmost, and route-stale
  surfaces, and tears down watchers that no longer own the active discussion.
- Removed production use of Facebook's native **Hide post/Hide ad** transition
  for main-feed Sponsored, Follow, and Join cards. That transition could recycle
  a card's permalink handler onto a neighbor, producing the intermittent wrong
  post or unavailable-post dialog. Faceberg now suppresses only the verified
  direct inner root, keeps the virtualized unit connected, and restores it when
  Facebook recycles the unit for a different post.

## 2026-08-04 - v1.2.7

### Fixed

- Restored anti-refresh protection as the default when the user has not saved
  an explicit preference. The popup, content runtime, and background worker had
  all regressed to `enableAntiRefresh: false`, leaving guard v13 installed but
  disabled, automatic navigation unsuppressed, and Facebook tabs discardable.
- Kept explicit saved choices authoritative: users who deliberately turn
  anti-refresh off remain opted out, while fresh or unset installations are
  protected consistently across every settings consumer.

## 2026-08-04 - v1.2.6

### Added

- Added an in-extension changelog to the **About** tab. The current release is
  shown first and earlier release summaries remain available in an expandable
  history.

### Fixed

- Resumed Reel comment automation after `/reel/<id>` SPA navigation. The
  transition guard previously stayed suspended after the non-dialog Reel
  sidebar appeared, preventing both `All comments` selection and visible reply
  or comment-text expansion.
- Restored the **Hide People You May Know** option. The previous physical DOM
  removal path had been disabled for Facebook React safety, leaving the popup
  toggle wired but ineffective. Faceberg now uses the same reversible,
  non-destructive module marker as Reels and Stories and restores the module
  immediately when the option is disabled.
- Corrected sync/local settings fallback in the popup, page runtime, and
  background worker. A missing key from one browser storage area can no longer
  supply a default that overwrites the user's real value from the other area.

## 2026-07-30 - v1.2.5

### Changed

- Updated the extension and Chrome Web Store title to
  **Faceberg – Block Facebook Auto-Refresh & Clean Feed**, and revised the
  store summary to lead with complete automatic feed-refresh blocking.

### Fixed

- Repaired slow-browser comment sorting when Facebook replaces the
  `Comment Ordering` popup during hydration. The watcher now re-resolves the
  live popup, accepts one unique exact-labelled ordering menu, and performs
  verification directly from mutation delivery instead of waiting for an
  animation frame.
- Made the two-attempt `All comments` limit truly bounded. Long Vivaldi main
  thread stalls can no longer reset the attempt counter and repeatedly reopen
  or blink the sorter popup.
- Added a safe late-hydration path for main-feed Sponsored cards. When a
  verified card becomes visible only after trusted interaction, Faceberg
  collapses its direct inner root without invoking Facebook's native Hide
  replacement, while leaving the outer virtualized unit connected and
  restoring it immediately if React recycles the unit for ordinary content.
- Repaired current Facebook main-feed Sponsored detection when the visible
  label is split by U+034F combining joiners and its clean accessible name is
  supplied through a descendant `aria-labelledby` reference outside the link.
  Full-card validation and the unique native Hide-control requirement remain
  unchanged.
- Stopped late-hydrating Sponsored cards from blinking in slow Chromium builds.
  Faceberg now retains suppression through transient label-only React remounts
  using the card's rendering metadata and restores a virtualized slot only when
  it exposes a different verified post identity.

## 2026-07-29 - v1.2.4

### Added

- Added independent popup settings for main-feed Sponsored posts and the
  right-column Sponsored module. Disabling the sidebar option also prevents
  Faceberg from registering the corresponding Facebook module guard and stops
  its scoped sidebar observers.
- Split automatic `All comments` selection from reply/comment-text expansion
  so either comment behavior can now be enabled independently.
- Added an independent Stories tray setting.
- Added an independent **Remove Sponsored Reels** setting and activity counter
  for the full-screen Reels viewer.

### Fixed

- Repaired the Reels setting, which was bypassed by Home-feed compatibility
  mode. Reels and Stories now use exact standalone-module detection and a
  reversible layout marker, keeping Facebook's React nodes connected while
  removing the modules from view without timers or delayed scans.
- Added Reel-route-scoped Sponsored detection. Faceberg removes a verified
  Sponsored Reel from the scroll-snap layout without disconnecting its React
  node, reapplies removal after Facebook remounts the Reel stack, and refuses
  ambiguous items or ordinary caption/comment text.

### Improved

- Updated the popup copy so every active cleanup and comment behavior is named
  explicitly, and restored keyboard focus visibility for its custom switches.

## 2026-07-28 - v1.2.3

### Fixed

- Disabled Facebook's separate router-key Home refresh path. Live bundle and
  network tracing showed that closing a pushed post can rebuild the feed from
  cached Relay state through `useCometNewsFeedRefreshThrottler`, producing a
  blank frame and different posts/Reels without a document reload or a new
  GraphQL request. The route-unmount Stories refresh hook is also disabled,
  while manual browser reload, pagination, and the feed refresh pill remain
  native.
- Fixed slow Chromium/Vivaldi startup cleanup when Facebook keeps the main
  thread saturated. The first Home feed root is filtered in the same
  DOMContentLoaded/MutationObserver turn instead of waiting for a second
  animation frame, and a provisional `main` root is replaced as soon as the
  higher-confidence feed root appears.
- Removed guard-v12's diagnostic `fetch` and XMLHttpRequest wrappers. Guard v13
  leaves both transports completely native; the exact named-module overload is
  now the only interception used to disable Facebook's stale-feed refresh and
  right-column Sponsored module. Once all target factories are captured, the
  temporary `__d` accessor is released to a direct function property.
- Disabled Facebook's same-document stale-feed reset at its source. A live
  production-bundle trace identified `useCometHomeStaleFeedRefresh`,
  `useCometFeedPushViewCloseRefresh`, and
  `useInvalidateCometNewsFeedConnectionOnMaintainedRouteUnmount` as the paths
  that refetch Home after inactivity, refetch after closing a pushed post, or
  invalidate the maintained Home Relay connection.
- Added an Anti-refresh-only MAIN-world module interceptor registered at
  `document_start`. It overloads only the exact Home refresh module factories
  while preserving the `blockStaleFeedRefresh().dispose()` and refresh-handler
  contracts. Manual browser refresh, the feed refresh pill, feed pagination,
  routing, visibility/focus, media playback, and network dispatch are not
  blocked, delayed, or rewritten. Debug export now reports intercepted,
  disabled, and late-patched module names.
- Disabled the independently rendered right-column Sponsored block at its
  module boundary. `CometHomeRightSideEgo.react` now renders nothing and
  `useSideAdsRefreshHandler` no longer issues
  `CometHomeRightSideEgoRefetchQuery` when the tab becomes visible. The initial
  shared right-column query remains native because it also carries useful
  non-ad cards.
- Guard-v12 diagnostics established that prior tab-return failures were
  same-document feed resets rather than browser reloads. Those temporary
  transport diagnostics have now been removed in guard v13 because the exact
  refresh modules are disabled directly.
- Prevented native Sponsored/Follow/Join hiding from replacing a visible feed
  card. Live failure geometry showed Facebook recycling the removed card's
  permalink handler onto the next card, producing an unavailable-post route.
  Native replacement and hidden-feedback compaction now run only on upcoming
  cards at least one full viewport below the user, and any trusted feed-card
  pointer-down cancels the pending cleanup frame—including query-only Facebook
  permalink controls.
- Fixed the first-screen exception to that safety rule: a verified Sponsored
  card already visible during initial Home hydration is now collapsed and
  passed to Facebook's native hide control before the first trusted user input.
  After any pointer, wheel, touch, or keyboard input, Faceberg returns to the
  stricter upcoming-card-only rule.
- Prevented comment automation from acting during post-dialog teardown. Both
  Facebook close controls now suspend sorter, menu-retry, and reply-expansion
  work at pointer-down; automation resumes only after the exact closing modal
  disconnects or a new permalink resolves to its matching post surface.
- Fixed comment automation after Facebook SPA permalink transitions. Allowed
  `pushState`/`replaceState` calls now emit an immediate isolated-world wake,
  and the background tab URL event provides an independent wake. Because
  Facebook commits the permalink while the previous dialog is still mounted,
  Faceberg now keeps that exact destination armed until a route-matching dialog
  arrives instead of stopping after correctly rejecting the stale dialog. The
  fallback never scans mutation records or feed nodes outside that transition.
- Removed every timer-based automation path from the extension. Main-feed and
  sidebar Sponsored detection, post expansion, comment sorting, reply
  expansion, scroll snapshots, group sorting, dialog close handling, SPA URL
  changes, popup status, and observer lifecycle now react to DOM/browser events
  and coalesce work into the next rendering frame. Sponsored-label text/ARIA
  hydration is observed directly, so there is no delayed fallback scan,
  periodic heartbeat, or tab-return quiet-window expiry that can hide a card
  seconds later.
- Fixed residual `View N replies` controls by activating the exact Facebook
  button with one native DOM click. This replaces the synthetic pointer/mouse
  sequence that Facebook could ignore on permalink dialogs and prevents
  duplicate event dispatch.
- Fixed permalink comment sorting when Facebook keeps a zero-size hidden copy
  of the sorter in the active dialog. Sorter, popup, and popup-row resolution
  now reject hidden, inert, `aria-hidden`, and zero-area candidates instead of
  opening and closing the dormant control repeatedly.
- Upgraded anti-refresh protection to guard v11 after live evidence showed the
  document did not reload: the delayed tab-return resume pass hid a Sponsored
  card fifteen seconds after visibility returned, re-anchoring the feed, while
  visibility/focus suppression still failed to stop the soft reset and could
  leave Reels paused. Return transitions now schedule no main-feed mutation and
  lifecycle events remain untouched; only cancellable reload/Home-reset
  navigation is guarded.

- Made comment sorting reliable in scrollable post dialogs by revealing off-screen sorter controls before activating them, detecting the actual popup instead of trusting `aria-expanded`, and restoring the dialog scroll position after selection.
- Made comment-sort selection a verified, bounded transition: Faceberg resolves the exact `role="menuitem"` row for `All comments`, asks its existing MAIN-world runtime to invoke only that row's own React press handler, retries that same exact action at most once when Facebook ignores it, and closes any remaining popup immediately after confirmation or failure.
- Canonicalized nested Facebook dialogs to one deepest visible modal so the same comment surface cannot acquire competing automation controllers.
- Counted a comment-filter change only after the sorter itself confirms `All comments`.
- Added `answer` and `answers` to reply-summary detection for Facebook UI variants such as `View more answers`.
- Made the comment-expansion toggle govern both sorting and expansion; disabling it now leaves the comment sorter untouched.
- Removed document-start debug attributes and delayed automation until saved settings and initial DOM hydration are ready.
- Replaced broad anti-refresh interference with a narrow resume-window navigation guard and a recent scroll-position restore fallback.
- Completed partially restored feed positions after reload while yielding immediately when the user starts scrolling.
- Repaired Sponsored cleanup for both the right-column module and feed posts whose visible label is split and reordered across decoy DOM nodes.
- Prevented Home-only sidebar and recommendation cleanup from climbing into Facebook's main or multi-post feed wrappers.
- Replaced unsafe Sponsored feed-card suppression after live testing showed that DOM/CSS mutations on Facebook's React-owned virtualized items could misroute adjacent comment clicks or stall feed loading. Faceberg now activates the card's single native `Hide post`/`Hide ad` control and lets Facebook remove the item itself.
- Rolled back physical removal of Facebook's `Ad hidden` / `Post hidden` feedback payload after live testing reproduced a permalink misroute and unavailable-page fallback. Native hiding remains enabled, but all React-owned feed replacement DOM stays intact.
- Prevented native Sponsored/Follow/Join hiding and post-body expansion from racing a post-navigation click: a trusted post/comment pointer-down now cancels pending feed work, feed filtering stays paused while a modal or non-Home route is active, and native hide actions never alter already-passed cards above the viewport.
- Resumed Sponsored filtering and `See more` expansion automatically after the post-navigation quiet window, restored native hiding for visible/upcoming Sponsored cards without reintroducing click-triggered cleanup, and added a lightweight observer scoped only to Facebook's right sidebar so its Sponsored module cannot persist after React reinserts it.
- Removed all virtualized Home-feed filtering and post-expansion work from the visible-tab transition. Debug evidence showed unchanged `timeOrigin`/boot state but 12 native ad replacements and a 494 ms document pass, which visually reset and re-anchored the feed even though no document reload occurred.
- Upgraded anti-refresh protection to guard version 8 after a second unchanged-`timeOrigin` reset proved Facebook also uses the Window focus following visibility. Faceberg now suppresses exactly the first return-focus event, while the content runtime performs only one delayed visible-story `See more` pass and never schedules Sponsored filtering from tab return.
- Upgraded anti-refresh protection to guard version 9 after a Reel returned to Home with an unchanged document `timeOrigin`. The guard now covers the full hidden interval and narrowly rejects only non-user reloads or Home-route resets from a non-Home page, including Facebook's `history.pushState`/`replaceState` path.
- Upgraded anti-refresh protection to guard version 10 after diagnostics showed Chrome focusing the browser Window while the Facebook tab was still hidden. Hidden focus events no longer consume the one-shot return-focus token, and the Home feed remains in an eight-second automation quiet window after becoming visible.
- Added an opt-out experimental compact-feedback mode: Faceberg collapses only the direct inner post root immediately before invoking Facebook's native hide, keeps spinner and `Ad hidden`/`Post hidden`/`Hidden` feedback replacements collapsed through an event-driven MutationObserver, leaves the outer virtualized unit connected, and restores the style if Facebook returns the original post or React recycles the unit for ordinary content.
- Put direct React-owned Home-feed cleanup into fail-open compatibility mode after live testing also reproduced stalled infinite loading and non-responsive video controls. Dialog comment automation, independent sidebar cleanup, and native Sponsored hiding remain isolated.
- Added a diagnostic safe mode after a clean reload still left the Facebook tab saturated: content automation now keeps only its background ping contract, while the MAIN-world anti-refresh bootstrap installs no wrappers, navigation interception, lifecycle listeners, or observers. This establishes a native-Facebook performance baseline before features are re-enabled individually.
- Bound delayed comment automation to the post identity in the active permalink route and stopped treating a post's top-level comment count as a thread expander, preventing a recycled neighboring card from opening after the user's original comment click.
- Replaced comment-sorter `scrollIntoView()` with dialog-local scrolling so revealing an off-screen sorter cannot move the virtualized Home feed behind the post overlay and trigger apparent self-scrolling after the dialog closes.
- Made the MAIN-world anti-refresh guard upgradeable inside an existing Facebook document. A developer-mode extension reload now disables the older guard, installs version 7 through a versioned config channel, and upgrades hidden Facebook tabs before their first return transition.
- Recognizes current `View 1 reply` / `View N replies` controls when Facebook renders them beside their owning comment article instead of inside a semantic list, and unfolds multiple reply groups through bounded serial follow-up passes.
- Recognizes Facebook's current `Reply by ...` article label when validating an adjacent `View N replies` control; the older `Comment by ...`-only guard silently rejected these real nested threads.
- Activates verified `View N replies` buttons with the same complete pointer/mouse sequence Facebook currently requires instead of a bare `element.click()`, while retaining the exact-button, no-link, unchanged-route safety gates.
- Rejects Facebook's unavailable-content dialog even when Facebook leaves a comment composer and the Home feed mounted behind it, and limits reply expansion to one exact native button click after the post route settles.
- Restores Home-feed post-body expansion independently from disabled feed cleanup, limited to exact visible `See more` buttons inside story bodies with bounded startup and post-scroll hydration passes.
- Repairs the existing Follow/Join post toggles with native Facebook hiding: Faceberg resolves one complete CTA post, activates its unique `Hide post by …` control, and counts removal only after the Follow/Join marker disappears.
- Expands truncated comment and nested-reply text in Reel sidebars when Facebook renders an exact `See more` button beside a local ellipsis inside a verified `Comment by …` or `Reply by …` article.
- Recognizes Facebook's query-only self links inside the active post modal when validating the current direct-post route, without allowing mounted Home-feed links to satisfy that route guard.
- Opens and closes the comment-ordering popup through the validated page-world bridge, supports Facebook's current pointerdown/mousedown `ReactDOM.createEventHandle` listener store with one correctly ordered press sequence, and uses the same short row-label extraction for both popup detection and selection.
- Stops the comment bridge after the one PointerEvent press commit. The previous mixed pointer, mouse, and trailing click sequence could reopen the sorter or activate a control after React had already closed its menu, producing popup blinking and an unavailable-post surface.
- Replaces the incomplete pointer-only comment bridge with one MAIN-world native click on the already validated sorter control or `All comments` row. Live group-permalink testing showed pointer-only v6 never mounted the menu, while Facebook's real click selected the filter safely and allowed the existing reply-expansion stage to complete.
- Resolves Facebook Pressable callbacks from the exact control's React Fiber when current builds omit `__reactProps$` from the sorter toggle and menu row, stopping before the traversal crosses into another host DOM element.

### Improved

- Re-enabled comment automation as a lightweight, user-triggered runtime after the inert baseline restored native Facebook behavior. Home-feed mutations, Home-feed post expansion, the global subtree observer, scroll cleanup, and the old broad anti-refresh implementation remain disabled; a trusted comment/post click gets only three bounded follow-up checks.
- Reintroduced anti-refresh as one document-start Navigation API listener that cancels only non-user-initiated `reload` events during an eight-second tab-return window, after live logs confirmed that Facebook was performing a real document reload on return.
- Distinguished Facebook's same-document React feed reset from a real document reload using persisted `timeOrigin`, boot, visibility, and navigation diagnostics; the guard now lets the hidden transition pass but stops propagation of the first visible transition after return before Facebook can start that soft refresh.
- Removed global lifecycle-listener, timer, fetch, visibility, focus, and online/offline overrides from anti-refresh mode.
- Replaced unconditional heartbeat document scans with URL-change checks and mutation-local reruns.
- Reduced control activation to one dispatch path instead of firing native, synthetic pointer, and keyboard activation for the same action.
- Simplified root-group sorting to one native activation path with bounded state-verification retries instead of multi-target synthetic pointer/mouse sequences.
- Kept page-debug state inside the extension isolated world and removed page-content snippets from structural target descriptions.
- Added bounded rendered-label decoding and full-post structure checks so Sponsored detection identifies one complete card without broad text scans.
- Prefer accessibility labels over obfuscated button text when resolving post action menus.
- Added a final removal guard that refuses the main feed shell, composer, Feed posts heading, or any container spanning multiple post action menus.
- Removed broad virtualized-wrapper fallbacks from Stories and Follow/Join cleanup; non-post modules now refuse any target containing an ordinary post action menu.
- Added bounded post-scroll and hydration passes so late obfuscated Sponsored labels invoke the native hide control without restoring unconditional document scans or a global subtree observer.
- Removed the Sponsored placeholder overlay completely; successful removal is counted only after Facebook disconnects, hides, or de-sponsors the detected unit.
- Avoids every destructive feed-unit cleanup path while compatibility mode is active, eliminating React recycling mismatches and transparent or inert hit-test layers over native Facebook controls.
- Scans Facebook's compact `__cft__` metadata links for the rendered Sponsored label instead of assuming that ad labels open a new tab.
- Recognizes Follow/Join controls without requiring Facebook's optional `tabindex`, and removes a filtered node again if React reconnects the same DOM element without double-counting it.
- Accepts Facebook's current `Actions for this post by ...` menu label when resolving a single post boundary.
- Installs an inert anti-refresh bootstrap at document start, enables it from the saved setting, and cancels automatic resume reloads through the centralized Navigation API event before falling back to method guards.
- Replaces mutation-triggered full-feed rescans with card-local batches, moves post-scroll cleanup to an idle visible-card pass, and removes redundant full-document resume/startup passes.
- Fixes a comment-watcher leak that left one whole-body MutationObserver alive after every temporary automation session.
- Keeps meta-refresh observation inside the document head instead of inspecting every feed mutation, disables verbose automation tracing by default, and adds lightweight runtime/long-task timing to debug exports.

### Documentation

- Updated the architecture, comment-automation notes, README, popup copy, and regression checklist to match the repaired runtime.

## 2026-03-26 - v1.2.1

### Fixed

- Stabilized comment-filter selection across feed dialogs, direct post pages, and supported media surfaces by anchoring sorter-popup resolution to the active toggle and re-resolving popup nodes during Facebook hydration.
- Prevented spinner-loaded sorter menus on direct post and media surfaces from flickering while Faceberg waits to select `All comments`.
- Improved feed-dialog handling so an already-open loaded sorter popup selects `All comments` immediately instead of waiting through the delayed loading path.
- Expanded reply-summary detection so exact `View all N replies` controls are treated as valid reply expanders.
- Replaced root-group URL rewriting with an in-page group-feed sorter flow that selects `New posts` on direct loads and SPA navigation.

### Added

- Added `Copy Debug Information` to the popup Activity tab so troubleshooting data can be copied to the clipboard in one action.
- Added a popup setting to choose the default sort Faceberg applies on root group feed pages.

### Documentation

- Updated architecture, automation notes, regression checklist, and README coverage for the stabilized comment sorter flow, reply-summary fallback handling, debug export action, and configurable in-page root-group sort selection.

## 2026-03-23 - v1.1.0

### Release Summary

- Rebranded from FaceBoot to Faceberg with new artwork, updated all source identifiers, and shipped a redesigned popup stats UI.

### Changed

- Renamed extension from FaceBoot to Faceberg in manifest, all JS source files, store listings, and documentation.
- Replaced all `__facebootContentScriptInstalled`, `__facebootNoRefreshInstalled`, and `FaceBootStats` identifiers with their `Faceberg` equivalents.
- Enabled anti-refresh protection by default (`enableAntiRefresh: true`).

### Improved — Anti-Refresh (`injected.js`)

- Added `normalizePathname()` to strip trailing slashes before same-path comparison, preventing spurious reload blocks on canonical URL variants.
- Added `toNavigationTarget()` for consistent URL coercion from string or object inputs.
- Extended `VOLATILE_REFRESH_PARAM_PATTERN` to also strip `_rdc`, `_rdr`, `__tn__`, `__xts__`, and `utm_*` parameters from canonical comparisons.
- Added `pagehide` and `freeze` to `SUSPICIOUS_EVENT_TYPES` alongside the existing visibility/focus events.
- Increased `RESUME_SUPPRESSION_WINDOW_MS` from 5 000 ms to 10 000 ms.
- Added `lastUserInteractionAt` tracking to inform smarter suppression decisions.
- Fixed a default-settings mismatch between `background.js` and `content.js` so protected Facebook tabs no longer remain discardable by default and reload after long idle periods.

### Improved — Popup

- Redesigned stats panel with an ROI hero section showing estimated time saved and three breakdown pillars (Cleanup, Expansion, Refresh).
- Replaced individual badge/total elements with a unified detail list for a cleaner at-a-glance view.

### Fixed — Notification Navigation

- Documented and hardened the notification-navigation failure mode where Facebook can rewrite the URL before replacing the old feed DOM.
- Restricted direct-post automation so it waits for DOM evidence matching the current target post instead of acting on stale feed surfaces.
- Preserved notification safety by keeping dialog and surface resolution narrow instead of relying on a dedicated notification-suppression layer.
- Removed navigation-prone generic primary comment opener automation from direct post handling to avoid wrong-post opens, stacked dialogs, and parent-group-feed misroutes.

### Fixed — Comment Filtering

- Hardened `All comments` selection so menu-item clicks only count as success when the sorter UI actually changes, preventing popup flicker loops that leave the filter on `Most relevant` or `Newest`.

### Documentation

- Added explicit notification-navigation guardrails and regression coverage so future automation changes do not reintroduce random post opens from notifications.

### Icons

- Replaced placeholder book and source assets with new Faceberg ship-and-iceberg artwork across all sizes (16 × 16, 32 × 32, 48 × 48, 128 × 128).
- Added `faceberg.ico`, `faceberg_master_1024.png`, and `logo.png` source assets.
- Updated `make-icons.ps1` for the new logo source.

### Added

- `CHROME-STORE-APPEAL.md` — draft appeal letter for Chrome Web Store submission review.
- `STORE-LISTING-FALLBACK.md` — condensed fallback store listing copy.
- `test.js` — in-page debugging helper.

## 2026-03-22 - v1.0.1

### Release Summary

- Published the first major release with the isolated reel comment resolver, stronger anti-refresh protection, corrected session and filter-change stats, and the redesigned Activity tab.

### Packaging

- Included the new Activity tab book icon asset and About tab source icon asset in the release package.

## 2026-03-22

### Fixed

- Hardened startup post expansion so the first visible feed post no longer leaves `See more` inline while Facebook is still hydrating the page.
- Added bounded retry handling for valid post expanders that are detectable before Facebook attaches their live click handlers.
- Prevented feed photo/lightbox opens that temporarily rewrite the URL to `/photo/` from triggering document-level direct-page automation too early.
- Restored the guard that prevents random or stale post dialogs from reopening when clicking feed photos.
- Added a reel-specific comment resolver that targets only the active visible reel surface instead of reusing generic direct-post fallback.
- Reel comment automation now switches to `All comments` and expands visible reel threads only when one active reel surface can be identified unambiguously.
- Hardened anti-refresh protection against delayed tab-return reloads by suppressing resume lifecycle signals longer and spoofing visibility/focus checks.
- Moved session stat resets to extension startup so Facebook page loads no longer wipe `This Session` counters.
- Fixed comment filter-change counting by passing runtime stat dependencies through the delayed sorter retry path.
- Redesigned the Activity tab around grouped stats, period switching, reset tracking, and saved-time estimates.

### Documentation

- Documented the first-post startup hydration failure mode and the required regression coverage.
- Documented the feed-photo overlay URL rewrite trap and the media-viewer boundary rules.
- Documented the isolated reel resolver boundary and the requirement to abort when multiple visible reel candidates remain ambiguous.
- Documented the current Activity tab model and added regression coverage for filter-change counting and session-stat persistence.
