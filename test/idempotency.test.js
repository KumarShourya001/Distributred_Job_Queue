require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const mongoose = require("mongoose")
const Job = require("../src/models/Job")
const { createJob } = require("../src/services/jobService")

before(async () => {
  const uri = process.env.MONGO_URI_TEST
  if (!uri) throw new Error("MONGO_URI_TEST is not set - refusing to run against the real database")
  await mongoose.connect(uri)
  // The unique partial index only exists once Mongoose has built it. Without this the
  // duplicate-key error never fires and every test below passes for the wrong reason.
  await Job.syncIndexes()
})

after(async () => {
  if (mongoose.connection.readyState !== 1) return
  await Job.deleteMany({})
  await mongoose.disconnect()
})

test("the same key twice creates one job and returns the same id", async () => {
  await Job.deleteMany({})

  const first = await createJob("http_request", { url: "https://example.com/" }, undefined, 0, "order-42")
  const second = await createJob("http_request", { url: "https://example.com/" }, undefined, 0, "order-42")

  assert.strictEqual(first.created, true, "first call should create")
  assert.strictEqual(second.created, false, "second call should find the existing job")
  assert.strictEqual(String(first.job._id), String(second.job._id), "both must name the same job")
  assert.strictEqual(await Job.countDocuments({}), 1, "only one document should exist")
})

test("different keys create different jobs", async () => {
  await Job.deleteMany({})

  const a = await createJob("http_request", {}, undefined, 0, "key-a")
  const b = await createJob("http_request", {}, undefined, 0, "key-b")

  assert.notStrictEqual(String(a.job._id), String(b.job._id))
  assert.strictEqual(await Job.countDocuments({}), 2)
})

test("jobs without a key never collide with each other", async () => {
  await Job.deleteMany({})

  // This is what a plain unique index would break: every keyless job would count as a
  // duplicate null after the first. The partialFilterExpression is what saves it.
  for (let i = 0; i < 5; i++) await createJob("http_request", { n: i })

  assert.strictEqual(await Job.countDocuments({}), 5, "keyless jobs must all be allowed")
})

test("five simultaneous requests with one key produce exactly one job", async () => {
  await Job.deleteMany({})

  // The race the feature exists for: a double-click, or a client retrying a request it
  // did not know had succeeded. The unique index is the only arbiter.
  const results = await Promise.all(
    Array.from({ length: 5 }, () => createJob("http_request", {}, undefined, 0, "burst-key"))
  )

  assert.strictEqual(await Job.countDocuments({}), 1, "exactly one document should survive the race")

  const ids = new Set(results.map((r) => String(r.job._id)))
  assert.strictEqual(ids.size, 1, "every caller must be told about the same job")

  const created = results.filter((r) => r.created).length
  assert.strictEqual(created, 1, "exactly one caller should report created:true")
})

test("the key is actually persisted, not silently dropped", async () => {
  await Job.deleteMany({})

  const { job } = await createJob("http_request", {}, undefined, 0, "stored-key")
  const reread = await Job.findById(job._id).lean()

  assert.strictEqual(reread.idempotencyKey, "stored-key")
})

test("an idempotent job still carries its other fields", async () => {
  await Job.deleteMany({})

  const future = new Date(Date.now() + 60_000)
  const { job } = await createJob("http_request", { tag: "x" }, future, 7, "with-extras")
  const reread = await Job.findById(job._id).lean()

  assert.strictEqual(reread.priority, 7)
  assert.strictEqual(reread.runAt.toISOString(), future.toISOString())
  assert.strictEqual(reread.payload.tag, "x")
})
