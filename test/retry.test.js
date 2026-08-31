require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const { spawn } = require("node:child_process")
const path = require("node:path")
const mongoose = require("mongoose")
const Job = require("../src/models/Job")


// This file drives a REAL worker process rather than importing the retry logic, because
// that logic lives inside tick() and requiring worker.js would start a second loop against
// whatever MONGO_URI happens to be set. Spawning it with MONGO_URI pointed at the test
// database exercises the code that actually ships.
let worker = null

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Polling beats a fixed sleep: it finishes as soon as the work is done, and reports what
// it last saw on timeout.
async function waitForTerminal(id, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await Job.findById(id).lean()
    if (last && ["completed", "failed", "dead"].includes(last.status)) return last
    await wait(200)
  }
  throw new Error(
    `job ${id} never reached a terminal state within ${timeoutMs}ms ` +
    `(last seen: status=${last && last.status} attempts=${last && last.attempts})`
  )
}

before(async () => {
  const uri = process.env.MONGO_URI_TEST
  if (!uri) throw new Error("MONGO_URI_TEST is not set - refusing to run against the real database")
  await mongoose.connect(uri)
  await Job.deleteMany({})

  worker = spawn(process.execPath, [path.join(__dirname, "..", "src", "worker", "worker.js")], {
    env: { ...process.env, MONGO_URI: uri },
    stdio: "ignore"
  })

  await wait(1500) // let it connect before the first job is inserted
})

after(async () => {
  if (worker) worker.kill()
  if (mongoose.connection.readyState !== 1) return
  await Job.deleteMany({})
  await mongoose.disconnect()
})

test("a permanent failure lands on 'failed' after a single attempt", async () => {
  const job = await Job.create({
    type: "http_request",
    payload: { url: "http://169.254.169.254/latest/meta-data/" }
  })

  const done = await waitForTerminal(job._id)

  assert.strictEqual(done.status, "failed", "a blocked address must never be retried")
  assert.strictEqual(done.attempts, 1, "permanent failures must not burn all three attempts")
  assert.ok(done.finishedAt, "finishedAt should be set on a terminal transition")
  assert.match(done.result.error, /blocked address/i)
})

test("an unknown job type is permanent, not retried", async () => {
  const job = await Job.create({ type: "send_email", payload: {} })

  const done = await waitForTerminal(job._id)

  assert.strictEqual(done.status, "failed")
  assert.strictEqual(done.attempts, 1)
  assert.match(done.result.error, /no handler for type/i)
})

test("a transient failure is retried three times then dead-lettered", async () => {
  const job = await Job.create({
    type: "http_request",
    payload: { url: "https://example.com/", shouldFail: true }
  })

  const done = await waitForTerminal(job._id)

  assert.strictEqual(done.status, "dead", "an ordinary Error should exhaust its retries")
  assert.strictEqual(done.attempts, 3)
  assert.ok(done.finishedAt)
  assert.match(done.result.error, /simulated failure/i)
})

test("retries are spaced by exponential backoff, not just the poll interval", async () => {
  const started = Date.now()
  const job = await Job.create({
    type: "http_request",
    payload: { url: "https://example.com/", shouldFail: true }
  })

  await waitForTerminal(job._id)
  const elapsed = Date.now() - started

  // Three attempts at a 1s poll with no backoff finish in roughly 3s. With backoff the
  // worker also sleeps backoffMs(1) then backoffMs(2): 2000ms and 4000ms before jitter,
  // which halves them at worst -> 1000 + 2000. Floor with backoff ~5s, ceiling without ~3s.
  assert.ok(
    elapsed > 4500,
    `expected backoff to delay retries; whole cycle took only ${elapsed}ms, ` +
    `which is about what plain 1s polling would give`
  )
})

test("a job scheduled in the future is not run early", async () => {
  const job = await Job.create({
    type: "http_request",
    payload: { url: "https://example.com/" },
    runAt: new Date(Date.now() + 60_000)
  })

  await wait(3000) // several poll cycles

  const still = await Job.findById(job._id).lean()
  assert.strictEqual(still.status, "pending", "a future job must stay pending")
  assert.strictEqual(still.attempts, 0)
})
