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
---

## 7. `getaddrinfo EAI_AGAIN` — Mongo unreachable from inside the container

**Symptom**
`docker compose up` brought the server up, then it crash-looped. Mongoose reported "Could not connect to any servers in your MongoDB Atlas cluster... make sure your current IP is whitelisted," with `getaddrinfo EAI_AGAIN ac-gogsuqu-shard-00-00...` buried in the topology dump. The same connection string worked fine running `node src/server.js` on the host.

**Assumed**
Two wrong guesses, in order:
1. The Atlas IP allowlist, because that's what Mongoose's error message says.
2. The campus resolver again — the same cause as entry 1.

**Actually**
Neither. I wasn't even on the campus network at the time.

Mongoose's allowlist message is a **generic hint printed for any connection failure**, not a diagnosis. The real error was `EAI_AGAIN`, a DNS resolution failure — same category as entry 1, one layer down.

Containers do not inherit the host's DNS settings. The 8.8.8.8 I set on the Wi-Fi adapter back in entry 1 applies to the host only. Docker Desktop resolves through its WSL2 VM, whose resolver is frequently stale or unreachable — so Atlas lookups failed inside the container on a network where the host resolved those exact hostnames without issue.

**Found by**
Filtering the enormous topology dump for the actual error instead of reading the headline message:
```bash
docker logs <container> 2>&1 | grep -iE "error|EAI_AGAIN|ECONNREFUSED"
```
`EAI_AGAIN` names the syscall — the same tell as entry 1's `querySrv`.

**Fixed by**
Pinning public resolvers on both services in `docker-compose.yml`:
```yaml
    dns:
      - 8.8.8.8
      - 1.1.1.1
```
Server reached `connected` / `watching job changes` / `listen on 3000` on the next `up`.

**Concept**
A container is a separate network namespace, not a process on my machine. Host-level network fixes — DNS servers, hosts file entries, VPN routes — do not cross that boundary. When something works on the host and fails in a container, network configuration is the first place to look, not the code.

Also: read the *error*, not the *error message*. Mongoose's whitelist hint is printed unconditionally. `EAI_AGAIN` is the fact.

**Expect the follow-up:** *Why not just use `network_mode: host`?*
It would work on Linux and sidestep the DNS issue, but it isn't supported on Docker Desktop for Windows/Mac, and it throws away network isolation to fix a name-resolution problem. Pinning DNS is the narrower fix.

---

## 8. `docker compose` wouldn't start — two environment issues

**Symptom**
Two separate failures before a single container ran:
```
failed to read .env: line 4: key cannot contain a space
Bind for 0.0.0.0:3000 failed: port is already allocated
```

**Assumed**
The first meant the compose file was malformed.

**Actually**
Neither error was about compose at all.

- **The `.env` parse failure**: I had pasted two full `docker run -p 3000:3000 -e MONGO_URI=...` command lines into `.env` as notes to self. `dotenv` silently skips lines that don't match `KEY=VALUE`, so Node never complained and I never knew they were there. `docker compose` parses `env_file` strictly and refuses the whole file. It had been quietly malformed for days.
- **The port conflict**: containers from an earlier manual `docker run` were still running after 47 minutes, holding port 3000.

**Found by**
Reading both messages literally. "key cannot contain a space" describes line 4 of a *config file*, not YAML. `docker ps` showed the two orphaned containers immediately.

**Fixed by**
Deleted the two pasted command lines from `.env`, leaving only `MONGO_URI` and `PORT`. Stopped the stale containers with `docker stop <name>`.

**Concept**
Two tools reading the same file can disagree about what's valid. `dotenv` is permissive and skips garbage; `docker compose` is strict and rejects the file. A file that "works" under a lenient parser is not the same as a file that's correct — and the lenient parser is exactly what lets the problem hide.

Second lesson: `docker run` containers don't disappear when I stop looking at them. Check `docker ps` before assuming a port is free.

**Expect the follow-up:** *Why does `dotenv` skip malformed lines instead of erroring?*
Deliberate design — `.env` files commonly carry comments and hand-written notes, so the parser ignores anything that isn't `KEY=VALUE` rather than breaking the app. Convenient, until a stricter consumer reads the same file.

---

## 9. Lost update after the atomic claim — fencing the post-claim writes

**Symptom**
None. Nothing failed, nothing logged, every test passed. Found by reasoning about the code, not by observing a failure.

**Assumed**
That entry 3 had solved the concurrency problem. `findOneAndUpdate` made the claim atomic, so the job was safe.

**Actually**
The *claim* was atomic. Everything after it was not.

Once claimed, the worker held an in-memory snapshot and finished with `job.save()`. `save()` writes the whole document unconditionally — it has no idea whether the job still belongs to this worker.

The gap: if a job runs longer than the sweeper's 30-second timeout, the sweeper resets it to `pending`, a second worker claims it, and the first worker's `save()` still lands — overwriting a job it no longer owns. Same class of bug as entry 3, moved from the read side to the write side.

Invisible in normal running because jobs take 500ms against a 30s timeout — 60x margin.

**Fixed by**
Capturing the claim timestamp as a fence, then making every later write conditional on it:
```javascript
const fence = new Date()
const job = await Job.findOneAndUpdate(
    { status: "pending" },
    { $set: { status: "claimed", claimedAt: fence } },
    { sort: { createdAt: 1 }, returnDocument: "after" }
)
// ...
const done = await Job.findOneAndUpdate(
    { _id: id, claimedAt: fence },      // only if the claim is still mine
    { $set: { status: "completed", result: { ok: true } } }
)
if (!done) { console.log("lost claim, discarding result", id.toString()); return }
```
If the sweeper nulled `claimedAt` or another worker re-claimed it, the filter matches nothing, the write does nothing, and `null` comes back. The worker discards its result — correct, because whichever worker owns the job now will finish it.

**Proved by**
Deliberately inverting the timings to force the collision: `sleep(500)` to `sleep(6000)`, sweeper `30000` to `2000`. Two workers, one job. Result: 7 claims, 7 `lost claim, discarding result`, **0 duplicate completions**. Before the fix, all 7 would have written `completed`.

**Two things the forced test exposed that I wasn't looking for:**

1. **The job never completed at all** — claimed, swept at 2s, re-claimed, lost at 6s, forever. A **livelock**: no crash, no error, infinite repeated work. This is why the sweeper timeout must be *longer* than the worst-case job duration. Its purpose is recovering work from dead workers; set it below job duration and it starts stealing from live ones.
2. **All 7 claims came from `worker-1`; `worker-2` never claimed anything.** `setInterval(tick, 1000)` fires every second regardless of whether the previous tick finished, so one worker had roughly 6 overlapping ticks in flight, out-competing the other process entirely. That's the second deliberate bug from the stage-2 spec, finally visible — and the fence held correctness across all 6 concurrent ticks inside a single process.

**Concept**
Atomicity protects one operation, not a sequence. Making the claim atomic guarantees one winner *at claim time*; it says nothing about whether that winner still holds the job thirty seconds later. Any write that depends on state read earlier must re-assert that state as part of the write itself — a conditional filter, not an `if` in application memory.

Naming it precisely: this is **compare-and-swap on `claimedAt`**, or optimistic concurrency control. A true fencing token is a monotonically increasing counter; the timestamp works here only because successive claims of the same job are always separated by the sweeper's timeout.

**One syntax note from writing it:** a stray `\` at the end of a line produced `SyntaxError: Invalid or unexpected token` and the file wouldn't load at all. JavaScript has no line-continuation character outside strings. `node --check <file>` catches this in a second, without starting the app or connecting to Mongo.

**Expect the follow-up:** *What happens to a job whose worker dies after finishing the work but before writing the result?*
It gets swept back to `pending` and runs again — so the work happens twice. This system is **at-least-once**, not exactly-once. Making it exactly-once needs either idempotent job handlers or a transaction spanning the work and the status write, which isn't possible when the work is an external side effect like sending an email.

---

## 10. One worker took every job — `setInterval` and overlapping async ticks

**Symptom**
Ran two workers against a queue of slow jobs. `worker-1` claimed everything; `worker-2` logged `worker up` and then nothing at all, for the entire run. Scaling to more workers changed nothing — the extra processes sat idle while one did all the work.

**Assumed**
A problem with the atomic claim, or with how Docker was scaling the service. Possibly `worker-2` wasn't connected properly.

**Actually**
Both workers were healthy and both were polling. The problem was that `worker-1` was polling *far more often than once per second*.

```javascript
setInterval(tick, 1000)
```

`setInterval` fires on a fixed wall-clock schedule and does not wait for the previous call to finish. `tick` is `async`, so it returns a promise almost immediately — long before the job it claimed is done. With a 6-second job, six more ticks launch while the first is still working.

So one process had roughly six concurrent claim attempts in flight at all times, against `worker-2`'s one. It won nearly every race by sheer volume.

**Found by**
Reading the log ordering rather than the log content. `worker-1` printed several `claimed` lines *before* any `completed` line appeared. One job at a time would have to alternate `claimed`, `completed`, `claimed`, `completed`. Stacked `claimed` lines meant overlapping work inside a single process.

**Fixed by**
Replacing the interval with a loop that waits for each tick to finish before starting the next:

```javascript
async function loop() {
    while (!shuttingDown) {
        await tick()
        if (shuttingDown) break
        await sleep(1000)
    }
    // cleanup
}
```

Verified with two workers and 3-second jobs: work split across both processes, and each worker's log alternates strictly `claimed` then `completed`, never two claims in a row.

The sweeper's `setInterval` was deliberately left alone — `sweep` is a single `updateMany` that finishes in milliseconds and is idempotent, so overlapping sweeps are harmless.

**Concept**
`setInterval(fn, 1000)` means "start one every second." What a poller actually wants is "wait one second between finishing and starting again." Those are only the same thing when the work is instantaneous — which is never true of anything `async`.

The failure mode is worse than uneven distribution. If the database slows down, ticks pile up faster than they drain, so the system throws *more* work at the thing that is already struggling. That's a death spiral, and it's why unbounded concurrency is a bug even when nothing visibly breaks.

**Expect the follow-up:** *Why not use a counting semaphore to allow N jobs per worker?*
A sequential loop is a semaphore with exactly one permit, so it's the same idea with the simplest possible bound. A larger bound is worth it when jobs are I/O-bound — waiting on an email API or an HTTP call leaves the process idle, so one worker could usefully hold several. It isn't worth it here because the "work" is a `sleep` placeholder, and because scaling horizontally (`--scale worker=3`) already provides parallelism that the atomic claim makes safe with zero coordination.

---

## 11. Worker killed mid-job on every deploy — graceful shutdown

**Symptom**
Not an error — a cost. Every `docker compose down` or redeploy killed workers instantly, abandoning whatever job was in flight. Those jobs sat in `claimed` until the sweeper reclaimed them 30 seconds later, so each deploy stalled every in-flight job by half a minute.

**Assumed**
That the fence and the sweeper already covered this. They do prevent *corruption* — but preventing corruption and shutting down well are different problems.

**Actually**
Docker sends `SIGTERM` and waits (10 seconds by default) before `SIGKILL`. Node installs no handler for `SIGTERM` by default, so the process died immediately, mid-job, every time — never using the grace period it was being offered.

**Fixed by**
A shutdown flag the loop checks, set by a signal handler that does nothing else:

```javascript
let shuttingDown = false

function requestShutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(signal, "received - finishing current job, then exiting")
}

process.on("SIGTERM", () => requestShutdown("SIGTERM"))
process.on("SIGINT", () => requestShutdown("SIGINT"))
```

and cleanup placed *after* the loop, not inside the handler:

```javascript
clearInterval(sweepTimer)
await mongoose.disconnect()
process.exit(0)
```

**Proved by**
Slowed jobs to 8 seconds, submitted one, and sent `SIGTERM` 3 seconds in with a 30-second grace period:

```
05:04:18  claimed 6a921afa...
05:04:21  SIGTERM received - finishing current job, then exiting
05:04:26  completed 6a921afa...
05:04:26  worker stopped cleanly
```

The job finished instead of being abandoned, and Mongo confirmed `status: "completed"`. Before the change, the process would have died at 05:04:21.

**Concept — a signal handler sets a flag and returns.**
It must not close connections, await anything, or run teardown. The signal can arrive at any instant, including mid-write. Disconnecting Mongo inside the handler would kill the connection underneath the in-flight job's own `findOneAndUpdate` — a "graceful" shutdown that corrupts precisely the work it was written to protect.

The thing that *notices* an event and the thing that *acts* on it are separate. The handler requests a shutdown; the loop performs one, at a moment of its own choosing when nothing is in flight.

Two smaller points that mattered:
- `clearInterval(sweepTimer)` requires having stored the timer handle. The old code discarded `setInterval`'s return value, so the sweeper couldn't be stopped — and a sweep firing after `disconnect()` would throw on a dead connection.
- `process.exit(0)` — zero means success. A non-zero code tells Docker the container crashed, and `restart: unless-stopped` would immediately bring it back.

**Expect the follow-up:** *What if the job takes longer than Docker's grace period?*
`SIGKILL` arrives and the process dies regardless — nothing in Node can prevent that. The fence and sweeper are what make it safe: the job stays `claimed`, gets reclaimed after 30 seconds, and another worker redoes it. At-least-once still holds. The knob for genuinely long jobs is `stop_grace_period` per service in `docker-compose.yml`.

---

## 12. `/health` returned 500 — and `node --check` had passed the file

**Symptom**
Every other route worked. `GET /health` returned 500 with the generic error-handler message.

**Assumed**
The file was fine — `node --check src/server.js` reported no problem.

**Actually**
The array was declared as `status` and read as `states`. `ReferenceError: states is not defined`, thrown the moment the route ran.

**Concept**
`node --check` parses grammar, not meaning. It cannot know whether an identifier exists, because JavaScript resolves names at runtime. A file can pass the syntax check and still throw on its first line of real work.

Same class as the undefined `attempts` variable earlier: the error only appears when that exact line executes, which is why a route nobody has called yet can stay broken indefinitely.

**Expect the follow-up:** *What would have caught it?*
ESLint's `no-undef` rule, or TypeScript. Both check identifiers before the code runs; `node --check` never does.

---

## 13. `type` was decorative — every job did the same thing

**Symptom**
None. Everything passed. `type: "send_email"` and `type: "banana"` behaved identically.

**Actually**
The worker never read `job.type`. It slept 500ms and marked the job complete regardless. The field was validated, stored, displayed — and ignored. The queue wasn't running jobs, it was simulating them.

**Fixed by**
A handler registry — `src/worker/handlers.js`, an object mapping type to an async function. The worker looks up `handlers[job.type]`, throws if there isn't one, and stores whatever the handler returns as `result`.

First real handler: `http_request`, which POSTs a payload to a URL using Node's built-in `fetch`, with `AbortSignal.timeout(10000)`.

**One bug while wiring it:** wrote `result: {result}` in the update. Object shorthand `{result}` already means `{result: result}`, so the extra braces nested it one level deep — the stored value became `{result: {status: 200}}` instead of `{status: 200}`.

**Proved by**
A local listener, one worker, three jobs:

```
completed  result: {"status":200,"url":"http://localhost:4600/hook"}
dead       result: {"error":"request failed: HTTP 500"}      attempts: 3
dead       result: {"error":"no handler for type: send_email"} attempts: 3
```

The listener logged the real POST body, and logged the 500 route being hit **three times** — the retry logic driving three genuine HTTP requests before dead-lettering.

**Concept**
The queue is generic infrastructure; handlers are the pluggable part. Once dispatch is keyed on `type`, unknown types fail through the retry path with no new code, and the timeout has to sit below the sweeper's lease — 10s against 30s — or a slow request outlives its own claim.

**Expect the follow-up:** *Why reject unknown types at the API instead of letting them dead-letter?*
Dead-lettering works, but it costs three attempts spread over minutes before anyone finds out, and the failure surfaces far from the mistake. The registry's keys are a known set, so the API can reject a typo at submission with a 400 — same argument as the `status` enum in entry 2.

---

## 14. The `http_request` handler was an open SSRF proxy

**Symptom**
None. Every test passed, every job completed, the dashboard looked correct. Nothing was
broken — which is exactly what made it dangerous.

**Actually**
`handlers.js` fetched whatever URL arrived in the payload, and `POST /jobs` is
unauthenticated. So this body was accepted, queued, and executed by the worker:

```json
{ "type": "http_request", "payload": { "url": "http://169.254.169.254/latest/meta-data/iam/security-credentials/" } }
```

`169.254.169.254` is the cloud metadata endpoint on AWS, GCP and Azure. A worker running
there fetches it happily, the response is stored in `job.result`, and `job.result` is then
served back over `GET /jobs/:id` **and broadcast to every connected dashboard over the
change stream**. A public submission endpoint reading internal credentials and publishing
them. The same trick reaches `127.0.0.1:3000`, the Mongo port, or anything else inside the
deploy network.

Server-Side Request Forgery: the attacker never talks to the internal service. They make
*my* server talk to it, from inside the trust boundary, and hand back the answer.

Local dev hid it completely — there is no metadata service on a laptop, so the exploit
only comes alive at the moment of deploy.

**Fixed by**
`src/worker/safeUrl.js` — `assertSafeUrl()`, called before `fetch`. Five layers:

1. Parse with `new URL()` in a try/catch.
2. Protocol allowlist — `http:` / `https:` only, which kills `file:`, `ftp:`, `data:`.
3. Resolve the hostname with `dns.lookup(host, { all: true })`.
4. Reject loopback, RFC1918 private, link-local, CGNAT, multicast and reserved ranges —
   plus the IPv6 equivalents.
5. `redirect: "manual"` on the fetch.

Optional `ALLOWED_HOSTS` env var turns the denylist into an allowlist, which is strictly
stronger.

**Concept — check the resolved address, not the hostname**
The obvious implementation is a string check on the hostname, and it is worthless. I can
register `totally-normal-site.com` and point its A record at `169.254.169.254`. The string
looks fine; the packet goes to the metadata service. Only the *resolved address* tells the
truth.

Three subtleties that each individually defeat a naive version:

- **`{ all: true }` returns an array, and every entry must be checked.** Validating only
  `addresses[0]` is a bypass: a hostile resolver returns one safe public address followed
  by an internal one, and the request goes to whichever the OS picks.
- **`::ffff:169.254.169.254` is the metadata address wearing an IPv6 costume.**
  `net.isIP()` reports `6`, so none of the IPv4 rules fire. IPv4-mapped addresses have two
  spellings — dotted, and hex (`::ffff:a9fe:a9fe`, since `a9fe` = 169.254). Both have to be
  unwrapped and re-checked as IPv4.
- **Redirects undo all of it.** `fetch` follows them by default. A public host passes every
  check, then returns `302 Location: http://169.254.169.254/`. Validation already happened;
  the redirect is followed unvalidated. `redirect: "manual"` is not optional — without it
  the other four layers are decorative.

**Known residual risk — DNS rebinding**
I resolve the hostname, get a safe address, and then `fetch` resolves it *again* and can
get a different answer. That is a TOCTOU race. Closing it properly means connecting to the
already-validated IP with a custom agent instead of handing `fetch` a hostname. Not fixed;
documented deliberately.

**First implementation pass failed — six identifier bugs, `node --check` passed all of them**

Same lesson as entry 12, at larger scale. Both files parsed clean and nothing worked:

| Location | Bug | Effect |
|---|---|---|
| `safeUrl.js` | `net.BLOCKED_V4.some(...)` | `BLOCKED_V4` is module-level, not on `net`. `TypeError: Cannot read properties of undefined` — **all IPv4 blocking dead** |
| `safeUrl.js` | `typeof rawurl` (lowercase `u`) | `typeof` on an *undeclared* identifier returns `"undefined"` instead of throwing, so the guard silently matched every input — every URL rejected as "non-empty string" |
| `safeUrl.js` | `new URL(rawurl)` | `ReferenceError`, swallowed by the bare `catch` and reported as "url is not valid" — a typo disguised as a validation failure |
| `safeUrl.js` | `protocol !== "https:" && protocol !== "https:"` | `"https:"` written twice; `http://` URLs rejected. Fail-closed, so not a hole, but it breaks legitimate jobs |
| `safeUrl.js` | `parseINt` | `ReferenceError` on the hex IPv4-mapped path only — the branch a real attacker uses |
| `handlers.js` | `res.status` read **above** `const res = await fetch(...)` | Temporal dead zone. `ReferenceError: Cannot access 'res' before initialization` — every `http_request` job dies |

Plus: `assertSafeUrl(url)` called *before* the `if (!url)` guard, so a missing URL produced
the wrong error message; `res.staus` and `res.handlers.get`; and `redirect: "manual"` never
added to the fetch options at all — the single line the whole defence depends on.

**Concept**
`node --check` parses grammar, not meaning — it cannot know whether an identifier exists.
Two of these are worse than a plain crash, because they *fail quietly in the safe direction*:
the `typeof rawurl` bug rejected everything, and the doubled `"https:"` rejected plain HTTP.
A security check that refuses all input looks like it is working. Only a test that asserts
a **known-good URL is allowed** distinguishes "correctly blocking attacks" from "broken and
blocking everything".

**Proved by**
A 37-case run against `assertSafeUrl` and `isBlockedAddress` after the fixes: every private,
loopback, link-local and IPv4-mapped address rejected; every public address allowed; both
`example.com` spellings and `webhook.site` still pass, which is the case that proves the
check is discriminating rather than simply refusing everything.

Two things the run exposed that reading the code did not:

- `http://[::ffff:169.254.169.254]/` comes out of `new URL()` normalised to the **hex**
  form, `::ffff:a9fe:a9fe`. So the hex branch is the one that actually executes on a real
  attack string, and the dotted branch is the rarer path. The `parseINt` typo sat in the
  live branch, not a corner case.
- `localhost` resolved to `::1` first on this machine, not `127.0.0.1`. The IPv6 rules are
  not defensive extras — on a dual-stack host they are the ones that fire.

**Expect the follow-up:** *Why not validate the URL at the API instead of in the worker?*
The API should too, for a fast 400 instead of three doomed retries. But the handler is where
the dangerous action happens, so that is where the check has to be load-bearing — an API
check is a convenience, not a boundary. Anything that can insert a document into the
collection (a migration, a script, a second API instance on an old build) bypasses the route
entirely and reaches the worker regardless.

**Expect the follow-up:** *Why is a validation failure retried three times?*
It shouldn't be. A blocked URL is a permanent failure — retrying it twice more changes
nothing and just delays the dead-letter. That needs the `failed` vs `dead` distinction the
schema already declares but no code sets. Open.

---

## 15. Two versions of the worker eating from one queue

**Symptom**
Testing the new `failed`-vs-`dead` logic. Permanent failures were supposed to stop at
attempt 1. Two of five test jobs came back `failed` with **`attempts: 2`**, the other one
with `attempts: 1`. Same code path, different answers.

**Assumed**
An off-by-one in `const attempts = job.attempts + 1`.

**Actually**
Two worker processes were running. `Get-CimInstance Win32_Process` on `node.exe` showed
one started at 15:21 and one at 16:54 — the first from hours earlier, running the code as
it stood *before* `PermanentError` existed.

The sequence that produced `attempts: 2`:

1. Old worker claims the job. It has no concept of a permanent error, so it does the old
   thing: `attempts: 1`, `status: "pending"` — queued for retry.
2. New worker claims the retry, recognises `PermanentError`, and writes
   `attempts: 2, status: "failed"`.

The number was correct. The premise — one worker — was wrong.

**Found by**
Listing process command lines rather than trusting task-manager-style output. `tasklist`
shows seven `node.exe` entries with no way to tell a worker from Adobe's updater;
`Get-CimInstance Win32_Process | Select CommandLine` shows exactly which script each one is
running and when it started. The start time is what gave it away.

**Fixed by**
Killing both, starting one, re-running. Clean result: all three permanent failures at
`attempts: 1`.

**Concept — this is a rolling deploy, and the queue survived it**
Two versions of a consumer against one queue is not a testing artifact; it is what every
deploy looks like for a few seconds. Worth noting what did *not* happen: no duplicate
execution, no corruption, no lost job. The atomic claim held across versions, because it
depends on a `findOneAndUpdate` on `status`, not on any assumption that all workers agree
about behaviour.

What *did* happen is that the old worker did work the new one would have skipped. The
system stayed correct and got slower. That is the right failure mode for a mixed-version
window, and it is the honest answer to "what happens to in-flight jobs during a deploy?"

**Expect the follow-up:** *How would you make a mixed-version window safer?*
Version the handler contract rather than the worker. If a job records the schema version it
was written under, an old worker can decline to claim work it does not understand instead of
guessing. Not implemented — the queue is small enough that "slower, still correct" is
acceptable.

---

## 16. Startup failures printed 137 lines — and two of them needed different handlers

**Symptom**
Wrong `MONGO_URI`: 25 lines from the server, 137 from the worker, mostly a
`TopologyDescription` dump listing every host, wire version and round-trip time. Every
restart of a crash-loop reprinted the whole thing.

**Actually**
`main()` was called bare. An unhandled promise rejection prints the full error object.
Node does exit non-zero, so Docker's `restart: unless-stopped` was already doing the right
thing — this was never a crash bug, only a diagnostics one. I ranked it higher than it
deserved before measuring it.

**Fixed by**

```js
main().catch((err) => {
  console.error("failed to start:", err.message)
  process.exit(1)
})
```

`err.message`, not `err` — that one word is the entire difference between 2 lines and 137.
`process.exit(1)` is not optional: a caught rejection with no explicit exit leaves the code
at **0**, which Docker reads as "finished successfully" and does not restart. Catching
without exiting turns a noisy crash-loop into silent death, which is strictly worse.

**Then the port-in-use case still printed 26 lines.**
`main().catch()` never saw it. `server.listen()` does not reject a promise on `EADDRINUSE` —
it emits an `'error'` **event**, and an unhandled `'error'` event on an EventEmitter throws
outside the promise chain entirely.

Two failure channels, two handlers:

| Failure | Channel | Caught by |
|---|---|---|
| Mongo unreachable | rejected promise | `main().catch()` |
| Port already in use | `'error'` event | `server.on("error", ...)` |

**And a one-letter typo that was worse than a crash.**
The first attempt wrote `process.emit(1)` instead of `process.exit(1)`. `process.emit` is a
real function — it emitted an event named `1`, nothing listened, it returned `false`, no
error. The handler logged its message and then simply carried on.

That mattered because of `ws`: `new WebSocketServer({ server })` attaches a listener that
re-emits the HTTP server's `'error'` on the WebSocketServer, which has no `'error'` handler
of its own. So one `EADDRINUSE` reached two emitters — the first logged politely, the second
threw. Output was the tidy message *followed by* the 26-line stack, which reads like the fix
half-worked. `process.exit(1)` terminates synchronously, so the second listener never runs.

Note what that leaves: it only works because `server.on("error")` is registered *before*
`initWebSocket(server)`. Reorder those two lines and the crash comes back. The robust version
would give `ws.js` its own `wss.on("error")`.

**Proved by**

| Case | Before | After |
|---|---|---|
| server, Mongo unreachable | 25 lines | 2 lines, exit 1 |
| server, port in use | 26 lines | 4 lines, exit 1 |
| worker, Mongo unreachable | 137 lines | 1 line, exit 1 |

**Concept**
"Handled" is not one thing. Promises and EventEmitters are separate error channels, and a
`try`/`catch`/`.catch()` covers only the first. Any object you call `.on()` on is a second
channel you have to opt into.

---

## 17. Graceful shutdown hung for exactly 10 seconds

**Symptom**
Added shutdown to the API. With no dashboard open it exited instantly. With a dashboard
connected it printed `SIGTERM received - shutting down`, sat there, and 10 seconds later
printed `forced exit` and quit with code 1 — the backstop timer, every single time.

**Actually**
`server.close()` stops accepting *new* connections and fires its callback only once every
*existing* connection has ended. WebSockets never end on their own; staying open is the
entire point of them.

So:

```js
await new Promise(r => server.close(r))   // waits for the sockets
closeWebSocket()                          // never reached
```

The HTTP server waits for the sockets. The sockets wait for someone to hang them up. The
only thing that broke the tie was the 10-second timer.

**Fixed by** starting the close, hanging up the sockets, and only then waiting:

```js
const closed = new Promise((resolve) => server.close(resolve))
closeWebSocket()
await closed
```

**Proved by** the same code run twice against a live WebSocket:

| | with `closeWebSocket()` | without |
|---|---|---|
| time to exit | **132 ms** | 10,005 ms |
| exit code | **0** | 1 |
| WS close code seen by client | **1001** (going away) | 1006 (abnormal) |

1006 is what a client sees when the socket dies with the process. 1001 is a deliberate
hang-up, which the dashboard's reconnect logic can treat as "come back shortly" instead of
"the server crashed".

**Concept — outermost first, and the connection last**

1. stop accepting new work (`server.close`)
2. end the work that cannot end itself (`closeWebSocket`)
3. drain what is in flight (`await closed`)
4. close the consumers (`stream.close`)
5. **disconnect Mongo last** — the change stream is a live cursor on that connection.
   Disconnecting earlier tears it out from under in-flight work, which is entry 11's lesson
   in a different costume.

Two smaller things that both bit:

- `force.unref()` — without the parentheses it is a property read that does nothing, and the
  10-second backstop then keeps the process alive for the full 10 seconds *after* a clean
  shutdown has already finished.
- `process.on("SIGINT", shutdown("SIGINT"))` **calls** `shutdown` at module load and passes
  its returned Promise to `process.on`. The server shut itself down before it ever listened,
  then died on `The "listener" argument must be of type function`. It needs
  `() => shutdown("SIGINT")`. The SIGTERM line one row above was written correctly, which
  made the two easy to compare and hard to see.

**Expect the follow-up:** *Why a 10-second timer at all if the ordering is right?*
Because "the ordering is right" is an assumption about code not yet written. A socket that
refuses to close or a Mongo that stops answering turns every `await` above into a hang, and a
graceful shutdown that never finishes is just a hang with better intentions. The timer exits
**1**, not 0, so the exit code still reports that it was not clean.

**Windows note:** `process.kill(pid, "SIGTERM")` does not deliver a catchable signal on
Windows — it terminates the process outright, so the handler never runs and the test looks
like a failure. Ctrl-C in a console does deliver SIGINT, and Docker sends a real SIGTERM on
Linux. To exercise the handler programmatically here, `process.emit("SIGTERM")` invokes the
listeners directly.

---

## 18. `/jobs/stats` — all zeros, then a route that "did not exist"

**Symptom (1)**
The aggregation returned correct rows, but the endpoint reported every status as `0`. No
error, no crash — it just always claimed the queue was empty.

**Actually**

```js
for (const row of rows) { if (row in obj) obj[row] = row.count }
```

`row` is `{_id: "completed", count: 42}`, an object. The `in` operator coerces its left side
to a string, so the test was `"[object Object]" in obj` — always `false`. The `if` never
passed, nothing was ever written, and the zero-filled seed object was returned untouched. It
needed `row._id` in both places.

Worse than a crash: the safe-looking answer (all zeros) is indistinguishable from a real one.

**Symptom (2)**
`GET /jobs/stats` returned `400 {"error":"invalid id"}` — an error about IDs, from an
endpoint that takes no ID.

**Actually**
Express matches routes in registration order, and `router.get("/:id")` matches any single
segment — including the literal string `"stats"`. Registering `/stats` after it meant
`findById("stats")` → CastError → the 400 from entry 2's error handler. The route existed and
was simply never reached. Static routes must be registered before parameterised ones.

**Symptom (3)**
`require`ing the service crashed the entire API at module load with
`ReferenceError: statuses is not defined`.

**Actually**
The function's closing brace was one loop too early, so half the body sat at file scope
referring to locals that only exist inside the function. Same family as entry 12: the file
parsed, and `node --check` was happy.

**Concept**
Seed the response with every status at `0`, read from `Job.schema.path("status").enumValues`
rather than a hand-written list. `$group` only returns statuses that currently exist, so a
status with no jobs is absent from the result entirely — and a caller cannot tell "zero" from
"field missing because something broke". Reading the list off the schema also means adding a
sixth status tomorrow needs no change here; the `failed` status added earlier today is exactly
the drift that would otherwise have been missed.

`total` is summed from `Object.values` of the five known statuses rather than from the raw
rows, so it always equals the numbers displayed beside it even if the database holds a status
outside the enum.
