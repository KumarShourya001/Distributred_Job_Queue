require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const mongoose = require("mongoose")
const Job = require("../src/models/Job")
const { watchJobChanges } = require("../src/changeStream")

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate, timeoutMs = 15000, label = "condition") {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await wait(50)
  }
  throw new Error(`${label} never became true within ${timeoutMs}ms`)
}

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

test("changes are forwarded to the event handler", async () => {
  await Job.deleteMany({})
  const seen = []
  const watcher = watchJobChanges((e) => seen.push(e))

  try {
    await wait(800)
    const job = await Job.create({ type: "sleep", payload: { ms: 1 } })
    await waitFor(() => seen.some((e) => e.event === "insert"), 15000, "insert event")

    const insert = seen.find((e) => e.event === "insert")
    assert.strictEqual(String(insert.job._id), String(job._id))
  } finally {
    await watcher.close()
  }
})

test("the stream reconnects and keeps delivering after being killed", async () => {
  await Job.deleteMany({})
  const seen = []
  const watcher = watchJobChanges((e) => seen.push(e))

  try {
    await wait(800)
    await Job.create({ type: "sleep", payload: { ms: 1, tag: "before" } })
    await waitFor(() => seen.length >= 1, 15000, "first event")
    const before = seen.length

    // Kill the underlying cursor out from under the watcher. This is what a network
    // blip looks like: the stream errors, and without resume logic it stays dead.
    await mongoose.connection.db.admin().command({
      killCursors: "jobs",
      cursors: []
    }).catch(() => {})
    await mongoose.connection.close(false).catch(() => {})
    await mongoose.connect(process.env.MONGO_URI_TEST)

    await wait(3000)
    await Job.create({ type: "sleep", payload: { ms: 1, tag: "after" } })

    await waitFor(() => seen.length > before, 20000, "an event after the disruption")
  } finally {
    await watcher.close()
  }
})

test("close stops the watcher for good", async () => {
  await Job.deleteMany({})
  const seen = []
  const watcher = watchJobChanges((e) => seen.push(e))

  await wait(800)
  await Job.create({ type: "sleep", payload: { ms: 1 } })
  await waitFor(() => seen.length >= 1, 15000, "first event")

  await watcher.close()
  const afterClose = seen.length

  await Job.create({ type: "sleep", payload: { ms: 1 } })
  await wait(2500)

  assert.strictEqual(seen.length, afterClose, "no events should arrive after close()")
})

test("close is safe to call when nothing has happened yet", async () => {
  const watcher = watchJobChanges(() => {})
  await assert.doesNotReject(() => watcher.close())
})
