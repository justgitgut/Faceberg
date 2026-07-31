# Comment Automation Notes

This document captures the working structure of Faceberg comment automation and the failure modes that repeatedly caused regressions.

## Working Model

Comment automation has three stable surfaces:

1. Feed post dialog
2. Direct post/permalink page
3. Direct media surface or media dialog with visible comment UI

Reels use a separate active-surface resolver. They are not part of the generic direct-post or media-page fallback.

The intended order is:

1. Resolve the active comment surface narrowly.
2. Open the sorter toggle when present.
3. Switch the sorter to `All comments`.
4. Wait for DOM updates.
5. Expand visible comment/reply summary and load-more controls.

## Surface Resolution Rules

- Feed-wide comment automation must never search arbitrary page surfaces from `document`.
- On the feed, automation should act only on the active post dialog.
- Direct permalink/media pages may use non-dialog surfaces such as:
  - `[role="complementary"]`
  - `main`
  - `[role="main"]`
  - `[data-pagelet]`
  - `div[role="article"]`
- A topmost media viewer without visible comment UI is a hard stop. Do not fall back to an older dialog underneath it.
- A feed photo/lightbox can rewrite the page URL to `/photo/` before inline comments exist. That URL change alone must not trigger document-level direct-page automation.
- A notifications click can also rewrite the URL before Facebook finishes replacing the old feed DOM. That transition must not allow any feed, dialog, or direct-page automation to act on stale surfaces.
- Facebook may render the active modal post's own timestamp/story links as query-only hrefs while comment permalinks use a different canonical post ID. Treat an exact resolved self link as route evidence only inside the deepest `aria-modal="true"` post dialog; never use query-only links from the mounted Home feed to validate a direct-post surface.
- Do not treat Reels surfaces as direct post surfaces even if the URL contains `/reel/`.
- Reel automation must first identify one active reel context with visible reel media, then resolve comment controls only inside that context or its adjacent comment panel.
- If multiple reel candidates remain close in score, abort instead of guessing.

## Dialog Rules

- Do not assume the first visible dialog is the correct post dialog.
- Facebook may nest a full-screen dialog shell around the real `aria-modal` post. Canonicalize that structure to the deepest visible modal before creating automation state.
- Facebook renders one close control inside the modal and another in the
  surrounding page header. Treat either trusted pointer-down as the beginning
  of dialog teardown, suspend every comment automation continuation, and resume
  only after the exact modal disconnects or a different route-matching surface
  is resolved.
- A dialog is automatable only when it is:
  - a real post dialog with post signals, or
  - a media viewer dialog that already exposes comment UI
- If a broad document pass cannot identify an active automatable dialog, do nothing.

## Filter Rules

- The filter must be switched before reply expansion is attempted.
- If the resolved sorter is outside the viewport inside a scrollable dialog, snapshot the relevant scroll containers and reveal it before activation.
- Sorter opening asks the narrowly scoped MAIN-world bridge to invoke the
  resolved toggle's React callback and falls back to one native DOM click only
  when that handler is unavailable. Popup and selection verification run from
  the resulting DOM/ARIA mutations without polling or animation-frame delay.
- The bridge may resolve `onClick`/`onPress` from the exact host node's `__reactProps$`, `__reactEventHandlers$`, or host Fiber. Fiber traversal must stop before entering a different host DOM element so an ancestor dialog/post handler can never be mistaken for the sorter action.
- Popup detection is authoritative because Facebook does not always update `aria-expanded`.
- Restore the captured dialog scroll position after selection succeeds, fails, or times out.
- Menu item selection should stay narrowly targeted to the active popup.
- The `All comments` action must target the popup's explicit interactive row
  (`menuitem`, `menuitemradio`, `option`, or `radio`), never a descendant label
  that can absorb a no-op click. Its current Facebook callback is
  zero-argument; do not pass a hand-built React event object into it.
- Resolve the exact interactive row, then ask the narrowly scoped MAIN-world
  bridge to invoke that row's own React `onClick`/`onPress` handler. The bridge
  accepts only a visible `All comments` row inside Facebook's `Comment Ordering`
  menu; it never performs selector-wide page actions or keyboard activation.
- Popup resolution must stay anchored to the active sorter toggle; visible menus elsewhere on the page are not valid fallbacks.
- Facebook can replace the sorter popup node while the menu is hydrating.
  Watchers must re-resolve the active popup instead of holding onto the first
  node they saw. A unique visible
  `role="menu" aria-label="Comment Ordering"` is authoritative even when a
  slow Chromium variant positions it outside the normal proximity envelope.
- Feed dialogs can select immediately from an already-open loaded popup, while
  direct post and media surfaces use a MutationObserver when Facebook shows a
  spinner first.
- Do not increment `Filter changes` when a click is merely dispatched; wait
  until the sorter text confirms `All comments`.
- Treat popup dismissal as part of successful selection. If a popup remains visible after confirmation or failure, close it immediately through the anchored toggle instead of reactivating a menu row or scheduling another delayed fallback.
- If selection is not confirmed, retry the exact row at most once, close the
  popup, restore scroll, and yield until a later automation wake instead of
  leaving the menu open or looping. The attempt count is structural and must
  never reset merely because Vivaldi delayed mutation delivery.
- Any filter-change stat increment must receive the runtime `deps` object
  through both immediate selection and mutation-driven verification; otherwise
  the UI can switch correctly while the counter stays at zero.

## Expansion Rules

- Expansion should target summary/load-more/reply controls only.
- Do not auto-click broad primary comment openers from the feed.
- Reply expansion reacts to the DOM mutation produced by the filter switch or
  preceding reply activation.
- Exact `View N replies`, `View all N replies`, and answer-labelled variants should be treated as reply-summary controls even when Facebook changes surrounding wrappers.
- A reply summary may sit beside its owning `Comment by ...` or `Reply by ...` article without a semantic list wrapper. That single-comment structural relationship is sufficient; a post-level comment count is not.
- Multiple reply groups expand serially, one activation per observed DOM
  change, with a per-surface attempt cap rather than elapsed-time cooldowns.
- Activate only the exact native reply/load-more button. Never click a guessed label descendant or clickable ancestor because either can inherit a post permalink.
- After all structure and route guards pass, activate the exact native `View N
  replies` button with one DOM click; never dispatch a duplicate synthetic
  pointer/keyboard sequence.
- Treat an exact `See more` as comment-text expansion only when it is a native button inside a verified `Comment by …` or `Reply by …` article, its local text wrapper ends in an ellipsis plus `See more`, and it has no link or menu ancestor. This includes Reel comment sidebars while excluding Reel captions and post bodies.
- Bind every mutation-driven continuation to the unchanged URL and connected
  dialog, and ignore unavailable-content dialogs even when their failed shell
  contains a comment composer.
- Direct permalink dialogs can auto-focus the empty comment composer (`Comment as ...`) without any user input. That empty focused composer must not suppress reply expansion; only real typed composer content should block automation.

## Watcher Rules

- Mutation watchers are necessary because sorting and expansion render asynchronously.
- Follow-up expansion watchers rerun against the same connected visible canonical surface, not the whole document.
- When a newly added dialog appears, rerun automation from that dialog root first.
- Facebook SPA permalink changes are not guaranteed to emit `popstate`,
  `hashchange`, or `Navigation.currententrychange` in the content-script world.
  Wake comment automation from both the MAIN-world history bridge and the
  background tab URL event, with a constant-time URL comparison on DOM mutation
  as a fallback.
- A permalink commit can precede replacement of the old post dialog. Keep only
  that exact destination URL armed until `getVisiblePostDialog()` resolves a
  route-matching surface; rejecting the stale dialog is not completion. During
  this transition, inspect only the canonical dialog resolver and never scan
  mutation records or feed nodes.

## Notification Navigation Rules

- The current working code does not have a dedicated notification-suppression layer in `content.js` or `content-comments.js`.
- Notification safety currently relies on narrow dialog selection, direct media/viewer checks, and avoiding broad feed-level comment opener clicks.
- If notification regressions reappear, treat them as structural dialog-resolution bugs first; do not assume a suppression window exists.

## Things To Avoid

- Avoid `document`-level fallback into feed surfaces for comment automation.
- Avoid falling back from a topmost media viewer into older dialogs.
- Avoid counting menu-item activation success before the actual `All comments` row is clicked.
- Avoid assuming CSS visibility means the sorter is inside the viewport.
- Avoid multiple activation mechanisms in one attempt; duplicate native, synthetic, and keyboard dispatch can toggle menus twice. Bounded retries must repeat the same exact-row page-world handler action.
- Avoid anchoring sorter-menu follow-up logic to a popup node that Facebook is free to replace during loading.
- Avoid changing dialog resolution heuristics without rerunning the full regression checklist.
- Avoid removing the comments that explain why feed/document fallbacks are restricted.

## Minimum Regression Pass

After touching comment automation, verify all of the following:

1. Main-feed post bodies still expand.
2. Clicking comments on the feed does not open random posts.
3. The sorter switches from `Most relevant` to `All comments`.
4. Reply/load-more controls expand after sorting changes.
5. Direct `/photo/` and `/watch/` pages still work.
6. Opening a photo does not resurrect a previously viewed post dialog.
7. A feed photo that rewrites the URL to `/photo/` does not trigger random post/dialog reopen behavior before inline comments appear.
8. On a `/reel/` or Reels route, comment automation resolves only the active reel surface and does not reopen a stale post dialog.
9. If the active reel surface is ambiguous, comment automation does nothing.
10. `Filter changes` increments only when the sorter actually transitions to
    `All comments`.
11. Opening notifications does not cause random posts, stacked post dialogs, or parent group feeds to open.
12. If the same notification is opened repeatedly, the first click behaves the same as later clicks; there is no stale-first-click misfire.
13. A direct post or media sorter that first opens with a spinner settles onto the same active popup and selects `All comments` without flickering.
14. Feed dialogs with an already-open loaded sorter popup select `All comments` immediately instead of waiting through the loading watcher path.
