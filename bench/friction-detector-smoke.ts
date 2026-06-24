/**
 * Smoke: the FB account-safety friction detector (GAP A round-3 redesign).
 *
 * Pure unit assertions over the friction-breaker primitives — no bridge, no
 * Convex, no Chrome. Locks the round-3 adversarial redesign:
 *   - frictionForWriteResult is NON-MUTATING + ATTRIBUTES the phrase: a friction
 *     phrase is suppressed ONLY when the WHOLE phrase is in the user's own
 *     goal/payload, so it CANNOT fail open the way the old substring scrub did.
 *   - BENIGN content (user titles, payload notes, normal "under review") must
 *     NOT trip (frictionForWriteResult → null).
 *   - Genuine FB account friction MUST trip (frictionForWriteResult → phrase),
 *     including the round-3 fail-open regressions where a benign ONE-WORD title
 *     ("activity"/"account"/"limit") overlaps a single word of a multi-word
 *     on-page ban phrase.
 *   - detectFrictionPhrase (inner primitive) + isWriteJob stay correct.
 *
 * Run: npx tsx bench/friction-detector-smoke.ts   →  must print PASS.
 */
import {
  detectFrictionPhrase,
  frictionForWriteResult,
  isWriteJob,
  FRICTION_PHRASES,
  type BrowserJob,
  type BrowserJobExecutionResult,
} from "../src/agent/browser-jobs/ponder-executor";

let failed = false;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${name}`);
  if (!ok) failed = true;
}

function job(type: string, payload: Record<string, unknown> = {}): BrowserJob {
  return {
    _id: `smoke-${type}`,
    userId: "smoke",
    orgId: "smoke",
    platform: "facebook_marketplace",
    type,
    payload,
  };
}

/** Build a successful write outcome whose result echoes the given on-page text. */
function okResult(text: string): BrowserJobExecutionResult {
  return {
    success: true,
    result: { status: "success", via: "agent", payload: { finalText: text } },
  };
}

// ── detectFrictionPhrase (inner primitive) — unchanged behavior ─────────────
const benignPhrase: Array<[string, string]> = [
  ["normal publish 'being reviewed'", "this listing is being reviewed"],
  ["normal publish 'under review'", "Listing is under review"],
  ["empty string", ""],
];
for (const [name, text] of benignPhrase) {
  check(`detectFrictionPhrase BENIGN → null: ${name}`, detectFrictionPhrase(text) === null);
}
const matchPhrase: Array<[string, string]> = [
  ["security check prompt", "Please complete a security check to continue"],
  ["temporary restriction", "Your account has been temporarily restricted"],
  ["rate limit", "We limit how often you can post"],
  ["confirm it's you", "Please confirm it's you"],
  ["posting too fast", "You're posting too fast"],
  ["security checkpoint", "complete the security checkpoint"],
  ["unusual activity", "we noticed unusual activity"],
];
for (const [name, text] of matchPhrase) {
  check(`detectFrictionPhrase FRICTION → match: ${name}`, detectFrictionPhrase(text) !== null);
}

// ── frictionForWriteResult BENIGN: must return null (no breaker trip) ────────
// 1. create_listing {title:"Security Check Camera"} echoed in result → null.
check(
  "BENIGN → null: title 'Security Check Camera' echoed in result",
  frictionForWriteResult(
    okResult("Created the listing. Title: Security Check Camera. It is now live."),
    job("create_listing", { title: "Security Check Camera" }),
  ) === null,
);

// 2. create_listing {title:"Captcha Solver Tool"} echoed → null.
check(
  "BENIGN → null: title 'Captcha Solver Tool' echoed in result",
  frictionForWriteResult(
    okResult("Published. Title: Captcha Solver Tool. Done."),
    job("create_listing", { title: "Captcha Solver Tool" }),
  ) === null,
);

// 3. create_listing {description:'He said "we limit how often" to me'} where the
//    result echoes the description WITH QUOTES INTACT → null. Verifies the
//    escaping fix: plain-text haystack (no JSON.stringify) so the quoted user
//    span matches the userBlob and is attributed/suppressed.
{
  const desc = 'He said "we limit how often" to me';
  check(
    "BENIGN → null: quoted description 'we limit how often' (escaping fix)",
    frictionForWriteResult(
      okResult(`Created the listing. Description: ${desc}. Posted.`),
      job("create_listing", { description: desc }),
    ) === null,
  );
}

// 4. default/explore_session job {payload:{note:"we limit how often you can post
//    here"}} echoed in result → null. Field-coverage fix: the OLD scrub only
//    looked at title/description/message/text; `note` was missed. Here the goal
//    (default branch) JSON-stringifies the whole payload, and the userBlob
//    collects ALL payload string leaves, so `note` is attributed.
check(
  "BENIGN → null: default-type payload {note} field coverage",
  frictionForWriteResult(
    okResult("Ran the session. Page text: we limit how often you can post here."),
    job("explore_session", { note: "we limit how often you can post here" }),
  ) === null,
);

// 5. send_message {buyer:"we limit how often"} echoed via goal → null. The buyer
//    name interpolates into goalForJob (send_message goal mentions the buyer),
//    so the phrase is in the userBlob → attributed/suppressed.
check(
  "BENIGN → null: send_message buyer name in goal",
  frictionForWriteResult(
    okResult("Opened the conversation with we limit how often and sent it."),
    job("send_message", { buyer: "we limit how often", message: "hi" }),
  ) === null,
);

// 6. healthy publish result containing "this listing is being reviewed" → null.
check(
  "BENIGN → null: healthy 'this listing is being reviewed'",
  frictionForWriteResult(
    okResult("Published. this listing is being reviewed by Facebook."),
    job("create_listing", { title: "Red Bicycle" }),
  ) === null,
);

// ── frictionForWriteResult FRICTION: must return the phrase (fail-open regressions) ──
// 7. create_listing {title:"activity"} with on-page "unusual activity ... suspicious
//    activity on your account" → MUST trip. ROUND-3 FAIL-OPEN CASE: the old scrub
//    blanked the word "activity" out of the REAL FB text, hiding the ban. The
//    multi-word phrase is NOT in the userBlob (just "activity" is), so it trips.
check(
  "FRICTION → trips: title 'activity' vs on-page 'unusual activity' [round-3 fail-open]",
  frictionForWriteResult(
    okResult("We noticed unusual activity and suspicious activity on your account"),
    job("create_listing", { title: "activity" }),
  ) !== null,
);

// 8. update_listing {title:"account"} with result "Your account has been
//    restricted" → MUST trip (one-word "account" can't suppress the phrase).
check(
  "FRICTION → trips: title 'account' vs 'account has been restricted'",
  frictionForWriteResult(
    okResult("Your account has been restricted"),
    job("update_listing", { title: "account" }),
  ) !== null,
);

// 9. send_message {message:"limit"} with result "We limit how often you can post"
//    → MUST trip (one-word "limit" can't suppress "we limit how often").
check(
  "FRICTION → trips: message 'limit' vs 'we limit how often'",
  frictionForWriteResult(
    okResult("We limit how often you can post"),
    job("send_message", { message: "limit", buyer: "Sam" }),
  ) !== null,
);

// 10. result "Please complete a security check to continue" with NO user overlap
//     → MUST trip.
check(
  "FRICTION → trips: 'complete a security check' (no user overlap)",
  frictionForWriteResult(
    okResult("Please complete a security check to continue"),
    job("create_listing", { title: "Red Bicycle", price: "40" }),
  ) !== null,
);

// Friction on the FAILURE path: phrase carried on the synthesized outcome's
// error/result, not in the user payload → must trip.
check(
  "FRICTION → trips: failure outcome error 'posting too fast'",
  frictionForWriteResult(
    { success: false, error: "FB responded: You're posting too fast. Slow down." },
    job("create_listing", { title: "Red Bicycle" }),
  ) !== null,
);

// ── ROUND-4 leaf-join fail-open regressions: per-leaf attribution must NOT fuse
//    adjacent fields into a phrase no single field contained. These MUST trip. ──
// 11. {title:"account has been", condition:"restricted"} vs on-page "your account
//     has been restricted". A joined userBlob ("account has been restricted")
//     would suppress the REAL ban (fail open); per-leaf can't fuse → trips.
check(
  "FRICTION → trips: leaf-join title+condition vs 'account has been restricted' [round-4 fail-open]",
  frictionForWriteResult(
    okResult("Your account has been restricted"),
    job("create_listing", { title: "account has been", condition: "restricted" }),
  ) !== null,
);

// 12. {title:"Posting Too", description:"Fast"} vs "you're posting too fast".
check(
  "FRICTION → trips: leaf-join title+description vs 'posting too fast'",
  frictionForWriteResult(
    okResult("You're posting too fast. Slow down."),
    job("create_listing", { title: "Posting Too", description: "Fast" }),
  ) !== null,
);

// 13. send_message split across {buyer:"we limit", message:"how often"} vs the
//     on-page "we limit how often" → must trip (fields can't fuse).
check(
  "FRICTION → trips: leaf-join buyer+message vs 'we limit how often'",
  frictionForWriteResult(
    okResult("We limit how often you can post"),
    job("send_message", { buyer: "we limit", message: "how often" }),
  ) !== null,
);

// 14. CONTROL — per-leaf still SUPPRESSES when ONE field legitimately holds the
//     whole phrase: {title:"account has been restricted"} echoed → null.
check(
  "BENIGN → null: single field holds whole phrase 'account has been restricted'",
  frictionForWriteResult(
    okResult("Created. Title: account has been restricted. Live."),
    job("create_listing", { title: "account has been restricted" }),
  ) === null,
);

// ── isWriteJob: WRITE types true, READ/sync types false ─────────────────────
const writeTypes = [
  "create_listing",
  "update_listing",
  "delete_listing",
  "send_message",
  "propose_slots",
  "confirm_appointment",
];
for (const t of writeTypes) check(`isWriteJob('${t}') === true`, isWriteJob(job(t)) === true);

const nonWriteTypes = ["scrape_inventory", "check_messages", "sync_listing_state"];
for (const t of nonWriteTypes) check(`isWriteJob('${t}') === false`, isWriteJob(job(t)) === false);

// Guard: the phrase list must not contain bare single-word tokens that overlap
// benign content (the whole point of the GAP A narrowing — every phrase must be
// multi-word/specific so attribution can never fail open on a one-word title).
const forbiddenBare = ["suspicious", "security check", "checkpoint", "captcha"];
for (const bare of forbiddenBare) {
  check(`FRICTION_PHRASES has no bare '${bare}'`, !FRICTION_PHRASES.includes(bare));
}

console.log(failed ? "\n=== FAIL — friction detector ===" : "\n=== PASS — friction detector ===");
process.exit(failed ? 1 : 0);
