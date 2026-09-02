require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const { spawn } = require("node:child_process")
const path = require("node:path")
const mongoose = require("mongoose")
const Job = require("../src/models/Job")

const WORKER = path.join(__dirname, "..", "src", "worker", "worker.js")
const JOB_MS = 1500
const JOB_COUNT = 8

let uri = null

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function logLines(out) {
  return out
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}


function startWorker(concurrency, onLine) {
  const w = spawn(process.execPath, [WORKER], {
    env: { ...process.env, MONGO_URI: uri, CONCURRENCY: String(concurrency) },
    stdio: ["ignore", "pipe", "pipe"]
  })
  if (onLine) {
    w.stdout.on("data", (d) => onLine(d.toString()))
    w.stderr.on("data", (d) => onLine(d.toString()))
  }
  return w
}

async function waitForAll(ids, status, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const n = await Job.countDocuments({ _id: { $in: ids }, status })
    if (n === ids.length) return
    await wait(100)
  }
  const counts = await Job.aggregate([
    { $match: { _id: { $in: ids } } },
    { $group: { _id: "$status", n: { $sum: 1 } } }
  ])
  throw new Error(`only some jobs reached "${status}" within ${timeoutMs}ms: ${JSON.stringify(counts)}`)
}

before(async () => {
  uri = process.env.MONGO_URI_TEST
  if (!uri) throw new Error("MONGO_URI_TEST is not set - refusing to run against the real database")
  await mongoose.connect(uri)
})

after(async () => {
  if (mongoose.connection.readyState !== 1) return
  await Job.deleteMany({})
  await mongoose.disconnect()
})

test("four concurrent slots finish eight jobs in well under serial time", async () => {
  await Job.deleteMany({})
  const docs = await Job.create(
    Array.from({ length: JOB_COUNT }, () => ({ type: "sleep", payload: { ms: JOB_MS } }))
  )
  const ids = docs.map((d) => d._id)

  const worker = startWorker(4)
  const started = Date.now()
  try {
    await waitForAll(ids, "completed", 40000)
  } finally {
    worker.kill()
  }
  const elapsed = Date.now() - started

  // Serial is 8 x 1500ms of sleeping plus a 1s poll between each: comfortably over 12s.
  // Four slots should land nearer 4-6s once worker startup is counted.
  assert.ok(
    elapsed < 10000,
    `expected concurrency to beat serial execution; took ${elapsed}ms, which is serial-shaped`
  )
})

test("concurrency does not let two slots take the same job", async () => {
  await Job.deleteMany({})
  let out = ""
  const docs = await Job.create(
    Array.from({ length: 6 }, () => ({ type: "sleep", payload: { ms: 300 } }))
  )
  const ids = docs.map((d) => d._id)

  const worker = startWorker(6, (chunk) => { out += chunk })
  try {
    await waitForAll(ids, "completed", 30000)
  } finally {
    worker.kill()
  }

  // Two slots racing inside one process are the same race as two worker processes.
  const entries = logLines(out)
  for (const id of ids) {
    const claims = entries.filter((e) => e.msg === "claimed" && e.jobId === String(id)).length
    assert.strictEqual(claims, 1, `job ${id} was claimed ${claims} times`)
  }
  assert.ok(!entries.some((e) => e.msg === "lost claim"), "no result should have been discarded")
  assert.strictEqual(await Job.countDocuments({ _id: { $in: ids }, attempts: 0 }), 6)
})

test("a single slot still behaves exactly as before", async () => {
  await Job.deleteMany({})
  const docs = await Job.create(
    Array.from({ length: 3 }, () => ({ type: "sleep", payload: { ms: 200 } }))
  )
  const ids = docs.map((d) => d._id)

  const worker = startWorker(1)
  try {
    await waitForAll(ids, "completed", 30000)
  } finally {
    worker.kill()
  }

  const done = await Job.find({ _id: { $in: ids } }).lean()
  assert.strictEqual(done.length, 3)
  assert.ok(done.every((j) => j.attempts === 0))
})

test("shutdown waits for every in-flight job, not just one", async () => {
  await Job.deleteMany({})
  let out = ""
  const docs = await Job.create(
    Array.from({ length: 4 }, () => ({ type: "sleep", payload: { ms: 3000 } }))
  )
  const ids = docs.map((d) => d._id)

  // process.kill(pid, "SIGTERM") does not deliver a catchable signal on Windows -- it
  // terminates the process outright, so the handler never runs. Emitting the event from
  // inside the worker exercises the same listener that a real SIGTERM would reach.
  const worker = spawn(
    process.execPath,
    ["-e", `require(${JSON.stringify(WORKER)}); setTimeout(() => process.emit("SIGTERM"), 4000)`],
    { env: { ...process.env, MONGO_URI: uri, CONCURRENCY: "4" }, stdio: ["ignore", "pipe", "pipe"] }
  )
  worker.stdout.on("data", (d) => { out += d.toString() })
  worker.stderr.on("data", (d) => { out += d.toString() })

  const exited = await new Promise((resolve) => worker.on("exit", (code) => resolve(code)))

  const completed = await Job.countDocuments({ _id: { $in: ids }, status: "completed" })
  const entries = logLines(out)
  assert.ok(entries.some((e) => e.msg === "shutdown requested" && e.signal === "SIGTERM"), "the shutdown handler should have run")
  assert.strictEqual(completed, 4, `only ${completed} of 4 in-flight jobs finished before exit`)
  assert.strictEqual(exited, 0, "a drained shutdown should exit 0")
  assert.ok(entries.some((e) => e.msg === "worker stopped cleanly"))
})
