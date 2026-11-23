# Notifications are toasts

Every message the app produces about *something that just happened* is a toast: a tinted pill at
the top of the window (user request: "make all the toasts appear at the top not at the bottom"), in a colour that means what it says, gone in five to eight seconds, and
dismissible with a real button.

That is a product rule, not a component (user request: "ALL NOTIFICATIONS SHOULD BE TOASTS IN
APPROPRIATE COLORS", and then "DO NOT DUPLICATE: YOU ALREADY HAVE A TOAST"). Before it, each
announcement had its own surface — a build strip above the preview frame, a status sentence in the
preview toolbar, a boot line beside the wordmark, a "why you cannot type yet" paragraph under the
prompt box — and each of those surfaces was a different distance from the thing it described, in a
different colour, and half of them could not be dismissed. Several of them said the same thing as
another one: the machine's boot state was printed under the prompt *and* announced as a toast over
the same window at the same moment.

## The rule, in one line each

- **A notification is news.** It is announced once, when it becomes true, and it leaves.
- **A fact is not news.** The guest's served-by badge (a worker-held build has none), the status
  segments in the debug popover, the preview's own error surface where the frame would be, and a
  failed build's reason stay exactly where they are. They are read on demand, and a fact that
  vanished after five seconds would be worse than no fact at all.
- **Nothing is announced twice.** If a toast carries a sentence, no pane lays it out as well. When
  two surfaces seemed to need the same words, the pane kept the *state* (a disabled control, a
  badge, a tooltip) and the toast kept the *sentence*.
- **The colour is the meaning, and never the only channel.** Each tone has its own pictogram.

| Tone | Colour | Means | Stays |
| --- | --- | --- | --- |
| `info` | blue (`--info`) | something is happening | 5 s |
| `success` | green (`--success`) | it worked | 5 s |
| `warning` | amber (`--warning`) | read this before it bites (a `netlify.toml` the agent must fix) | 8 s |
| `danger` | red (`--destructive`) | it failed | 8 s |

The tints are the app's own status tints (`bg-tone/20`, `border-tone/40`, full-strength text), the
same recipe as `badge.tsx`, so a toast looks like it belongs to this app and stays legible over a
dark or a light pane.

## What is announced today

One notification per source, derived in `src/ui/notifications.ts` from the objects that already
know the answer:

| Source (`id`) | `info` | `success` | `danger` |
| --- | --- | --- | --- |
| `machine` | `initializing`/`booting` + the stage word | `Linux is ready.` | the boot error, verbatim |
| `build` | installing / building | `Build <id> succeeded in 4.2 s.` | the manager's failure summary |
| `preview` | starting / publishing | — (the frame appearing is the announcement) | `The preview could not load: …` |
| `app` | starting `bun run start` | `` `bun run start` answered 200 on guest port 3000. `` | the app's own message |
| `netlify` | — | `netlify.toml is valid.` | — (`warning`: the problems list) |

Quiet states announce nothing: a machine nobody booted, a build that has not run, an idle app
server, a preview that simply loaded.

## How it is built

| File | Job |
| --- | --- |
| `src/ui/toast.ts` | The model: identity, tones, lifetimes, and `newlyAnnounced` — the pure rule for what counts as news. |
| `src/ui/use-toast.ts` | The list and the clocks. One timer per toast, reconciled with the list in an effect; a re-raised toast restarts its clock; unmounting clears everything. |
| `src/ui/components/toast.tsx` | The paint: a `fixed` stack, the tone tables, the pictograms, the close buttons, the live region. |
| `src/ui/notifications.ts` | Every notification the app can produce, and its colour. |
| `src/ui/use-notifications.ts` | Raises what is new and forgets what has gone quiet. |
| `src/App.tsx` | One `useToast()` + one `useNotifications()` call site. |

Four details that are decisions rather than plumbing:

1. **Identity is the id.** A source that changes its mind replaces its own toast instead of stacking
   a second one, so "installing…" becomes "building…" in the same pill. A status the app re-derives
   on every render cannot produce one toast per render.
2. **A source that goes quiet is forgotten**, which is what lets a second build announce its install
   step with exactly the same words as the first.
3. **The clock lives in an effect, not in a state updater.** Scheduling inside `setToasts` would
   schedule twice under React 18's `StrictMode`, which is a toast that vanishes after 2.5 s in
   development only.
4. **The live region exists before the news.** The stack is always mounted and carries
   `aria-live="polite"`; a region added together with its content is usually not announced at all.

## The inline notifications that were removed

Each of these described something a toast now describes, and each is asserted as *absent* by the
test named beside it:

| Removed | Where it was | Why | Test |
| --- | --- | --- | --- |
| `The Linux machine is booting, so the agent has no filesystem to work in yet.` | under the prompt box | the blue `machine` toast says it, wherever the user is looking | `tests/notification-dedup.test.tsx` (the composer is still `blocked`; the sentence is its tooltip) |
| `The Linux machine is stopped, so the build has nowhere to run yet.` | build strip, above the frame | the `machine` toast says it; the disabled hammer's tooltip keeps the reason for a mouse user | `tests/preview-pane.test.tsx` |
| `Installing dependencies in the guest…`, `Building the site in the guest…` | build strip | the blue `build` toast says it | `tests/preview-pane.test.tsx` |
| `Build <id> succeeded in 4.2 s.` | build strip | the green `build` toast says it; the frame appearing is the receipt | `tests/preview-pane.test.tsx` |
| `Starting the guest's server…`, `Reading 3 files out of the guest…` | preview toolbar | the blue `preview` toast says it — and unlike the toolbar, from either pane | `tests/preview-pane.test.tsx` |
| `` `bun run start` answered 200 … ``, the app's failure message | preview toolbar | the `app` toast says it; the toolbar keeps the `app` badge | `tests/preview-pane.test.tsx` |
| a green `worker` badge in the preview toolbar | preview toolbar | nothing: a worker-held build is the normal outcome, and the debug popover's `Preview` segment still says who holds it. The guest's amber badge stays, because a fallback is news even at eight seconds. | `tests/preview-pane.test.tsx`, `tests/preview-chrome.test.tsx` |
| a machine sentence in the terminal's empty state | terminal | the `machine` toast says it | `tests/notification-dedup.test.tsx` |

Two things were deliberately **kept**, because they are not notifications:

- **A failed build's reason**, in the strip above the frame. A toast leaves; a person debugging an
  install should not have to catch a sentence on its way out. The strip is otherwise gone.
- **A missing API key or model**, under the prompt box. Nothing *happened* — no notification can
  announce a setting that was never there — and the gap stays true until it is fixed.

## Evidence

- `tests/toast.test.ts` — the model: identity, tones, the cap, `newlyAnnounced`.
- `tests/notifications.test.ts` — every source and its colour, including the states that announce
  nothing.
- `tests/toast-view.test.tsx` — the markup: the live region, the tints, the pictograms, the named
  close button.
- `tests/toast-hook.test.tsx` (jsdom, fake timers) — five seconds is five seconds, a danger toast
  stays longer, the close button removes it immediately, and a re-raise restarts the clock.
- `tests/notification-dedup.test.tsx` — the removed sentences, asserted absent from the chat panel,
  the terminal and the preview strip, while the notification list still produces them.
- `tests/icon-buttons.test.tsx` — the close button carries a name, a tooltip, a 32 px target and a
  focus ring, like every other icon-only control.
- `scripts/ui-acceptance.ts` — in a real browser, the build's blue toast is read while it runs and
  its green one when it succeeds.
