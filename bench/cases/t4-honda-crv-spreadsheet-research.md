---
task_id: t4-honda-crv-spreadsheet-research
tier: T4
axes:
  - multi-app-handoff
  - state-reading
  - long-horizon
  - modal-dialog
  - grounding-precision
expected_actions: 35
max_steps: 70
infeasible: false
# Multi-app task: cropping to ANY single app (Chrome OR Excel) breaks
# the handoff. Auto-detect would lock to "Google Chrome" (first match)
# and Excel would be invisible behind Chrome's crop forever — diagnosed
# 2026-05-11 Run 6. Empty string disables both auto-detect and cropping.
targetApp: ""
---

# T4 — Honda CR-V Marketplace Research → Excel Spreadsheet

The annoying-real-life-research task. The agent must research used cars
on Facebook Marketplace and produce a structured spreadsheet that a
human could actually act on. It stacks five difficulty axes simultaneously:

| Axis | How it bites |
|---|---|
| Multi-app handoff | Chrome ↔ Excel, switched 3-6 times. State-loss on any focus glitch. |
| State-reading | Must READ price, year, mileage, location from each listing card or detail page. |
| Long-horizon | ~35-40 atomic actions for a 3-listing target. Default 50-step budget is tight. |
| Modal-dialog | Excel's Save dialog. FB's "see more" interstitials. Possible login wall. |
| Grounding precision | FB Marketplace listing cards are dense; sub-50px price/mileage labels are common. |

This is the closest analog to the macOSWorld multi-app subset where field
SOTA is 3.7%. Field-honest expectation for this case on Holo3-35B with
our current loop: **<5% PASS** until model + scaffolding improvements land.
The case exists as a **stretch target** and a **regression canary** — if
the suite is ever passing this reliably, we've made real progress.

## Task (verbatim prompt)

> Help me research used 2010 Honda CR-Vs in the $3,000 to $5,000 price
> range on Facebook Marketplace. Open Microsoft Excel and create a new
> spreadsheet with these column headers in row 1: URL, Asking Price,
> Year, Mileage, Location, Condition Notes, Messaged. Save the file to
> the Desktop with the name `honda-crv-research.xlsx`. Then switch to
> Google Chrome and navigate to
> `https://www.facebook.com/marketplace/search?query=2010%20honda%20crv&minPrice=3000&maxPrice=5000`.
> For at least 3 listings from the results, open the listing, read the
> asking price (a plain number, e.g. `4200`, not `$4,200`), year, mileage,
> and location. Switch back to Excel and add one row per listing under
> the headers, filling URL, Asking Price, Year, Mileage, and Location.
> Leave Condition Notes and Messaged blank. Save the spreadsheet again
> when you've added all the rows.

## Surface

`other` — multi-app. Auto-detect will pick up either `Microsoft Excel`,
`Google Chrome`, or `Safari` depending on which app the prompt mentions
first per `inferTargetApp` (currently it'll see "Microsoft Excel" first).
The loop's `raise+recapture` (commit `1976d6c`) handles mid-task app
switching.

## Setup

```sh
# Remove any prior artifact so the scorer can't be fooled by a
# leftover file from a previous run.
rm -f "$HOME/Desktop/honda-crv-research.xlsx"

# Sanity-check Excel is installed and AppleScript-reachable.
EXCEL_VERSION=$(osascript -e 'tell application "Microsoft Excel" to version' 2>&1 || echo "ERROR")
echo "excel_version=$EXCEL_VERSION"
if [[ "$EXCEL_VERSION" == "ERROR" ]] || [[ "$EXCEL_VERSION" == *"-1728"* ]]; then
  echo "SETUP_FAIL: Microsoft Excel not installed or not AppleScriptable"
  exit 0
fi

# Quit Excel if it's open so the agent starts from a clean state
# (otherwise an existing workbook could fool the scorer if the agent
# never saves the new one).
osascript -e 'tell application "Microsoft Excel" to quit saving no' 2>/dev/null
sleep 1

# Ensure Chrome is frontmost so the agent can pivot to it without
# fighting the activation flake we hit in the t4-safari pilot. The
# first run (2026-05-11 14:08Z) found Chrome on a random FB photo
# page; the brain hallucinated a "password reminder dialog" on the
# black-tshirt photo and bailed in 3 steps. Pre-navigating Chrome
# to about:blank gives the agent a deterministic clean slate so the
# failure mode reflects task difficulty, not setup-state randomness.
osascript -e 'tell application "Google Chrome" to activate'
osascript -e 'tell application "Google Chrome" to set URL of active tab of front window to "about:blank"' 2>/dev/null \
  || echo "WARN: could not navigate Chrome to about:blank (Automation perm? continuing anyway)"
sleep 1

# Probe whether the user is actually logged into Facebook. We can't
# inspect cookies without breaching the session, so we just open the
# marketplace URL and let the agent deal with a login wall if one
# appears. Document the FB account expectation in run notes.
echo "setup_done_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "facebook_login_expectation=user must be logged into facebook.com in the frontmost Chrome profile; otherwise marketplace search returns a login wall"
```

## Scoring

```sh
TARGET_FILE="$HOME/Desktop/honda-crv-research.xlsx"

if [[ ! -e "$TARGET_FILE" ]]; then
  echo "FAIL: no spreadsheet at $TARGET_FILE"
  exit 0
fi

# Read structured data via Excel AppleScript. Notes:
# - We open the file fresh (vs reading the running Excel doc) so a
#   crash / restart / save-dialog-stuck mid-run can still be scored
#   from the saved bytes on disk.
# - We look up columns by HEADER NAME (URL, Price, Year), not by
#   position — the agent might type them in a different order than
#   the prompt specified, and a generous scorer accepts that as long
#   as the data semantics are right.
# - Empty cells come back as missing value; we coerce to "" before
#   any string ops.
# - Price validation: numeric and within [2500, 5500]. The 5% tolerance
#   over the prompted $3k-$5k range accepts a slightly-over-range
#   listing the agent honestly recorded (FB filter isn't strict).
# - URL validation: must contain "facebook.com/marketplace" —
#   accepts both ?ref=app_tab and /item/<id> URLs.
# - Year validation: contains "2010" or numeric in [2008, 2012].

VERDICT=$(osascript <<APPLESCRIPT
tell application "Microsoft Excel"
  try
    set theWorkbook to open workbook workbook file name "$TARGET_FILE"
    set theSheet to active sheet of theWorkbook
    set usedR to used range of theSheet
    set rowCount to count rows of usedR
    set colCount to count columns of usedR

    if rowCount < 2 then
      return "FAIL: spreadsheet has " & rowCount & " rows; need header + at least 1 data row"
    end if
    if colCount < 5 then
      return "FAIL: spreadsheet has " & colCount & " columns; need at least 5 (URL, Price, Year, Mileage, Location)"
    end if

    -- Read the header row into a list
    set headerValues to value of (rows 1 of usedR)
    -- AppleScript returns a list-of-lists; flatten if needed
    if class of headerValues is list then
      if (count of headerValues) > 0 then
        if class of (item 1 of headerValues) is list then
          set headerValues to item 1 of headerValues
        end if
      end if
    end if

    set urlCol to 0
    set priceCol to 0
    set yearCol to 0
    repeat with c from 1 to (count of headerValues)
      set h to item c of headerValues
      if h is missing value then set h to ""
      set hStr to (h as string)
      if hStr contains "URL" or hStr contains "url" or hStr contains "Url" then set urlCol to c
      if hStr contains "Price" or hStr contains "price" then set priceCol to c
      if hStr contains "Year" or hStr contains "year" then set yearCol to c
    end repeat

    if urlCol = 0 then return "FAIL: no URL column header found in row 1"
    if priceCol = 0 then return "FAIL: no Price column header found in row 1"

    -- Validate each data row
    set validRows to 0
    set rowDiagnostics to ""
    repeat with r from 2 to rowCount
      set urlVal to value of cell r of column urlCol of theSheet
      set priceVal to value of cell r of column priceCol of theSheet
      set yearVal to ""
      if yearCol > 0 then set yearVal to value of cell r of column yearCol of theSheet

      if urlVal is missing value then set urlVal to ""
      if priceVal is missing value then set priceVal to 0
      if yearVal is missing value then set yearVal to ""

      set urlStr to (urlVal as string)
      set urlOk to (urlStr contains "facebook.com/marketplace")

      set priceOk to false
      try
        set priceNum to priceVal as real
        if priceNum >= 2500 and priceNum <= 5500 then set priceOk to true
      end try

      set yearOk to true
      if yearCol > 0 then
        set yearOk to false
        set yearStr to (yearVal as string)
        if yearStr contains "2010" then set yearOk to true
        try
          set yearNum to yearVal as integer
          if yearNum >= 2008 and yearNum <= 2012 then set yearOk to true
        end try
      end if

      if urlOk and priceOk and yearOk then
        set validRows to validRows + 1
      else
        set rowDiagnostics to rowDiagnostics & " row" & r & "[url=" & urlOk & " price=" & priceOk & " year=" & yearOk & "]"
      end if
    end repeat

    if validRows ≥ 3 then
      return "PASS: " & validRows & " valid listing rows (rowCount=" & (rowCount - 1) & ")"
    else if validRows ≥ 1 then
      return "FAIL: partial — " & validRows & "/3 valid rows;" & rowDiagnostics
    else
      return "FAIL: 0 valid rows (rowCount=" & (rowCount - 1) & ");" & rowDiagnostics
    end if
  on error errMsg number errNum
    return "FAIL: scoring error " & errNum & " — " & errMsg
  end try
end tell
APPLESCRIPT
)

echo "$VERDICT"
```

PASS condition: AppleScript returns a line starting with `PASS:` AND that
line counts ≥3 valid rows. Valid row = URL contains `facebook.com/marketplace`
AND Price is numeric in `[2500, 5500]` AND Year is `2010` or numeric in
`[2008, 2012]`.

## Why this is hard (and what each axis actually exposes)

**Multi-app handoff**: The agent must switch Chrome ↔ Excel at minimum 4
times (open Excel → save → switch to Chrome → research listing → switch
to Excel → record → switch to Chrome → next). Every switch is an
opportunity for `targetApp` cropping to point at the wrong app's
window. The `raise+recapture` fix (`1976d6c`) helps but doesn't fully
solve it — when the brain emits `key cmd+tab` we have no way to predict
which app comes forward, and the screenshot capture is racy against
the OS animation.

**State-reading**: FB Marketplace listing detail pages put the price in
a big bold span, mileage in a "Details" section that may require
scrolling, location in a tiny line below the listing title. The model
needs to actually READ them rather than guess. The grounding model
isn't an OCR model; it's a click-position model. So this axis is
adversarial to our current architecture.

**Long-horizon**: The happy-path action count is ~35 atomic steps for
3 listings. The default `MAX_STEPS=50` budget is tight; this case
specifies `max_steps: 70` in frontmatter to give breathing room for
recovery from one or two anti-loop bails. If the case ever passes
reliably under 50 steps, we can tighten it.

**Modal-dialog**: Excel's Save dialog is a native macOS file picker.
The agent must (a) type the filename, (b) navigate to Desktop in the
sidebar (cmd+D shortcut exists but small models often don't use it),
(c) press Save. Hitting Cancel by accident kills the artifact.

**Grounding precision**: A FB Marketplace listing card on a 1440px-wide
results page is roughly 280×240px. The Price label inside is ~80×24px.
That's borderline for our `300px size threshold` heuristic — the page
itself is wide, so we crop to the Chrome window, but the relevant
text is small.

## Expected happy path

```
Phase A — Excel setup (8 actions)
  1. press cmd+space               (Spotlight)
  2. type "Excel"
  3. press enter                    (Excel launches)
  4. press cmd+N                    (new workbook — Excel may open one
                                     automatically; brain should skip
                                     if so)
  5. type "URL\tAsking Price\tYear\tMileage\tLocation\tCondition Notes\tMessaged"
                                    (tab-separated headers fill row 1)
  6. press cmd+s                    (Save dialog opens)
  7. type "honda-crv-research"      (filename)
  8. press cmd+d                    (Desktop sidebar shortcut), enter

Phase B — Chrome navigate (3 actions)
  9. press cmd+tab to Chrome
  10. press cmd+l                   (URL bar)
  11. type "https://www.facebook.com/marketplace/search?query=2010%20honda%20crv&minPrice=3000&maxPrice=5000" + enter

Phase C — Per listing (×3, ~8 actions each = 24 total)
  12. click first listing card
  13. wait for detail page
  14. press cmd+l, cmd+c            (copy URL to clipboard)
  15. read price/year/mileage/location from screenshot
  16. press cmd+tab to Excel
  17. click row 2 column A          (first data row, URL cell)
  18. press cmd+v                   (paste URL)
  19. press tab, type price, tab, year, tab, mileage, tab, location
  20-29. repeat for listings 2 and 3 (and back to Chrome each time)

Phase D — Save (1 action)
  30. press cmd+s

Total: ~33 actions. With anti-loop recovery margin → 35-40 actually
observed.
```

The agent will almost certainly NOT follow this exact path. The
realistic-failure-mode list below documents the common deviations.

## Realistic failure modes (what to expect in early runs)

1. **Login wall on FB Marketplace**: User isn't logged into Facebook
   in the active Chrome profile, marketplace URL redirects to
   `facebook.com/login`. Brain wastes steps trying to dismiss it.
   Mitigation: setup script documents the precondition.

2. **Excel auto-saves to iCloud Drive, not Desktop**: macOS Sonoma+
   defaults Office save target to iCloud Drive root. Brain types
   `honda-crv-research` but the file lands in iCloud, not Desktop.
   Scorer correctly says FAIL (no file at expected path). The user
   needs to either pre-configure Excel's default save location or
   the agent needs to actively select Desktop in the sidebar.

3. **Brain types price as `$4,200` instead of `4200`**: Excel stores
   the string `$4,200` as text, not a number. Scorer's `value as
   real` coercion fails on text. Row scored invalid. Mitigated by
   the prompt explicitly saying "a plain number, e.g. 4200, not
   $4,200".

4. **Brain pastes URL into wrong cell**: Without bounds-validation
   on Excel cells (we don't have it; only `targetApp` window-level
   bounds), the brain may paste into the wrong row. Sub-150px cell
   targets are below our grounding precision floor.

5. **Brain skips listings and fabricates rows**: The grounding model
   doesn't actually see the listing details well — it may emit
   plausible-looking numbers without having read the screenshot.
   Scorer can't detect this directly; the only signal is that the
   URLs won't match `/item/<numeric-id>` patterns from real
   marketplace listings. Future enhancement: scorer fetches each
   recorded URL and verifies it's a real listing (depends on FB ToS
   though — probably not worth the engineering complexity).

6. **The brain emits "cmd+tab" but Chrome doesn't come forward**:
   cmd+tab is order-dependent (most-recent-app), and the agent has
   no model of the app-switcher state. Sometimes it ends up in
   Finder or some other background app. Recovery: brain emits
   another cmd+tab or activates by name. Anti-loop guards bail if
   this loops more than 3 times.

7. **The brain saves the file mid-task (before all rows added) and
   forgets to save again at the end**: The scorer reads the saved
   file on disk; if the agent has typed rows that aren't yet saved,
   they're invisible to the scorer. Mitigation: explicit "Save the
   spreadsheet again when you've added all the rows" in the prompt.

## Recommended run procedure

```sh
# 1. Verify bridge SHA matches HEAD (CLAUDE.md post-deploy stanza).
holo3_version            # via Claude or `curl http://127.0.0.1:7900/version`

# 2. Pre-login: open Chrome and verify facebook.com is logged in.
open -a "Google Chrome" "https://www.facebook.com/marketplace"

# 3. Run.
npx tsx bench/run.ts t4-honda-crv-spreadsheet-research

# 4. (optional) Watch the bridge log for anti-loop bails:
npm run dev 2>&1 | tee bench/results/dev-server-$(date +%s).log
```

## Prior runs

| Date | Commit | Outcome | Wall | Steps | Notes |
|---|---|---|---|---|---|
| 2026-05-11 14:08Z | `faaffd8` (bridge stale @ `cab0c42`) | **FAIL** (deterministic) / `exhausted` (agent) | 3m38s | 3 | Brain hallucinated a "Facebook password reminder dialog" on a Chrome page that was actually a FB photo viewer (`facebook.com/photo/?fbid=…`). Emitted "click OK" 3× with grounder coords scattering across the screen (413,838 → 708,598 → 419,838). Coord-scatter anti-loop guard bailed at step 3 — exactly its job. Never reached Excel, never made it to marketplace, no spreadsheet produced. See `bench/results/t4-honda-crv-spreadsheet-research-2026-05-11T14-11-43-803Z.json` + `-final.png`. |
| 2026-05-11 14:19Z | `4d270f0` (bridge fresh) | **FAIL** (deterministic) / `exhausted` (agent) | 44s | 3 | Clean-slate setup worked — Chrome on `about:blank`. New failure: brain emitted *"click on the close button of the current tab to close it"* 3× at the same coord (573, 151) with no screen change. Same-action anti-loop guard bailed cleanly. The brain ignored the prompt's first instruction (*"Open Microsoft Excel"*) and instead tried to "tidy up" Chrome tabs (there was a stale "Little Amps Coffee Roaster" tab still open). **Task-ordering failure** — brain reacted to visible Chrome state instead of following the prompt's phase order. |
| 2026-05-11 15:05Z | `f2240a9` (TASK PRIORITY preamble) | **FAIL** (deterministic) / `exhausted` (agent) | 66s | 7 | **First time brain attempted the correct first action.** Steps 1-2: `cmd+space` → `type "Microsoft Excel" + enter` — exactly what the preamble's rule #1 said to do (Spotlight-open the app named first in the task). But after Spotlight fired, the next screenshot still showed Chrome (Excel hadn't appeared in the frame yet — either it was still loading or the screenshot raced ahead). Brain then emitted *"click the Google Chrome window to bring it to the foreground"* 3× at sub-pixel-different coords, then pressed enter, then wait/wait. No-op-spam anti-loop guard bailed at step 7. **Progress**: 7 steps vs Run 2's 3 steps. The preamble works for the OPENING; the regression is downstream of Spotlight launch timing. |

### Run 3 takeaways (2026-05-11 15:05Z)

1. **TASK PRIORITY preamble delivered measurable behavior change.** Run 3's first two actions were `cmd+space` → `type "Microsoft Excel" + enter`. That's the textbook Spotlight-open sequence. Runs 1 and 2 never even attempted to open Excel — they got distracted by the visible Chrome state. The preamble's rule #1 ("If the task says 'Open <App>' and <App> isn't visible: your FIRST action is to open it via Spotlight") worked.

2. **New downstream failure: post-Spotlight screenshot timing race.** After `type "Microsoft Excel" + enter`, the next screenshot captured Chrome (about:blank with 3 tabs), not Excel. Two possibilities: (a) Excel hadn't finished launching at screenshot-capture time, or (b) Excel did launch but its window hasn't received focus yet, leaving Chrome frontmost in the screenshot. The brain then emitted *"click the Google Chrome window to bring it to the foreground"* — exactly the wrong direction; Excel needed time, not refocus.

3. **No-op-spam guard caught the recovery loop**: after the Chrome-foreground clicks didn't change anything, brain emitted press-enter → wait → wait. Three consecutive no-ops triggered `4defce2`'s wait-spam guard at step 7. Saved another 40+ steps of dead time.

4. **Forward progress is real**: Run 2 = 3 steps, Run 3 = 7 steps. The system spent twice as long actually attempting the task before bailing. That's not a PASS but it's the right direction.

5. **The fix surface for the next iteration is clear**:
   - **Post-Spotlight settle delay**: After `cmd+space` + type + enter, the loop could wait 1500-3000ms before the next screenshot to give the launched app time to appear. This is a per-action settle, not a global one.
   - **Or: an explicit "wait for app frontmost" primitive**: brain could emit `wait_for_app Microsoft Excel` and the executor polls `System Events` for `frontmost is true` before continuing. Would eliminate the timing race entirely.
   - **Or: brain prompt addition**: "After you launch an app via Spotlight, the screenshot may briefly still show the previous app. Don't react to it — wait one step and re-observe."

### Run 2 takeaways (2026-05-11 14:19Z)

1. **Brain doesn't follow task ordering.** The prompt clearly says "Open Microsoft Excel **and** create a new spreadsheet ... **Then** switch to Google Chrome ...". With Chrome already visible on screen (about:blank + a stale tab), the brain decided to clean up Chrome first instead of opening Excel. This is a phase-ordering failure that's distinct from Run 1's hallucination — the brain literally chose the wrong starting subtask.

2. **Same-action anti-loop guard caught it cleanly** at step 3. The recovery prompt ("re-observing state and asking the brain to change approach") was emitted but the brain emitted the EXACT SAME thought after recovery — same-action guard bailed. Together with Run 1's coord-scatter bail, that's two complementary guards working as designed.

3. **Both Run 1 and Run 2 have the same root cause**: the brain weights visible screen state over the prompt's intended sequence. Run 1: hallucinated UI on a photo page. Run 2: cleaned up tabs instead of opening Excel. In both cases, the FIRST instruction of the task (open Excel) was never executed.

### Run 1 takeaways (2026-05-11)

1. **Setup state randomness drove the failure, not task difficulty.** Chrome was already on a Facebook photo page (a black t-shirt photo) when the agent started. The brain's first thought was "click OK on the Facebook password reminder dialog" — a dialog that didn't exist. The grounder then hallucinated coords for the imaginary button. **Mitigation landed**: setup now pre-navigates Chrome to `about:blank` so the agent starts from a deterministic clean slate.

2. **Two-layer hallucination**: brain misread the screen, AND the grounder fabricated click positions for the imaginary UI element. Each layer compounds: a hallucinated thought produces an action verb the grounder must localize, and lacking the target the grounder picks plausible-looking pixels. The coord-scatter anti-loop guard (commit `4956638`) is the only thing that caught it — without that guard, this would have run the full 50-step budget at ~70s/step = 60+ min of inference burning on a nonexistent dialog.

3. **The single-targetApp architectural concern wasn't tested.** Agent never made it past Chrome; Excel was never opened. We still don't have data on whether the auto-detect → Chrome lock breaks during Phase A Excel work.

4. **Result JSON bloat fixed**: the run produced a 1.2 MB JSON because `finalScreenshotBase64` was inlined. Harness now auto-strips it to a sidecar `*-final.png` and references the path + sha256 in the JSON. Future result files stay <10 KB.

5. **Bridge SHA staleness was inconsequential here**: the bridge was on `cab0c42` (missing `maxSteps` plumbing) but the agent bailed at step 3, well below either ceiling. For Run 2 the SHA gap doesn't need to be closed before retrying — though closing it gives us the 70-step budget if Run 2 makes it past Phase A.

### What we'll learn from Run 2 (clean-slate setup)

With Chrome pre-navigated to `about:blank`:

- Whether the brain prioritizes the prompt's "Open Excel first" instruction or the visible Chrome window.
- Whether the brain can complete Phase A (Excel setup) at all — that's
  a single-app subtask in its own right and probably the cleanest
  signal of long-horizon viability.
- The actual cost in steps of one Chrome↔Excel switch (we estimate
  ~3 for the brain to register the switch and re-orient).
- Whether the existing FB Marketplace URL fast-path (`cab0c42`,
  `1b8cb02`) suffices for the filtered search URL, or if the brain
  trips on the `&minPrice=3000` query string.
- Whether the Save dialog gets navigated to Desktop or auto-saves to
  iCloud.
- The brain's behavior when it hits a state it can't read (e.g.
  mileage not visible without scrolling).

Each of those is a separate optimization workstream. The case exists
to surface them, not to be a graduation gate.
