require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const { spawn } = require("node:child_process")
const path = require("node:path")
const mongoose = require("mongoose")
const Job = require("../src/models/Job")

const LEASE_MS = 2000
const HEARTBEAT_MS = 500
const JOB_MS = 5000

let worker = null
let stdout = ""

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForStatus(id, status, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await Job.findById(id).lean()
    if (last && last.status === status) return last
    await wait(150)
  }
  throw new Error(`job ${id} never reached "${status}" (last seen: ${last && last.status})`)
}

before(async () => {
  const uri = process.env.MONGO_URI_TEST
  if (!uri) throw new Error("MONGO_URI_TEST is not set - refusing to run against the real database")
  await mongoose.connect(uri)
  await Job.deleteMany({})

  worker = spawn(process.execPath, [path.join(__dirname, "..", "src", "worker", "worker.js")], {
    env: {
      ...process.env,
      MONGO_URI: uri,
      LEASE_MS: String(LEASE_MS),
      HEARTBEAT_MS: String(HEARTBEAT_MS)
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  worker.stdout.on("data", (d) => { stdout += d.toString() })
  worker.stderr.on("data", (d) => { stdout += d.toString() })

  await wait(1500)
})

after(async () => {
  if (worker) worker.kill()
  if (mongoose.connection.readyState !== 1) return
  await Job.deleteMany({})
  await mongoose.disconnect()
})

test("claimedAt keeps moving while a long job runs", async () => {
  await Job.deleteMany({})
  const job = await Job.create({ type: "sleep", payload: { ms: JOB_MS } })

  const claimed = await waitForStatus(job._id, "claimed")
  const first = claimed.claimedAt.getTime()

  await wait(HEARTBEAT_MS * 4)
  const later = await Job.findById(job._id).lean()

  assert.strictEqual(later.status, "claimed", "job should still be running")
  assert.ok(
    later.claimedAt.getTime() > first,
    `claimedAt did not advance: ${first} -> ${later.claimedAt.getTime()}. The lease is not being renewed.`
  )

  await waitForStatus(job._id, "completed")
})

test("a job outliving its lease is claimed exactly once", async () => {
  await Job.deleteMany({})
  stdout = ""

  // JOB_MS is more than double LEASE_MS, so without a heartbeat the sweeper would reclaim
  // this while it is still running and a second claim would appear.
  const job = await Job.create({ type: "sleep", payload: { ms: JOB_MS } })
  const id = String(job._id)

  const done = await waitForStatus(job._id, "completed")

  const claims = stdout.split("\n").filter((l) => l.includes("claimed") && l.includes(id)).length
  assert.strictEqual(claims, 1, `job was claimed ${claims} times; the lease was not held`)

  assert.ok(!stdout.includes("lost claim"), "no result should have been discarded")
  assert.ok(!stdout.includes("swept"), "the sweeper should not have reclaimed a live job")

  assert.strictEqual(done.attempts, 0)
  assert.deepStrictEqual(done.result, { sleptMs: JOB_MS })
})

test("the completion write still lands after the fence has moved", async () => {
  await Job.deleteMany({})
  const job = await Job.create({ type: "sleep", payload: { ms: JOB_MS } })

  const done = await waitForStatus(job._id, "completed")

  // The heartbeat rewrites claimedAt several times, so the final conditional write has to
  // match the renewed value, not the fence taken at claim time.
  assert.ok(done.finishedAt, "finishedAt should be set")
  assert.ok(
    done.claimedAt.getTime() > job.createdAt.getTime(),
    "claimedAt should reflect the last renewal"
  )
  assert.ok(done.finishedAt.getTime() - done.claimedAt.getTime() < JOB_MS,
    "duration is measured from the last renewal, not the original claim")
})

test("a genuinely stranded job is still reclaimed by the sweeper", async () => {
  await Job.deleteMany({})

  // No worker owns this one: it is inserted already 'claimed' with an expired lease,
  // simulating a worker that died mid-job. The heartbeat must not have broken recovery.
  const job = await Job.create({
    type: "sleep",
    payload: { ms: 10 },
    status: "claimed",
    claimedAt: new Date(Date.now() - LEASE_MS * 5)
  })

  const done = await waitForStatus(job._id, "completed", 20000)
  assert.deepStrictEqual(done.result, { sleptMs: 10 })
})
