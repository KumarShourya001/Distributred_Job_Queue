require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const { spawn } = require("node:child_process")
const path = require("node:path")
const mongoose = require("mongoose")
const Job = require("../src/models/Job")

const SERVER = path.join(__dirname, "..", "src", "server.js")
const KEY = process.env.API_KEY
const PORT = 3301
const DEPTH = 5
const SCHEDULED = 5

let proc = null
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const post = (body) =>
  fetch(`http://localhost:${PORT}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": KEY },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

const future = (ms) => new Date(Date.now() + ms).toISOString()

before(async () => {
  const uri = process.env.MONGO_URI_TEST
  if (!uri) throw new Error("MONGO_URI_TEST is not set")
  if (!KEY) throw new Error("API_KEY is not set")
  await mongoose.connect(uri)

  proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      MONGO_URI: uri,
      PORT: String(PORT),
      MAX_QUEUE_DEPTH: String(DEPTH),
      MAX_SCHEDULED: String(SCHEDULED),
      RATE_BURST: "1000"
    },
    stdio: "ignore"
  })

  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).status) return } catch {}
    await wait(200)
  }
  throw new Error("server never became ready")
})

after(async () => {
  if (proc) proc.kill()
  if (mongoose.connection.readyState !== 1) return
  await Job.deleteMany({})
  await mongoose.disconnect()
})

test("far-future jobs do not block ordinary submissions", async () => {
  // The #22 exploit: pending jobs dated far ahead used to count as backlog and could
  // exhaust MAX_QUEUE_DEPTH permanently, since the TTL is on finishedAt and a pending
  // job never has one.
  await Job.deleteMany({})
  await Job.insertMany(
    Array.from({ length: DEPTH * 2 }, () => ({
      type: "sleep", payload: { ms: 1 }, runAt: new Date(Date.now() + 86400000)
    }))
  )

  const res = await post({ type: "sleep", payload: { ms: 1 } })
  assert.strictEqual(res.status, 202, "scheduled jobs must not consume the runnable budget")
})

test("the scheduled budget is enforced separately", async () => {
  await Job.deleteMany({})
  await Job.insertMany(
    Array.from({ length: SCHEDULED }, () => ({
      type: "sleep", payload: { ms: 1 }, runAt: new Date(Date.now() + 86400000)
    }))
  )

  const res = await post({ type: "sleep", payload: { ms: 1 }, runAt: future(86400000) })
  assert.strictEqual(res.status, 503)
  assert.deepStrictEqual(await res.json(), { error: "too many scheduled jobs" })
  assert.strictEqual(res.headers.get("retry-after"), "300")
})

test("the runnable budget is enforced separately", async () => {
  await Job.deleteMany({})
  await Job.insertMany(
    Array.from({ length: DEPTH }, () => ({
      type: "sleep", payload: { ms: 1 }, runAt: new Date(Date.now() - 1000)
    }))
  )

  const res = await post({ type: "sleep", payload: { ms: 1 } })
  assert.strictEqual(res.status, 503)
  assert.deepStrictEqual(await res.json(), { error: "queue is full" })
  assert.strictEqual(res.headers.get("retry-after"), "30")
})

test("a full runnable queue still accepts scheduled work", async () => {
  // The two budgets are independent in both directions.
  await Job.deleteMany({})
  await Job.insertMany(
    Array.from({ length: DEPTH }, () => ({
      type: "sleep", payload: { ms: 1 }, runAt: new Date(Date.now() - 1000)
    }))
  )

  const res = await post({ type: "sleep", payload: { ms: 1 }, runAt: future(3600_000) })
  assert.strictEqual(res.status, 202)
})

test("runAt beyond the ceiling is rejected at the edge", async () => {
  await Job.deleteMany({})
  const res = await post({ type: "sleep", payload: { ms: 1 }, runAt: "9999-12-31T00:00:00Z" })
  assert.strictEqual(res.status, 400)
  assert.strictEqual(await Job.countDocuments({}), 0, "nothing should have been written")
})

test("a payload over the body limit is refused with 413", async () => {
  await Job.deleteMany({})
  const res = await post({ type: "sleep", payload: { ms: 1, blob: "A".repeat(20 * 1024) } })

  assert.strictEqual(res.status, 413, "a 500 here would tell the client to retry a request that can never succeed")
  assert.match((await res.json()).error, /too large/i)
})

test("malformed JSON is a 400, not a 500", async () => {
  const res = await post('{"type":"sleep",')
  assert.strictEqual(res.status, 400)
})

test("a bad ObjectId still returns the CastError message", async () => {
  // The 4xx passthrough must not shadow the more specific branch above it.
  const res = await fetch(`http://localhost:${PORT}/jobs/notanid`, { headers: { "X-API-Key": KEY } })
  assert.strictEqual(res.status, 400)
  assert.deepStrictEqual(await res.json(), { error: "invalid id" })
})

test("the TTL index exists with the configured retention", async () => {
  // Asserting the index config rather than expiry: MongoDB's TTL sweep runs about once
  // a minute, which is far too slow to observe in a test suite.
  const idx = await mongoose.connection.collection("jobs").indexes()
  const ttl = idx.find((i) => i.expireAfterSeconds !== undefined)

  assert.ok(ttl, "no TTL index found on the jobs collection")
  assert.deepStrictEqual(ttl.key, { finishedAt: 1 }, "TTL must be on finishedAt - pending jobs have none, so they never expire")
  assert.strictEqual(ttl.expireAfterSeconds, 259200)
})

const list = (qs) =>
  fetch(`http://localhost:${PORT}/jobs${qs}`, { headers: { "X-API-Key": KEY } })

test("the list endpoint returns jobs and a cursor", async () => {
  await Job.deleteMany({})
  await Job.insertMany(Array.from({ length: 3 }, () => ({ type: "sleep", payload: { ms: 1 } })))

  const body = await (await list("?limit=10")).json()
  assert.ok(Array.isArray(body.jobs))
  assert.strictEqual(body.jobs.length, 3)
  assert.strictEqual(body.nextCursor, null, "a short page must not advertise more")
})

test("paging with the cursor visits every job exactly once", async () => {
  // The test that catches an off-by-one at the page boundary: with limit+1 probing,
  // taking the cursor from the wrong row silently skips a job on every page.
  await Job.deleteMany({})
  await Job.insertMany(Array.from({ length: 25 }, (_, i) => ({ type: "sleep", payload: { n: i } })))

  const seen = []
  let cursor = null
  for (let page = 0; page < 10; page++) {
    const qs = cursor ? `?limit=10&cursor=${cursor}` : "?limit=10"
    const body = await (await list(qs)).json()
    seen.push(...body.jobs.map((j) => String(j._id)))
    cursor = body.nextCursor
    if (!cursor) break
  }

  assert.strictEqual(seen.length, 25, `expected 25 jobs across all pages, saw ${seen.length}`)
  assert.strictEqual(new Set(seen).size, 25, "a job was returned on two different pages")
})

test("pages come back newest first", async () => {
  await Job.deleteMany({})
  await Job.insertMany(Array.from({ length: 5 }, () => ({ type: "sleep", payload: { ms: 1 } })))

  const body = await (await list("?limit=5")).json()
  const ids = body.jobs.map((j) => String(j._id))
  assert.deepStrictEqual(ids, [...ids].sort().reverse(), "sort must be _id descending")
})

test("the cursor works alongside a status filter", async () => {
  await Job.deleteMany({})
  await Job.insertMany(Array.from({ length: 12 }, () => ({ type: "sleep", payload: { ms: 1 }, status: "dead" })))
  await Job.insertMany(Array.from({ length: 12 }, () => ({ type: "sleep", payload: { ms: 1 } })))

  const first = await (await list("?status=dead&limit=10")).json()
  assert.strictEqual(first.jobs.length, 10)
  assert.ok(first.jobs.every((j) => j.status === "dead"))

  const second = await (await list(`?status=dead&limit=10&cursor=${first.nextCursor}`)).json()
  assert.strictEqual(second.jobs.length, 2, "the filter must survive pagination")
  assert.ok(second.jobs.every((j) => j.status === "dead"))
})

test("a malformed cursor is a 400, not a 500", async () => {
  const res = await list("?cursor=banana")
  assert.strictEqual(res.status, 400, "an unparseable ObjectId must not reach Mongoose")
})

test("a priority beyond the allowed range is rejected", async () => {
  await Job.deleteMany({})
  const res = await post({ type: "sleep", payload: { ms: 1 }, priority: 999999 })

  assert.strictEqual(res.status, 400)
  assert.strictEqual(await Job.countDocuments({}), 0, "nothing should have been written")
})

test("a large negative priority is rejected too", async () => {
  await Job.deleteMany({})
  const res = await post({ type: "sleep", payload: { ms: 1 }, priority: -999999 })

  assert.strictEqual(res.status, 400)
})

test("a priority inside the range is accepted and stored", async () => {
  await Job.deleteMany({})
  const res = await post({ type: "sleep", payload: { ms: 1 }, priority: 5 })
  assert.strictEqual(res.status, 202)

  const doc = await Job.findById((await res.json()).id).lean()
  assert.strictEqual(doc.priority, 5, "rejection-only tests pass even when the accept path is broken")
})

test("omitting priority falls back to the schema default", async () => {
  await Job.deleteMany({})
  const res = await post({ type: "sleep", payload: { ms: 1 } })
  const doc = await Job.findById((await res.json()).id).lean()

  assert.strictEqual(doc.priority, 0)
})
