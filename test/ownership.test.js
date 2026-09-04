require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const { spawn } = require("node:child_process")
const path = require("node:path")
const mongoose = require("mongoose")
const Job = require("../src/models/Job")
const User = require("../src/models/User")

const SERVER = path.join(__dirname, "..", "src", "server.js")
const PORT = 3201
const BASE = `http://localhost:${PORT}`
const KEY = process.env.API_KEY

let proc = null
let alice = null   // "session=..." cookie strings
let bob = null

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Every request in this file goes through the real HTTP stack rather than calling the
// service directly, because the bug this file guards against lives in the wiring:
// jobService takes a scope, and a route that forgets to pass one still works perfectly
// for a single user.
const as = (cred, p, opts = {}) => {
  const headers = { ...(opts.headers || {}) }
  if (cred === "key") headers["X-API-Key"] = KEY
  else headers.cookie = cred
  return fetch(`${BASE}${p}`, { ...opts, headers })
}

async function signIn(email) {
  const body = JSON.stringify({ email, password: "longenough", name: "Test User", dob: "1995-06-15" })
  const json = { "Content-Type": "application/json" }
  await fetch(`${BASE}/auth/register`, { method: "POST", headers: json, body })
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: json, body })
  const raw = res.headers.getSetCookie
    ? res.headers.getSetCookie()[0]
    : res.headers.get("set-cookie")
  return raw.split(";")[0]
}

// Inserted directly rather than posted, so a job can be given a terminal status that
// the API has no route to produce.
const seed = (ownerId, extra = {}) =>
  Job.create({ type: "sleep", payload: { ms: 1 }, ownerId, ...extra })

// Submits one job as the given user and returns the ownerId the server stamped on it.
const ownerOf = async (cookie) => {
  const res = await as(cookie, "/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "sleep", payload: { ms: 1 } })
  })
  const { id } = await res.json()
  return (await Job.findById(id).lean()).ownerId
}

before(async () => {
  const uri = process.env.MONGO_URI_TEST
  if (!uri) throw new Error("MONGO_URI_TEST is not set")
  if (!KEY) throw new Error("API_KEY is not set")
  await mongoose.connect(uri)
  await Job.deleteMany({})
  await User.deleteMany({})

  proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), RATE_BURST: "1000" },
    stdio: "ignore"
  })

  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/health`)).status) break } catch {}
    await wait(200)
  }

  alice = await signIn("alice@example.com")
  bob = await signIn("bob@example.com")
})

after(async () => {
  if (proc) proc.kill()
  if (mongoose.connection.readyState !== 1) return
  await Job.deleteMany({})
  await User.deleteMany({})
  await mongoose.disconnect()
})

test("a submitted job is stamped with the submitter's id", async () => {
  await Job.deleteMany({})
  const aliceId = await ownerOf(alice)
  const bobId = await ownerOf(bob)

  assert.ok(aliceId, "ownerId must be set or every later scope check is vacuous")
  assert.notStrictEqual(String(aliceId), String(bobId), "two users must not share an id")
})

test("each user lists only their own jobs", async () => {
  await Job.deleteMany({})
  const aliceId = await ownerOf(alice)
  await seed(aliceId)
  const bobId = await ownerOf(bob)

  const mine = await (await as(alice, "/jobs?limit=100")).json()
  assert.strictEqual(mine.jobs.length, 2)
  assert.ok(mine.jobs.every((j) => String(j.ownerId) === String(aliceId)))

  const theirs = await (await as(bob, "/jobs?limit=100")).json()
  assert.strictEqual(theirs.jobs.length, 1)
  assert.strictEqual(String(theirs.jobs[0].ownerId), String(bobId))
})

test("a status filter does not widen the scope", async () => {
  // The filter is spread over the scope in the route. Spreading them the other way round
  // silently drops the ownerId when a status is supplied, and only then.
  await Job.deleteMany({})
  const aliceId = await ownerOf(alice)
  const bobId = await ownerOf(bob)
  await seed(bobId, { status: "dead", finishedAt: new Date() })
  await seed(aliceId, { status: "dead", finishedAt: new Date() })

  const dead = await (await as(alice, "/jobs?status=dead&limit=100")).json()
  assert.strictEqual(dead.jobs.length, 1, "alice has exactly one dead job")
  assert.strictEqual(String(dead.jobs[0].ownerId), String(aliceId))
})

test("stats are counted per user, not globally", async () => {
  // aggregate() does not cast strings to ObjectId the way find() does, so a scope built
  // from the raw JWT subject matches nothing here and every count reads zero.
  await Job.deleteMany({})
  const aliceId = await ownerOf(alice)
  await seed(aliceId)
  await ownerOf(bob)

  const mine = await (await as(alice, "/jobs/stats")).json()
  const theirs = await (await as(bob, "/jobs/stats")).json()

  assert.strictEqual(mine.total, 2, "a zero here means the scope never matched")
  assert.strictEqual(theirs.total, 1)
})

test("fetching another user's job is a 404", async () => {
  await Job.deleteMany({})
  const bobId = await ownerOf(bob)
  const bobJob = await seed(bobId)

  const res = await as(alice, `/jobs/${bobJob._id}`)
  assert.strictEqual(res.status, 404, "IDOR: a valid id must not be enough to read a job")
})

test("retrying another user's job is a 404, not a 409", async () => {
  // The regression that matters. retryJob is scoped, so it returns null and the route
  // falls through to a second lookup. If that lookup is unscoped it finds the job and
  // answers 409 "cannot retry a dead job" - which confirms the id exists AND leaks its
  // status, from an endpoint that correctly refused to act.
  await Job.deleteMany({})
  const bobId = await ownerOf(bob)
  const bobJob = await seed(bobId, { status: "dead", attempts: 3, finishedAt: new Date() })

  const res = await as(alice, `/jobs/${bobJob._id}/retry`, { method: "POST" })
  assert.strictEqual(res.status, 404, "409 here would leak both existence and status")
  assert.deepStrictEqual(await res.json(), { error: "job not found" })

  const after = await Job.findById(bobJob._id).lean()
  assert.strictEqual(after.status, "dead", "bob's job must not have been reset")
  assert.strictEqual(after.attempts, 3)
})

test("cancelling another user's job is a 404 and leaves it alone", async () => {
  await Job.deleteMany({})
  const bobId = await ownerOf(bob)
  const bobJob = await seed(bobId)

  const res = await as(alice, `/jobs/${bobJob._id}`, { method: "DELETE" })
  assert.strictEqual(res.status, 404, "a pending job is cancellable, so 409 would be a leak")

  assert.ok(await Job.findById(bobJob._id).lean(), "bob's job must still exist")
})

test("a user can still act on their own jobs", async () => {
  // Scoping every path is easy to get right by refusing everything. This is the test
  // that fails if the scope is too tight rather than too loose.
  await Job.deleteMany({})
  const aliceId = await ownerOf(alice)
  const dead = await seed(aliceId, { status: "dead", attempts: 3, finishedAt: new Date() })
  const pending = await seed(aliceId)

  assert.strictEqual((await as(alice, `/jobs/${dead._id}`)).status, 200)

  const retried = await as(alice, `/jobs/${dead._id}/retry`, { method: "POST" })
  assert.strictEqual(retried.status, 200)
  assert.strictEqual((await retried.json()).status, "pending")

  assert.strictEqual((await as(alice, `/jobs/${pending._id}`, { method: "DELETE" })).status, 204)
})

test("the API key is an operator credential and sees every user's jobs", async () => {
  await Job.deleteMany({})
  await ownerOf(alice)
  const bobJob = await seed(await ownerOf(bob))

  const all = await (await as("key", "/jobs?limit=100")).json()
  assert.strictEqual(all.jobs.length, 3, "the machine scope is {} - no ownerId filter at all")

  const stats = await (await as("key", "/jobs/stats")).json()
  assert.strictEqual(stats.total, 3)

  assert.strictEqual((await as("key", `/jobs/${bobJob._id}`)).status, 200)
})
