require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const mongoose = require("mongoose")
const Job = require("../src/models/Job")
const { retryJob, cancelJob } = require("../src/services/jobService")

const NO_SUCH_ID = new mongoose.Types.ObjectId()

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

test("retrying a dead job resets it to a clean pending state", async () => {
  await Job.deleteMany({})
  const job = await Job.create({
    type: "sleep",
    payload: { ms: 10 },
    status: "dead",
    attempts: 3,
    result: { error: "simulated failure" },
    claimedAt: new Date(),
    finishedAt: new Date(),
    runAt: new Date(Date.now() + 60_000)
  })

  const retried = await retryJob(job._id)

  assert.ok(retried, "retryJob must return the updated job, not undefined")
  assert.strictEqual(retried.status, "pending")
  assert.strictEqual(retried.attempts, 0)
  assert.strictEqual(retried.claimedAt, null)
  assert.strictEqual(retried.finishedAt, null)
  assert.strictEqual(retried.result, null)

  // runAt has to be reset too, or a job that was backed off into the future
  // is retried into a state where nothing can claim it.
  assert.ok(retried.runAt.getTime() <= Date.now(), "runAt should be reset to now, not left in the future")
})

test("a failed job can also be retried, as a deliberate override", async () => {
  await Job.deleteMany({})
  const job = await Job.create({
    type: "sleep",
    payload: { ms: 10 },
    status: "failed",
    attempts: 1,
    result: { error: "blocked address: 169.254.169.254" }
  })

  const retried = await retryJob(job._id)
  assert.ok(retried)
  assert.strictEqual(retried.status, "pending")
  assert.strictEqual(retried.attempts, 0)
})

test("retrying a job in a non-terminal state does nothing", async () => {
  await Job.deleteMany({})

  for (const status of ["pending", "claimed", "completed"]) {
    const job = await Job.create({ type: "sleep", payload: { ms: 10 }, status })
    assert.strictEqual(await retryJob(job._id), null, `${status} should not be retryable`)

    const untouched = await Job.findById(job._id).lean()
    assert.strictEqual(untouched.status, status, `${status} job must be left alone`)
  }
})

test("retrying an id that does not exist returns null", async () => {
  assert.strictEqual(await retryJob(NO_SUCH_ID), null)
})

test("cancelling a pending job removes it", async () => {
  await Job.deleteMany({})
  const job = await Job.create({ type: "sleep", payload: { ms: 10 } })

  const result = await cancelJob(job._id)

  assert.strictEqual(result.deletedCount, 1)
  assert.strictEqual(await Job.findById(job._id), null)
})

test("cancelling a job that is already running leaves it alone", async () => {
  await Job.deleteMany({})

  // A claimed job is mid-execution. Deleting the document would not stop the work,
  // it would only make the worker's completion write silently match nothing.
  for (const status of ["claimed", "completed", "dead", "failed"]) {
    const job = await Job.create({ type: "sleep", payload: { ms: 10 }, status })

    const result = await cancelJob(job._id)
    assert.strictEqual(result.deletedCount, 0, `${status} should not be cancellable`)
    assert.ok(await Job.findById(job._id), `${status} job must still exist`)
  }
})

test("cancelling twice reports nothing deleted the second time", async () => {
  await Job.deleteMany({})
  const job = await Job.create({ type: "sleep", payload: { ms: 10 } })

  assert.strictEqual((await cancelJob(job._id)).deletedCount, 1)
  assert.strictEqual((await cancelJob(job._id)).deletedCount, 0)
})

test("a retried job keeps its idempotency key", async () => {
  await Job.deleteMany({})
  const job = await Job.create({
    type: "sleep",
    payload: { ms: 10 },
    status: "dead",
    attempts: 3,
    idempotencyKey: "keep-me"
  })

  const retried = await retryJob(job._id)

  // Retrying re-runs the same job rather than creating a new one, so the key
  // must survive -- and must not collide with itself.
  assert.strictEqual(retried.idempotencyKey, "keep-me")
  assert.strictEqual(await Job.countDocuments({ idempotencyKey: "keep-me" }), 1)
})
