require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const { spawn } = require("node:child_process")
const path = require("node:path")
const mongoose = require("mongoose")
const WebSocket = require("ws")
const Job = require("../src/models/Job")
const User = require("../src/models/User")
const config = require("../src/config")

const SERVER = path.join(__dirname, "..", "src", "server.js")
const PORT = 3202
const BASE = `http://localhost:${PORT}`
const WS_URL = `ws://localhost:${PORT}`
const ORIGIN = config.corsOrigin

let proc = null
let alice = null
let bob = null
const sockets = []

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

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

// Resolves either way rather than rejecting, so a refusal is an assertable value instead
// of a thrown error. A rejected upgrade surfaces as "unexpected-response" when the server
// answered with HTTP, and as "error" when it closed the socket without one.
function connect({ cookie, origin } = {}) {
  return new Promise((resolve) => {
    const headers = {}
    if (cookie) headers.cookie = cookie
    if (origin) headers.origin = origin

    const ws = new WebSocket(WS_URL, { headers })
    sockets.push(ws)
    ws.on("open", () => resolve({ accepted: true, ws }))
    ws.on("unexpected-response", (_req, res) => resolve({ accepted: false, status: res.statusCode }))
    ws.on("error", () => resolve({ accepted: false, status: null }))
  })
}

// Records every frame a socket receives so a test can assert on silence as well as delivery.
function record(ws) {
  const seen = []
  ws.on("message", (raw) => seen.push(JSON.parse(raw)))
  return seen
}

const submit = (cookie, extra = {}) =>
  fetch(`${BASE}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ type: "sleep", payload: { ms: 1 }, ...extra })
  })

before(async () => {
  const uri = process.env.MONGO_URI_TEST
  if (!uri) throw new Error("MONGO_URI_TEST is not set")
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

  alice = await signIn("wsalice@example.com")
  bob = await signIn("wsbob@example.com")
  await wait(1500) // let the change stream open before the first insert
})

after(async () => {
  sockets.forEach((ws) => { try { ws.close() } catch {} })
  if (proc) proc.kill()
  if (mongoose.connection.readyState !== 1) return
  await Job.deleteMany({})
  await User.deleteMany({})
  await mongoose.disconnect()
})

test("a connection with no session cookie is refused", async () => {
  // Before the upgrade handler existed this was the whole vulnerability: the socket
  // streamed every job on the system to anyone who could open a TCP connection.
  const res = await connect({ origin: ORIGIN })
  assert.strictEqual(res.accepted, false)
  assert.strictEqual(res.status, 401)
})

test("a valid session from a foreign origin is refused", async () => {
  // Cross-Site WebSocket Hijacking: browsers do not apply the same-origin policy to
  // WebSockets, and they attach the session cookie regardless of which page opened it.
  // Without this check any site the user visits could read their job stream.
  const res = await connect({ cookie: alice, origin: "http://evil.example.com" })
  assert.strictEqual(res.accepted, false)
  assert.strictEqual(res.status, 401)
})

test("a forged or expired session is refused", async () => {
  const forged = "session=" + require("jsonwebtoken")
    .sign({ sub: "6a98270296ce4741c54d84a5" }, "not-the-real-secret")

  const res = await connect({ cookie: forged, origin: ORIGIN })
  assert.strictEqual(res.accepted, false, "the handshake must verify the signature, not just parse the cookie")
})

test("a valid session from the allowed origin connects", async () => {
  const res = await connect({ cookie: alice, origin: ORIGIN })
  assert.strictEqual(res.accepted, true, "refusing everything would pass every test above")
})

test("a job event reaches its owner and nobody else", async () => {
  await Job.deleteMany({})
  const a = await connect({ cookie: alice, origin: ORIGIN })
  const b = await connect({ cookie: bob, origin: ORIGIN })
  const aliceSaw = record(a.ws)
  const bobSaw = record(b.ws)

  assert.strictEqual((await submit(alice)).status, 202)
  await wait(3000) // change streams are not instant

  assert.ok(aliceSaw.length >= 1, "the owner must receive their own job")
  assert.strictEqual(bobSaw.length, 0, "another user's payload must never be broadcast")

  const insert = aliceSaw.find((e) => e.event === "insert")
  assert.ok(insert, "expected an insert event")
  assert.ok(insert.job, "the job document should be attached")
})

test("both users receive their own events during the same window", async () => {
  // Filtering by ownerId is easy to get right by dropping everything. This is the test
  // that fails if the comparison is too strict rather than too loose - an ObjectId
  // compared against the JWT's string subject never matches.
  await Job.deleteMany({})
  const a = await connect({ cookie: alice, origin: ORIGIN })
  const b = await connect({ cookie: bob, origin: ORIGIN })
  const aliceSaw = record(a.ws)
  const bobSaw = record(b.ws)

  await submit(alice)
  await submit(bob)
  await wait(3000)

  assert.ok(aliceSaw.length >= 1, "alice received nothing - the owner comparison is failing")
  assert.ok(bobSaw.length >= 1, "bob received nothing - the owner comparison is failing")

  const wrong = aliceSaw
    .filter((e) => e.job)
    .filter((e) => String(e.job.ownerId) !== String(aliceSaw[0].job.ownerId))
  assert.strictEqual(wrong.length, 0, "alice received a job she does not own")
})

test("a job with no owner is broadcast to nobody", async () => {
  // The jobs that predate ownership, and anything the API key creates, carry no ownerId.
  // They must not fall through the filter into every connected dashboard.
  await Job.deleteMany({})
  const a = await connect({ cookie: alice, origin: ORIGIN })
  const aliceSaw = record(a.ws)

  await Job.create({ type: "sleep", payload: { ms: 1 } })
  await wait(3000)

  const withJob = aliceSaw.filter((e) => e.job)
  assert.strictEqual(withJob.length, 0, "an ownerless job reached a user's socket")
})

test("a socket is closed when its session expires", async () => {
  // The one line no other test reaches. The expiry timer is armed once at the
  // handshake and fires days later, so it is only observable with a token that
  // is valid on connect and expired moments after. A close code outside the
  // 3000-4999 application range throws inside ws instead of closing, which is
  // invisible until a real session runs out.
  const shortLived = "session=" + require("jsonwebtoken")
    .sign({ sub: "6a98270296ce4741c54d84a5" }, config.JWT_SECRET, { expiresIn: "2s" })

  const res = await connect({ cookie: shortLived, origin: ORIGIN })
  assert.strictEqual(res.accepted, true, "a token still valid at handshake must be accepted")

  const closed = await new Promise((resolve) => {
    res.ws.on("close", (code) => resolve(code))
    setTimeout(() => resolve(null), 8000)
  })

  assert.notStrictEqual(closed, null, "the socket outlived its session")
  assert.strictEqual(closed, 4001, "expected the application close code for an expired session")
})
