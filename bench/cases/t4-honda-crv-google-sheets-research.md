---
task_id: t4-honda-crv-google-sheets-research
tier: T4
axes:
  - long-horizon
  - state-reading
  - browser-only
expected_actions: 110
max_steps: 150
infeasible: false
# Browser-only variant — everything happens inside Chrome (Sheets tab +
# Marketplace tab). Originally tried targetApp:"Google Chrome" for the
# 5-6× cropping speedup, but Run 9 v2 (2026-05-11) hit OOB-click
# validation rejecting clicks at (101,346) — likely Chrome's window
# bounds shifted between crop and validate (Playwriter attaches a
# separate DevTools window, or sheets.new resizes). Until OOB+crop
# decoupling lands, use "" to disable both. Trade-off: full-screen
# screenshots are larger so the brain may need to re-find UI elements
# more often, but at least clicks aren't rejected on stale bounds.
targetApp: ""
---

# T4 — Honda CR-V Marketplace Research → Google Sheets (browser-only)

Browser-only variant of `t4-honda-crv-spreadsheet-research`. Replaces
Microsoft Excel with Google Sheets so the entire flow stays inside
Chrome — no Spotlight launch, no app-handoff, no cropping confusion.
Bumped from 3 listings to 10 to stress long-horizon planning.

| Axis | How it bites |
|---|---|
| Long-horizon | ~110 atomic actions for 10 listings. max_steps=150 leaves room for retries. |
| State-reading | Must read price, year, mileage, location from each listing card or detail page. |
| Browser-only | Two Chrome tabs (Sheets + Marketplace). All control via vision + keyboard/mouse — no DOM API yet. |

The original Excel case stays in the suite for OS-level / multi-app
benchmarking once the Modal brain regression (Run 8, 2026-05-11) is
diagnosed and the targetApp opt-out path is fully validated.

## Task

> Help me research used 2010 Honda CR-Vs in the $3,000 to $5,000 price
> range on Facebook Marketplace. In Google Chrome, press cmd+t to open
> a new tab, then in the URL bar type `https://sheets.new` and press
> enter — this opens a fresh Google Sheet. Once the sheet loads, click
> cell A1 and type these headers across row 1, pressing Tab between
> each one: URL, Asking Price, Year, Mileage, Location, Condition Notes,
> Messaged. Then press cmd+t again and in the URL bar type the full URL
> `https://www.facebook.com/marketplace/search?query=2010%20honda%20crv&minPrice=3000&maxPrice=5000`
> and press enter. For at least 10 listings from the results, open the
> listing (cmd+click or middle-click to open in a new tab is fine), read
> the asking price (a plain number, e.g. `4200`, not `$4,200`), year,
> mileage, and location. Switch back to the Google Sheets tab (cmd+1
> through cmd+9 jump to specific tabs by position, or cmd+shift+a opens
> the tab search) and add one row per listing under the headers — fill
> URL, Asking Price, Year, Mileage, and Location. Leave Condition Notes
> and Messaged blank. When you've added all 10 rows, in the Google Sheets
> tab press cmd+a to select all the data, then cmd+c to copy it to the
> clipboard so I can verify the contents. Then emit DONE.

## Setup

```sh
set -e

# Make sure Chrome is open and frontmost. If it isn't running at all,
# launch it (the user typically has it open already with their Google
# session active).
osascript -e 'tell application "Google Chrome" to activate' >/dev/null 2>&1 || true
sleep 1

# Clear the clipboard so the scorer can detect whether the agent
# actually performed the final cmd+a / cmd+c step. Without this, a
# stale clipboard from a previous run could false-PASS the scorer.
osascript -e 'set the clipboard to ""'

# Sanity-check Chrome is the frontmost app
FRONT=$(osascript -e 'tell application "System Events" to name of first application process whose frontmost is true')
echo "frontmost_app=$FRONT"
echo "setup_done_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "expectations:"
echo "  - user is signed into google.com in this Chrome profile (else sheets.new lands on a sign-in page)"
echo "  - user is signed into facebook.com (else marketplace search returns a login wall)"
```

## Scoring

```sh
#!/bin/bash
# Clipboard-based scoring. When Google Sheets does cmd+a + cmd+c on a
# range, it puts a TAB-separated representation onto the clipboard
# (newlines between rows, tabs between columns). We parse that and
# validate row count + column shape + value plausibility.
#
# Authority: deterministic. Doesn't depend on the agent's self-reported
# outcome, doesn't depend on Google's API, doesn't need OAuth.

CLIPBOARD=$(pbpaste)

if [[ -z "$CLIPBOARD" ]]; then
  echo "FAIL: clipboard is empty — agent never executed the final cmd+a + cmd+c step (or the copy didn't land)"
  exit 1
fi

# Diagnostic: dump first 800 chars so failure analysis can see what was actually copied
echo "--- clipboard (first 800 chars) ---"
printf '%s' "$CLIPBOARD" | head -c 800
echo ""
echo "--- end clipboard preview ---"

# Total rows including header. Google Sheets terminates the last row
# with a newline, so wc -l is the row count.
TOTAL_ROWS=$(printf '%s' "$CLIPBOARD" | grep -c '^')

# Header row check: should contain at least URL, Price, Year, Location somewhere
HEADER_LINE=$(printf '%s' "$CLIPBOARD" | head -1)
HEADERS_OK=true
for term in URL Price Year; do
  if ! echo "$HEADER_LINE" | grep -qi "$term"; then
    HEADERS_OK=false
    echo "  diagnostic: header missing expected term '$term' — got: $HEADER_LINE"
  fi
done

# Data rows: skip header, count non-empty
DATA_ROWS=$(printf '%s' "$CLIPBOARD" | tail -n +2 | grep -c '[^[:space:]]')

if [[ "$DATA_ROWS" -lt 10 ]]; then
  echo "FAIL: only $DATA_ROWS data rows in clipboard, expected at least 10 (total rows incl. header: $TOTAL_ROWS)"
  exit 1
fi

# URL plausibility: at least 5 rows should have a marketplace URL
URL_OK=$(printf '%s' "$CLIPBOARD" | tail -n +2 | grep -cE "facebook\.com/marketplace")
if [[ "$URL_OK" -lt 5 ]]; then
  echo "FAIL: only $URL_OK data rows contain a facebook.com/marketplace URL, expected at least 5 (loose threshold for partial credit on 10 listings)"
  exit 1
fi

# Price plausibility: at least 5 rows should have a numeric price in [2500, 5500]
# (5% over/under the $3000-$5000 prompted range to allow agent flexibility)
PRICE_OK=0
while IFS=$'\t' read -r url price year mileage location rest; do
  # Strip $ and , just in case agent didn't strictly follow "plain number"
  clean_price="${price//\$/}"
  clean_price="${clean_price//,/}"
  clean_price="${clean_price// /}"
  if [[ "$clean_price" =~ ^[0-9]+$ ]] && (( clean_price >= 2500 && clean_price <= 5500 )); then
    PRICE_OK=$((PRICE_OK + 1))
  fi
done < <(printf '%s' "$CLIPBOARD" | tail -n +2)

if [[ "$PRICE_OK" -lt 5 ]]; then
  echo "FAIL: only $PRICE_OK data rows had a numeric price in [2500, 5500], expected at least 5"
  exit 1
fi

# Year plausibility: at least 5 rows should mention 2008-2012 (2010 ± 2)
YEAR_OK=$(printf '%s' "$CLIPBOARD" | tail -n +2 | grep -cE "(2008|2009|2010|2011|2012)")
if [[ "$YEAR_OK" -lt 5 ]]; then
  echo "FAIL: only $YEAR_OK data rows have a plausible year (2008-2012), expected at least 5"
  exit 1
fi

if [[ "$HEADERS_OK" != true ]]; then
  echo "WARN: header row didn't contain all expected terms but data rows look valid — graded as PASS with caveat"
fi

echo "PASS: $DATA_ROWS data rows, $URL_OK with marketplace URLs, $PRICE_OK with valid prices, $YEAR_OK with plausible years"
exit 0
```

## Notes for re-runs

- Chrome must be signed into both Google (for Sheets access) and Facebook
  (else Marketplace returns a login wall).
- The clipboard is cleared at setup, so a previous run's TSV won't
  false-PASS this run.
- The `-final.png` sidecar saves whatever Chrome state the agent ended
  in — useful for visual inspection when the deterministic scorer fails.
- Using `targetApp: "Google Chrome"` here is intentional and safe: this
  task NEVER leaves Chrome, so cropping is pure speedup with no risk of
  hiding state in a non-Chrome app.
