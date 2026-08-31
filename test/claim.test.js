require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const mongoose = require("mongoose")
const Job = require("../src/models/Job")
const { claimJob } = require("../src/worker/claim")

before(async () => {
  const uri = process.env.MONGO_URI_TEST
  if (!uri) throw new Error("MONGO_URI_TEST is not set - refusing to run against the real database")
  await mongoose.connect(uri)
})

after(async () => {
  if (mongoose.connection.readyState !== 1) return
  await Job.deleteMany({})
  await mongoose.disconnect()
})

test("exactly one of many concurrent claims wins a single job", async () => {
  await Job.deleteMany({})
  await Job.create({ type: "http_request", payload: {} })

  // Promise.all fires all ten without awaiting in between -- that is what makes it a
  // race. A for loop with await inside would pass trivially. Each claim gets its own
  // fence, exactly as a separate worker process would.
  const results = await Promise.all(
    Array.from({ length: 10 }, () => claimJob(new Date()))
  )

  const winners = results.filter(Boolean)
  assert.strictEqual(winners.length, 1, `expected 1 winner, got ${winners.length}`)
  assert.strictEqual(winners[0].status, "claimed")
  assert.ok(winners[0].claimedAt instanceof Date)
})

test("three jobs and ten claimers produce three distinct winners", async () => {
  await Job.deleteMany({})
  await Job.create([
    { type: "http_request", payload: {} },
    { type: "http_request", payload: {} },
    { type: "http_request", payload: {} }
  ])

  const results = await Promise.all(
    Array.from({ length: 10 }, () => claimJob(new Date()))
  )

  const winners = results.filter(Boolean)
  assert.strictEqual(winners.length, 3, `expected 3 winners, got ${winners.length}`)

  // No job may be handed to two claimers.
  const ids = new Set(winners.map((j) => String(j._id)))
  assert.strictEqual(ids.size, 3, "a job was claimed more than once")
})

test("claiming an empty queue returns null", async () => {
  await Job.deleteMany({})
  assert.strictEqual(await claimJob(new Date()), null)
})

test("an already-claimed job cannot be claimed again", async () => {
  await Job.deleteMany({})
  await Job.create({ type: "http_request", payload: {} })

  assert.ok(await claimJob(new Date()), "first claim should succeed")
  assert.strictEqual(await claimJob(new Date()), null, "second claim should find nothing")
})

test("jobs are claimed oldest first", async () => {
  await Job.deleteMany({})
  const older = await Job.create({ type: "http_request", payload: { tag: "older" } })
  await new Promise((r) => setTimeout(r, 10))
  await Job.create({ type: "http_request", payload: { tag: "newer" } })

  const claimed = await claimJob(new Date())
  assert.strictEqual(String(claimed._id), String(older._id), "should claim the older job first")
})
test("a job scheduled in the future is not claimed", async () => {
  await Job.deleteMany({})
  await Job.create({ type: "http_request", payload: {}, runAt: new Date(Date.now() + 60_000) })

  assert.strictEqual(await claimJob(new Date()), null, "a future job must not be claimable yet")
})

test("a job whose runAt has passed is claimed", async () => {
  await Job.deleteMany({})
  await Job.create({ type: "http_request", payload: {}, runAt: new Date(Date.now() - 1000) })

  const claimed = await claimJob(new Date())
  assert.ok(claimed, "a due job should be claimable")
  assert.strictEqual(claimed.status, "claimed")
})

test("a due job is claimed even when a newer future job exists", async () => {
  await Job.deleteMany({})
  // The future job is created first, so createdAt ordering would pick it if runAt were ignored.
  await Job.create({ type: "http_request", payload: { tag: "future" }, runAt: new Date(Date.now() + 60_000) })
  const due = await Job.create({ type: "http_request", payload: { tag: "due" }, runAt: new Date(Date.now() - 1000) })

  const claimed = await claimJob(new Date())
  assert.strictEqual(String(claimed._id), String(due._id), "should skip the not-yet-due job")

  assert.strictEqual(await claimJob(new Date()), null)
})

test("a new job defaults to being immediately claimable", async () => {
  await Job.deleteMany({})
  await Job.create({ type: "http_request", payload: {} })

  assert.ok(await claimJob(new Date()), "runAt should default to now, not to null or undefined")
})

test("a higher-priority job is claimed before an older one", async () => {
  await Job.deleteMany({})
  // Created first, so createdAt ordering alone would pick this one.
  await Job.create({ type: "http_request", payload: { tag: "old-low" }, priority: 0 })
  await new Promise((r) => setTimeout(r, 10))
  const urgent = await Job.create({ type: "http_request", payload: { tag: "new-high" }, priority: 10 })

  const claimed = await claimJob(new Date())
  assert.strictEqual(String(claimed._id), String(urgent._id), "priority must beat createdAt")
})

test("jobs of equal priority still come out oldest first", async () => {
  await Job.deleteMany({})
  const older = await Job.create({ type: "http_request", payload: {}, priority: 5 })
  await new Promise((r) => setTimeout(r, 10))
  await Job.create({ type: "http_request", payload: {}, priority: 5 })

  const claimed = await claimJob(new Date())
  assert.strictEqual(String(claimed._id), String(older._id), "createdAt is the tiebreak")
})

test("priority defaults to 0 and is actually persisted", async () => {
  await Job.deleteMany({})
  const plain = await Job.create({ type: "http_request", payload: {} })
  assert.strictEqual(plain.priority, 0, "schema default should apply")

  const set = await Job.create({ type: "http_request", payload: {}, priority: 7 })
  const reread = await Job.findById(set._id).lean()
  assert.strictEqual(reread.priority, 7, "a field misspelled in the schema is silently dropped here")
})

test("priority does not override runAt", async () => {
  await Job.deleteMany({})
  await Job.create({
    type: "http_request",
  // High priority but not due yet: readiness wins over importance.
    payload: { tag: "urgent-but-future" },
    priority: 100,
    runAt: new Date(Date.now() + 60_000)
  })
  const due = await Job.create({ type: "http_request", payload: { tag: "dull-but-due" }, priority: 0 })

  const claimed = await claimJob(new Date())
  assert.strictEqual(String(claimed._id), String(due._id), "a future job is not claimable at any priority")
})

test("negative priority sinks below the default", async () => {
  await Job.deleteMany({})
  const normal = await Job.create({ type: "http_request", payload: { tag: "normal" } })
  await new Promise((r) => setTimeout(r, 10))
  await Job.create({ type: "http_request", payload: { tag: "background" }, priority: -5 })

  const claimed = await claimJob(new Date())
  assert.strictEqual(String(claimed._id), String(normal._id))
})
