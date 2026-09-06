# Faceberg Regression Checklist

Use this checklist after changing feed cleanup, post expansion, comment expansion, or page-observer logic.

## Feed Cleanup

1. Open the main Facebook feed.
2. Verify destructive DOM filtering remains fail-open for ordinary React-owned
   post cards. Any rendered Sponsored, Follow, and Join cards must remain unmarked and keep
   native geometry. People You May Know targets may use connected, reversible
   module suppression. Exact
   standalone Reels and Stories roots may be layout-hidden while their nodes
   remain connected. The independent right-column Sponsored module may still
   be removed directly.
3. On a fresh load, confirm no ordinary main-feed card receives
   `data-faceberg-suppressed-feed-unit`, `display: none`, a placeholder, or a
   native `Hide post`/`Hide ad` activation.
4. Scroll the feed and confirm no delayed settled-scroll task attempts to
   collapse newly hydrated Sponsored cards.
5. On a fresh load with Sponsored filtering enabled, confirm the root
   `data-faceberg-main-feed-sponsored-version` diagnostic is `9`, and the
   `data-faceberg-main-feed-sponsored-guard` diagnostic advances through
   `payload-listener-queued` or `payload-listener-patched`, or directly to
   `suppressed` when an initial bootstrap ad is served. Confirm
   `data-faceberg-main-feed-payload-consumer` advances from `not-seen` to
   `queued` and then `patched`. Confirm the separate
   `data-faceberg-main-feed-require-lazy` reports `wrapped`. Confirm the separate
   `data-faceberg-main-feed-payload-observer` reports `watching` during parsing
   and `stopped` after DOM readiness. Confirm
   `data-faceberg-main-feed-connection-handler` reports `patched`, and
   `data-faceberg-main-feed-sponsored-count` is greater than zero. An exact
   normalized Home-feed edge with a `SponsoredData` linked record must be
   removed from the connection before rendering. Other connections and organic
   edges must pass through unchanged.
6. Confirm ordinary feed posts remain visible and clickable.
6. Reload the Home route with right-column Sponsored and recommendation modules present; confirm the main feed, composer, and ordinary post cards remain.
7. Repeat on the chronological feed and confirm cleanup never removes a wrapper spanning multiple post cards.
8. Scroll Home until Stories, Reels, recommendation, and Follow/Join units
   hydrate. Confirm the exact Stories tray and Reels module are hidden, their
   marked nodes remain connected, and no cleanup path can hide an ordinary
   post or the remaining feed segment.
9. Disable the Reels and Stories toggles independently. Confirm the matching
   module returns immediately, its marker is removed, and the other module
   remains governed by its own setting.
10. Open the full-screen Reels viewer with **Remove Sponsored Reels** enabled.
    Confirm ads using the compact lower-player `Ad` badge and a `Play game` CTA
    are detected with an explicit external destination. The active ad must
    advance through the native `Next Card` control; the resulting URL, visible
    Reel, and comment sidebar must all belong to the same next item.
11. Confirm a Sponsored Reel increments `removedSponsoredReels` exactly once.
    Confirm a verified preloaded off-screen ad occupies no scroll-snap space and
    stays suppressed after Facebook remounts or rehydrates the Reel stack.
    Disable only
    **Remove Sponsored Reels** and verify Sponsored Reels remain
    native while the Home-feed **Hide Reels** setting keeps its independent
    behavior.
12. Confirm ordinary captions containing “sponsored” or “ad”, Facebook profile
    links, organic caption links, non-Reel videos, and ambiguous multi-video
    roots never qualify. The compact `Ad` badge must be a leaf label in the
    lower half of the video player. A CTA signal must be an exact known action
    on an external anchor; every valid target must also have the exact player
    marker, one item video, sibling Reel videos, and viewport-sized geometry.
13. Confirm a Sponsored label that appears on an already-rendered card remains native and never invokes the native Hide control; only pre-render stream evidence may suppress it.
14. Confirm ordinary obfuscated author, timestamp, media, and outbound links never qualify as Sponsored markers.
15. Confirm Faceberg never marks, collapses, restyles, makes inert, removes, or reparents the outer React-owned Sponsored feed unit.
16. Confirm Follow and Join controls are detected both with and without a `tabindex` attribute.
17. Confirm complete Follow/Join CTA posts remain native and their `Hide post by …` controls are never activated.
18. Confirm the popup enables the Sponsored-feed toggle while marking only Follow and Join as compatibility-paused.
19. Confirm a physically removed filtered module is removed again, without another stat increment, if React reconnects the same node.
20. Type continuously in a Facebook search, comment, or message composer and confirm Faceberg does not schedule full-feed cleanup from those mutations.
21. After opening and closing several post dialogs, confirm disconnected
   surface observers stop and the number of live observers does not accumulate.
22. Scroll normally in both directions. Confirm ordinary cards retain native
    geometry, upward scrolling never rebounds, and the feed contains no
    Faceberg-created full-card gaps.
23. With a Sponsored or Follow/Join item between two ordinary posts, click the visible comment control above and below it; each click must open the comments for that same visible post.
24. Open one post, close it, and immediately open a different post; confirm the second dialog and permalink belong to the second card even when Sponsored/Follow/Join cards are nearby.
25. Confirm rendered-card Sponsored/Follow/Join suppression never runs on Home,
    behind an open modal, or because of a post-navigation click.
26. Scroll past several stream-filtered ads and confirm Facebook continues loading ordinary feed items without a persistent loader, edge hole, or automatic scroll loop.
27. Play and pause videos in several ordinary feed cards; native controls must respond immediately and no invisible or inert Faceberg wrapper may cover them.
28. Confirm that no `[data-faceberg-sponsored-mask-host]` placeholder remains after upgrading from the abandoned masking implementation.
25. Open and close a post; confirm scoped feed observers reconnect from the
   actual dialog-close mutation, with no delayed resume.
26. Leave Home idle while Facebook reinserts the right sidebar; confirm a reappearing Sponsored sidebar module is removed without a full-page observer or feed scan.
    On a fresh reload with feed filtering enabled, also confirm
    `CometHomeRightSideEgo.react` and `useSideAdsRefreshHandler` appear in the
    module guard's intercepted set, the sidebar Sponsored block never mounts,
    and returning to the tab does not issue
    `CometHomeRightSideEgoRefetchQuery`.
    Then disable only **Hide right-column Sponsored**, apply settings, and
    confirm those module targets are absent while main-feed Sponsored filtering
    remains enabled. Reverse the two Sponsored settings and confirm the sidebar
    stays blocked while the manifest stream guard remains present but passes
    Home-feed edges through with its configuration disabled.
27. With `Compact hidden feedback (experimental)` enabled, manually hide a
   post and confirm an exact `Ad hidden`, `Post hidden`, or verified plain
   `Hidden` feedback payload can be compacted without polling timeouts.
28. Scroll until Facebook recycles the compacted unit; confirm the next ordinary post is visible, opens its own comments, plays video normally, and does not retain `data-faceberg-compact-hidden-feedback`.
29. Disable compact feedback and apply settings; confirm any currently connected compacted feedback payload is restored and no ordinary feed card changes.
30. On a fresh Home load, confirm filtered Sponsored stories never create a
    rendered card and there is no structural card-hiding CSS, visible
    placeholder, scroll compensation, or native Hide click.
31. Click a timestamp, post body, media, comment control, and other query-only
   link on a visible card while feed mutations are arriving; each must open its
   own post, never a recently hidden adjacent card or an unavailable route.
32. In Vivaldi, scroll long enough to encounter many Sponsored, Follow, and Join
    cards. Confirm the number of connected ordinary feed cards stays governed by
    Facebook's virtualizer and no Faceberg suppression markers accumulate.
33. Open a post or Reel after that scroll and confirm Facebook's body-level
    `top: -10000px` SvgWml measurement bucket does not extend into the viewport;
    timestamps and CTA labels must not appear outside their cards.
34. Click ordinary cards repeatedly and confirm each opens its own post without
    an unavailable-page fallback.

## Post Expansion

1. Find several truncated posts in the feed.
2. Reload with a truncated first feed post visible at the top of the page.
3. Verify the first visible `See more` expands during startup before scrolling away.
4. Confirm the first post does not leave the literal `See more` text concatenated into the visible body.
5. Verify later visible `See more`-style controls also expand the post body.
6. Confirm no unrelated menus or dialogs open during expansion.
7. Confirm already-expanded posts are not spam-clicked repeatedly.

## Comment Expansion

1. Open a direct post/permalink page.
2. Verify visible comment-summary, load-more-comment, and reply-expander controls are expanded.
3. If the page initially opens the sorter with a loading spinner, confirm the popup settles once and does not flicker while Faceberg waits for `All comments`.
4. Open a post dialog from the feed.
5. If Facebook renders nested dialog shells, confirm only the deepest visible modal receives automation.
6. Scroll so the sorter is initially below the viewport, then confirm Faceberg reveals it, opens it once, and restores the previous dialog scroll position.
7. Verify the comment-ordering popup opens only for the active dialog.
8. Confirm `All comments` becomes the selected option in the dialog even when `aria-expanded` remains false.
9. Confirm the exact `All comments` row is selected through its narrowly scoped MAIN-world React handler bridge, and that the comment-ordering popup closes immediately after confirmation or bounded failure without a delayed close timer.
10. Open a Reel with a truncated top-level comment or nested reply in the side panel; confirm the exact inline `See more` expands the comment text without changing the Reel URL, opening another post, or touching the Reel caption.
11. Confirm `Filter changes` increments by 1 only after the sorter confirms the switch away from `Most relevant` or `Newest`.
12. Verify visible comment/reply expansion works after sorting changes.
13. Confirm no unrelated post or menu is opened.
14. Confirm exact `View 1 reply`, `View N replies`, `View all N replies`, and `View more answers` controls expand when visible, including controls adjacent to a `Comment by ...` or `Reply by ...` article without a semantic list wrapper.
15. Confirm reply expansion activates the exact native button with one DOM click and never a nested label, link, ancestor, synthetic pointer sequence, or keyboard fallback.
16. On a permalink where Facebook keeps a hidden zero-size copy of the sorter, confirm Faceberg chooses the rendered toggle, opens the popup once, and selects `All comments`.
17. Open a stale or unavailable post from the feed and confirm Faceberg does not automate the resulting error dialog or interact with the mounted feed behind it.
18. Disable **Switch to All comments** while leaving **Expand replies and comment
    text** enabled; reopen a post and confirm the sorter stays native while
    replies still unfold.
19. Reverse those two settings; reopen a post and confirm the sorter switches to
    `All comments` while reply and comment-text controls stay untouched.
20. Open a `/reel/` page or Reels route with one clearly visible active reel.
21. Verify only the active reel comment surface is targeted.
22. Confirm `All comments` becomes the selected option when the reel sorter is present.
23. Confirm `Filter changes` increments only when the reel sorter actually switches.
24. Verify visible reel comment/reply expansion works after sorting changes.
25. Advance through at least five Reels without closing the viewer. After each
    route change, confirm the sidebar belongs to the current Reel and that the
    first Reel's sorter, comments, and reply controls are never reused.
26. Confirm no older feed/dialog post reopens while using the reel surface.
27. If multiple reel candidates are visible, confirm automation prefers doing nothing over opening the wrong surface.
28. Open a direct post whose active modal uses query-only timestamp/story links while its comment permalinks carry a different post ID; confirm the visible modal still switches to `All comments` and the mounted Home feed is not treated as the target.
29. Close a post with the modal-local close button and confirm no other post
   opens during teardown.
30. Repeat with Facebook's top-left page-header close button and confirm the
   same clean return to Home.
31. In Vivaldi, open a sorter whose loading popup node is replaced before its
   rows appear. Confirm Faceberg re-resolves the replacement, selects
   `All comments`, and processes the menu mutation without waiting for an
   animation frame.
32. Stall rendering for longer than the normal selection window and confirm the
    same sorter row is activated no more than twice; elapsed time must not reset
    the attempt count or make the popup blink indefinitely.
33. In Vivaldi, open a Reel with visible replies and confirm diagnostics resolve
    a narrow article, pagelet, or complementary comment surface, never
    `main`/`[role="main"]` or a container holding the Reel video.
34. Advance to another Reel, then expand `View 1 reply`. Confirm the owning
    comment article contains a link resolving to the current Reel identity and
    that the URL cannot change to a feed, group, or unavailable post.

## Media Viewer Checks

1. From the feed, open a photo from a post that has comments.
2. Confirm a previously viewed post does not reopen over the photo.
3. If the media viewer has inline comments, confirm the filter changes to `All comments`.
4. If the media viewer is a direct `/photo/` or `/watch/` page, confirm comment expansion still works.
5. If Facebook rewrites the URL to `/photo/` while the photo is still acting like a feed overlay, confirm no document-level automation targets an older post underneath it.
6. Repeat photo open/close several times and confirm old dialogs are not re-targeted.

## Safety Checks

1. From the feed, click comment on one post and confirm no unrelated/random post opens.
2. Confirm no stray outside clicks occur.
3. Confirm typing in an active comment composer is not interrupted.
4. Confirm automation does not run on media-viewer pages.

## Sticky Failure Loop Checks

1. Open comments on one post.
2. Close it and open a different post's comments.
3. Open a photo from the feed.
4. Repeat the sequence at least three times.
5. Confirm Faceberg does not enter a state where random older posts reopen on each new comment/photo click.

## Observer / Navigation Checks

1. Let the feed update naturally while scrolling.
2. Confirm observer reruns remain stable and do not trigger modal-opening behavior.
3. Navigate between feed, direct-post page, and back.
4. Confirm comment automation remains scoped to direct-post pages or already-open dialogs.
5. Without reloading the document, open one permalink and then a different
   permalink through Facebook's SPA router; confirm the second post switches
   to `All comments` and expands its own replies.
6. Confirm `spaMutationBatches` may increase during DOM activity while
   `spaUrlChanges` increases only when the actual URL changes.

## Notification Navigation Checks

These checks remain important, but the current code does not have a dedicated notification-suppression window. Failures here usually indicate dialog-resolution or stale-surface regressions.

1. Open the notifications surface from the main Facebook UI.
2. Click a notification that targets a normal feed post.
3. Confirm the intended post opens and no unrelated/random post opens instead.
4. Close the opened post and repeat the same notification click at least twice.
5. Confirm the first click behaves the same as later clicks; there is no stale first-attempt misfire.
6. Click a notification that targets a group post.
7. Confirm Faceberg does not land on the parent group feed when the notification should open the specific post.
8. Confirm two post dialogs never stack on top of each other during notification opens.
9. While the notifications surface is visible, confirm Faceberg does not trigger feed/comment automation elsewhere on the page.
10. After the notification target finishes opening, confirm normal automation resumes on the actual destination post only.

## URL Normalization Checks

1. Enable **Go directly to feeds on activation** and apply settings.
2. Confirm redirected Facebook tabs open on:
   - `https://www.facebook.com/?filter=all&sk=h_chr&sorting_setting=CHRONOLOGICAL`
3. Open a root group page such as `https://www.facebook.com/groups/<id>`.
4. Set **Default group sort** in the popup to a non-default option such as `Most relevant` or `Recent activity` and apply settings.
5. Confirm Faceberg finds the in-page group feed sorter and switches it to the configured default sort without navigating away.
6. Navigate to the same root group feed through Facebook SPA navigation and confirm the sorter still settles on the configured default sort.
7. Switch the configured sort repeatedly between `Recent activity` and `New posts`; each transition should settle without menu flicker or duplicate pointer/mouse dispatch.

## Anti-Refresh Checks

1. Enable anti-refresh protection.
2. Scroll to a position that is easy to recognize and record the current URL.
3. Switch away from Facebook and back at least five times, including one background interval longer than ten seconds.
4. Confirm the document does not reload, the URL does not reset from a post to the root feed, and the scroll position remains stable.
5. Confirm ordinary user navigation, online/offline handling, Facebook data loading, focus detection, and visibility-driven UI continue to work.
6. Trigger a normal manual reload and confirm Faceberg does not block it.
7. If an unexpected reload still occurs, confirm the same-URL page restores the recent scroll position, including when Chrome initially restores only part of the saved offset.
8. Confirm `Prevented refreshes` increments only for an actual blocked navigation or removed meta refresh, not for lifecycle events or listener registration.
9. Confirm core cleanup/expansion still works with anti-refresh enabled.
10. Copy debug information and confirm `timeOrigin` matches
    `lastBoot.timeOrigin`, `antiRefresh.networkDiagnosticsInstalled` is
    `false`, and `antiRefresh.networkEvents` is empty. Confirm the page's
    `fetch` and XMLHttpRequest functions are not Faceberg wrappers.
11. After reloading the unpacked extension and then the Facebook document,
    confirm `antiRefresh.staleFeedGuard.loaderWrapped` is `true`,
    `latePatchRequiresReload` is `false`, and all five anti-refresh
    `targetModules` appear in `interceptedModules`. Confirm
    `useCometHomeStaleFeedRefresh`,
    `useInvalidateCometNewsFeedConnectionOnMaintainedRouteUnmount`,
    `useCometNewsFeedRefreshThrottler`, and
    `useRefreshCometStoriesTrayOnMaintainedRouteUnmount` appear in
    `disabledModules`. `useCometFeedPushViewCloseRefresh` must also appear there
    if Facebook executes its factory; it may remain unexecuted when disabling
    the parent Home hook makes that dependency unreachable.
12. Leave Home in a background tab past Facebook's stale threshold and return.
    Confirm the same feed identity, scroll position, and loaded items remain.
13. Open a feed post, leave it open past the pushed-view stale threshold, then
    close it. Confirm no replacement post opens, Home does not scroll to the
    top, and normal pagination still loads when the user scrolls.

## Activity Stats Checks

1. Trigger at least one feed cleanup action and one automated action.
2. Confirm `This Session` updates without reopening the popup.
3. Refresh the Facebook page and confirm `This Session` is not wiped by that page load.
4. Switch to `All Time` and confirm the totals are at least as large as `This Session`.
5. Use `Reset` and confirm totals clear and the tracking date updates.
6. Use `Copy Debug Information` and confirm the clipboard payload includes extension version, active Facebook tab details, saved settings, current stats, and page-debug extraction hints.

## Acceptance Criteria

Changes are acceptable when all of the following remain true:

1. Feed cleanup removes unwanted content without affecting normal posts.
2. Post expansion works without opening unexpected UI.
3. Dialog comment automation selects `All comments` and then expands visible threads.
4. URL normalization keeps supported feed/group surfaces chronological.
5. No random posts or dialogs open.
6. No stray clicks or composer interruptions occur.
7. Repeated photo/comment opens do not resurrect previously viewed dialogs.
8. Notification-driven navigation never opens the wrong post, a stacked post dialog, or a parent group feed.
9. A stable visible page does not receive unconditional full-document scans or
   periodic heartbeat work.
10. Facebook startup does not report a hydration mismatch caused by Faceberg document-start mutations.
11. With anti-refresh enabled, leave Facebook for another tab and return after both a short and a long pause; an automatic `reload` navigation is cancelled without changing the current route or feed position.
12. With anti-refresh disabled, the document-start bootstrap remains inert and normal user-initiated reload/navigation still works.
13. On tab return, confirm guard v13 does not suppress visibility/focus, one
    immediate scoped Sponsored scan contains no post-expansion or comment work,
    no later timer-driven card disappears, and an already playing Reel remains
    playable.
14. Open a Reel or direct post, switch away long enough for Facebook to
    background it, then return without interacting. Confirm a non-user reload
    or history reset to Home is blocked while deliberate user navigation remains
    allowed.
