# Debug Log

## 1. `querySrv ECONNREFUSED` — Atlas connection

**Symptom**
Connection failed with no MongoDB error at all — the driver never reached the server.

**Assumed**
Wrong password or firewall.

**Actually**
The error named the syscall, so it was DNS. `mongodb+srv://` needs an SRV record lookup, and the campus resolver refused that query type specifically. Ordinary A-record lookups worked fine the whole time (npm installed without issue).

**Found by**
`nslookup -type=SRV _mongodb._tcp.<cluster> 8.8.8.8` — naming the DNS server directly bypassed the campus resolver and returned the records immediately.

**Fixed by**
Resolved the SRV and TXT records manually, then built a plain `mongodb://` string with the three hosts inline.

**Tradeoff**
Lost DNS-based service discovery. The connection string is now a snapshot — if Atlas moves those nodes, it breaks and I redo the lookup.

---

## 2. 500 + stack trace on a request missing `type`

**Symptom**
POST without `type` returned 500 with a full stack trace and absolute file paths.

**Assumed**
Needed a try/catch in the route.

**Actually**
No validation at the boundary. Mongoose threw a ValidationError, Express treated it as an unhandled error, and unhandled errors default to 500 — the server reported a client mistake as its own failure.

Two separate bugs:
- Wrong status code (500 instead of 400)
- Information disclosure — internal file paths sent to the client

**Fixed by**
zod `safeParse` returning 400 before the service call, plus a four-parameter error handler so nothing leaks.

**Concept**
Validate at the edge. After validation, use `result.data`, not `req.body`.

**Expect the follow-up:** *Why validate in zod when Mongoose already validates?*
Different jobs. Mongoose protects the database; zod protects the boundary. Zod runs before anything touches the DB, produces a 400 with a useful message, and applies defaults. Also, `findOneAndUpdate` skips Mongoose validators by default — so DB-layer validation isn't a guarantee you can lean on. That bites at stage 2.

---

## 3. Same job claimed and completed twice — find-then-save race

**Symptom**
Ran three worker processes against the same queue. Submitted a burst of jobs. One job ID — `6a91d98bf...f61` — showed up as `claimed` and `completed` in two different terminals.

**Assumed**
The code looked fine — `findOne` then `job.save()` is a normal read-modify-write pattern.

**Actually**
That's exactly the problem: it's *two* separate round-trips to MongoDB, not one. `findOne({status:"pending"})` and `.save()` aren't atomic together. Two workers can both call `findOne` in the same narrow window, both get the same document back before either has written `status: "claimed"`, and both proceed to run the job. No error, no crash — just silent duplicate execution.

Reproducing it took volume — 3 jobs submitted at once mostly landed on one worker (its poll interval happened to line up first). Bumping to a 15-job burst exposed the actual collision.

**Fixed by**
Replaced the two-step find-then-save with a single atomic `findOneAndUpdate`:

```javascript
const job = await Job.findOneAndUpdate(
    { status: "pending" },
    { $set: { status: "claimed", claimedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
)
```

MongoDB resolves the match-and-flip as one atomic operation server-side. If two workers fire this at the same instant, only one query actually matches `status: "pending"` and updates it — the other's query simply finds nothing left to match and returns `null`.

**Concept**
Read-then-write across two calls is never safe under concurrency, no matter how small the code looks. Anything that must be exclusive — "exactly one worker gets this job" — needs to happen as a single atomic database operation, not application-level logic wrapped around two separate calls.

**Expect the follow-up:** *Why not just check `if (job.status === "pending")` before saving?*
Doesn't help — that check happens in application memory, after the read, which is exactly the same gap that caused the bug. Both workers can pass that check with stale data before either writes. Atomicity has to happen at the database layer, not in an `if` statement.

---

## 4. Retry logic wasn't triggering — two separate bugs stacked together

**Symptom**
Submitted a job with `payload: { shouldFail: true }`, expecting it to fail and retry. Instead it just completed normally, every time — no matter how many times I re-tested.

**Assumed**
The retry/dead-letter code itself was wrong.

**Actually — bug one:** the code that was supposed to *cause* the failure was never written. The inner try block did `sleep(500)` then went straight to `status = "completed"` — there was no check on `job.payload.shouldFail` anywhere, so nothing ever threw, so the catch block (retry/dead-letter logic) never ran. The retry logic was correct; it just had no way to be triggered.

**Actually — bug two, found right after fixing the first one:** the fix still didn't seem to work, and the logs showed `claimed` printed *twice* for the same job before `completed`. That double-log was a signature — it matched an *older* version of the file, not the one just edited. A leftover `node src/worker/worker.js` process from an earlier test was still running in the background. Since the claim query is atomic and first-come-first-served, the stale process — running old code without the `shouldFail` check — kept winning the race against the freshly restarted one, so the fix appeared to silently not apply no matter how many times the file was edited.

**Found by**
Comparing the exact log output against what the current file *should* print. The duplicate `claimed` line was the giveaway that different code was executing than what was on disk.

**Fixed by**
1. Added the missing check before marking a job complete:
```javascript
if (job.payload && job.payload.shouldFail) {
    throw new Error("simulated failure")
}
```
2. Killed every running node process before restarting, to guarantee only the current file's code was live:
```powershell
Get-Process node | Stop-Process -Force
node src/worker/worker.js
```

**Concept**
Editing a file does nothing to a process already running in memory — Node doesn't hot-reload. When a fix "doesn't work" but the code looks obviously correct, check whether the process actually restarted before doubting the logic. Log output that doesn't match the current file's shape (extra lines, different wording) is a strong signal an old process is still alive somewhere.

**Expect the follow-up:** *Why did the atomic claim let the old process win instead of erroring?*
It's not supposed to error — `findOneAndUpdate` just returns whichever process asked first. Two workers racing for the same job is exactly the scenario the atomic claim is designed to resolve safely; it has no way of knowing one of them is running stale code. That's a deployment problem, not a queue-logic problem.

---

## 5. Change stream events never reached the dashboard — two typo mismatches

**Symptom**
Wired up a MongoDB change stream to broadcast job updates over WebSocket. Server started with no errors, `watching job changes` printed fine — but nothing about it had actually been tested yet, since the bugs were sitting in code that hadn't run.

**Assumed**
Copy-pasting the two new files (`changeStream.js`, updated `server.js`) would just work since the logic was straightforward.

**Actually**
Two separate case/spelling mismatches between what a function was named where it was *defined* versus where it was *used*:

- `ws.js` exports `broadcast`. `changeStream.js` imported it as `broadast` (missing the `c`) — a name that doesn't exist anywhere. JavaScript doesn't error on a bad destructure; it just silently assigns `undefined`. The crash only happens later, the moment the function is actually called.
- `changeStream.js` exported `watchJobchange` (lowercase `c` in "change", no trailing `s`). `server.js` imported `watchJobChanges` (capital `C`, trailing `s`) — again, a name that doesn't exist in the export, so `undefined` gets imported silently.

Both bugs are the same shape: **the code that defines a name and the code that uses it drifted apart during editing**, and JavaScript's module system never checks that the names actually match until you try to call the (nonexistent) function.

**Found by**
Reading both files side by side and comparing the exact identifier spelled in the `module.exports` line against the exact identifier spelled in the `require(...)` destructure — not running the code and waiting for a crash.

**Fixed by**
Renamed both to match exactly: `broadcast` everywhere, `watchJobChanges` everywhere.

**Concept**
`const { x } = require(...)` never fails just because `x` doesn't exist on the exported object — it fails *silently*, producing `undefined`, and the real error only surfaces later at the call site (`TypeError: x is not a function`), often several files and steps removed from the actual mistake. This is the same underlying lesson as the `job`/`Job` case-sensitivity issue from earlier — but worse here, because a variable name typo like `job`/`Job` is often caught by simply reading the file, while a mismatched **export/import pair** requires checking two files at once.

**Expect the follow-up:** *Why doesn't Node just throw an error immediately when the import doesn't match?*
CommonJS `require()` returns a plain JavaScript object. Destructuring a property that doesn't exist on an object is completely valid JS — `const { x } = {}` just gives you `x === undefined`, same as anywhere else in the language. Node has no special-case behavior for "this came from a module" — TypeScript's static checking would catch this at compile time, but plain JS defers everything to runtime.

---

## 6. Getting the Dockerized stack running — three small setup issues, one real lesson

**Symptom**
`docker build` failed immediately with "the term 'docker' is not recognized." Before that, creating `Dockerfile.server` failed with "the file name is not valid."

**Assumed**
Both were code/config problems.

**Actually**
Neither was code at all — both were environment setup, not logic:

- The invalid filename was a stray `:` copied in along with the filename from a chat message (`Dockerfile.server:`) — Windows treats `:` as a reserved character in filenames and rejects it outright.
- `docker: not recognized` meant Docker Desktop wasn't installed yet. Not a config or PATH issue — the binary genuinely didn't exist on the machine.

**Fixed by**
Retyped the filename without the colon. Installed Docker Desktop, restarted the machine (PATH doesn't reliably update without a restart), and confirmed with `docker --version` in a **fresh** terminal window before continuing — an already-open terminal keeps its old PATH even after install.

**The real lesson — quoting values passed to `docker run -e`:**
Passing the Mongo URI as an environment variable:
```powershell
docker run -e MONGO_URI="mongodb+srv://user:pass@cluster.mongodb.net/db" ...
```
requires the quotes, and they're not cosmetic. A MongoDB connection string contains characters PowerShell treats specially on its own — `:`, `/`, `@`, `?`, `&` — any of which could get parsed as PowerShell syntax (path separators, redirection, parameter delimiters) instead of literal text if left unquoted. Wrapping the whole value in `"..."` tells PowerShell "this entire block is one literal string, don't interpret anything inside it."

**Concept**
Two unrelated categories of problem get debugged very differently: application bugs live in the code and are found by reading logic; environment problems (missing binaries, reserved filename characters, shell quoting) live *outside* the code entirely and are found by reading the error message literally — "not recognized as a cmdlet" means "this program doesn't exist here," not "something is wrong with my command's syntax."

**Expect the follow-up:** *Why does the container not need the `.env` file at all?*
`.env` was never copied into the image — intentionally, since committing secrets into a Docker image is a real security risk (anyone with the image can extract them). Instead, `MONGO_URI` and `PORT` are injected at *runtime* via `-e` flags on `docker run`, which is exactly how a real deploy platform (Render, Azure, etc.) does it too — config lives in the platform's environment settings, never baked into the image itself.