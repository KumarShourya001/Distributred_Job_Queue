require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const { spawn } = require("node:child_process")
const path = require("node:path")

const SERVER = path.join(__dirname, "..", "src", "server.js")
const KEY = process.env.API_KEY

// Two servers on two ports. The auth tests need to make plenty of requests without
// tripping the limiter, and the limiter tests need a small bucket to fill quickly.
// One server cannot be both, because the bucket is keyed on IP and every request
// here comes from the same one.
const AUTH_PORT = 3101
const LIMIT_PORT = 3102
const LIMIT_BURST = 5
const LIMIT_REFILL = 2

const procs = []
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function startServer(port, extraEnv) {
  const p = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      MONGO_URI: process.env.MONGO_URI_TEST,
      PORT: String(port),
      ...extraEnv
    },
    stdio: "ignore"
  })
  procs.push(p)
  return p
}

async function waitForReady(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/health`)
      if (r.status) return
    } catch {}
    await wait(200)
  }
  throw new Error(`server on port ${port} never became ready`)
}

const get = (port, p, headers) => fetch(`http://localhost:${port}${p}`, { headers })

before(async () => {
  if (!process.env.MONGO_URI_TEST) throw new Error("MONGO_URI_TEST is not set")
  if (!KEY) throw new Error("API_KEY is not set")

  startServer(AUTH_PORT, { RATE_BURST: "1000" })
  startServer(LIMIT_PORT, { RATE_BURST: String(LIMIT_BURST), RATE_REFILL_PER_SEC: String(LIMIT_REFILL) })

  await waitForReady(AUTH_PORT)
  await waitForReady(LIMIT_PORT)
})

after(async () => {
  for (const p of procs) p.kill()
})

test("a request with no API key is rejected", async () => {
  const res = await get(AUTH_PORT, "/jobs")
  assert.strictEqual(res.status, 401)
  assert.deepStrictEqual(await res.json(), { error: "Unauthorized" })
})

test("a wrong API key is rejected", async () => {
  const res = await get(AUTH_PORT, "/jobs", { "X-API-Key": "definitely-not-the-key" })
  assert.strictEqual(res.status, 401)
})

test("a wrong key of the correct length is rejected", async () => {
  // Exercises timingSafeEqual itself rather than the length guard in front of it.
  const res = await get(AUTH_PORT, "/jobs", { "X-API-Key": "x".repeat(KEY.length) })
  assert.strictEqual(res.status, 401)
})

test("every rejection gives the same body, leaking nothing", async () => {
  const missing = await (await get(AUTH_PORT, "/jobs")).text()
  const wrong = await (await get(AUTH_PORT, "/jobs", { "X-API-Key": "nope" })).text()
  assert.strictEqual(missing, wrong, "missing and wrong keys must be indistinguishable")
})

test("the correct API key is accepted", async () => {
  const res = await get(AUTH_PORT, "/jobs", { "X-API-Key": KEY })
  assert.strictEqual(res.status, 200)
  const body = await res.json()
  assert.ok(Array.isArray(body.jobs), "GET /jobs returns { jobs, nextCursor }")
})

test("the header name is case-insensitive", async () => {
  const res = await get(AUTH_PORT, "/jobs", { "x-api-key": KEY })
  assert.strictEqual(res.status, 200, "req.get() must not care about header casing")
})

test("/health needs no key", async () => {
  // The Docker healthcheck sends no credentials. If this ever 401s, the container
  // reports unhealthy and restart:unless-stopped puts it in a loop.
  const res = await get(AUTH_PORT, "/health")
  assert.strictEqual(res.status, 200)
})

test("a CORS preflight is not blocked by auth", async () => {
  // Browsers do not send custom headers on preflight, so it can never carry the key.
  const res = await fetch(`http://localhost:${AUTH_PORT}/jobs`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "X-API-Key"
    }
  })
  assert.strictEqual(res.status, 204)
  assert.match(res.headers.get("access-control-allow-headers") || "", /x-api-key/i)
})

test("a 401 still carries CORS headers", async () => {
  // Auth is mounted after cors. Reverse them and a browser reports a CORS failure
  // instead of a 401, which sends you debugging the wrong thing entirely.
  const res = await get(AUTH_PORT, "/jobs", { Origin: "http://localhost:5173" })
  assert.strictEqual(res.status, 401)
  assert.ok(res.headers.get("access-control-allow-origin"), "401 must include CORS headers")
})

test("a burst beyond the bucket capacity is rejected with 429", async () => {
  const codes = []
  for (let i = 0; i < LIMIT_BURST + 6; i++) {
    codes.push((await get(LIMIT_PORT, "/jobs", { "X-API-Key": KEY })).status)
  }

  assert.ok(codes.includes(429), `expected a 429 in ${codes.join(",")}`)
  const allowed = codes.filter((c) => c === 200).length
  // Refill happens while the burst is in flight, so allowed >= capacity, not == capacity.
  assert.ok(allowed >= LIMIT_BURST, `expected at least ${LIMIT_BURST} allowed, got ${allowed}`)
  assert.ok(allowed < LIMIT_BURST + 6, "the limiter allowed everything - is the bucket stored in the Map?")
})

test("a 429 carries a usable Retry-After header", async () => {
  let res
  for (let i = 0; i < LIMIT_BURST + 10; i++) {
    res = await get(LIMIT_PORT, "/jobs", { "X-API-Key": KEY })
    if (res.status === 429) break
  }
  assert.strictEqual(res.status, 429)

  const retryAfter = Number(res.headers.get("retry-after"))
  assert.ok(Number.isInteger(retryAfter), "Retry-After must be an integer number of seconds")
  assert.ok(retryAfter >= 1 && retryAfter <= 10, `Retry-After ${retryAfter} is not a sane value`)
})

test("tokens come back after waiting", async () => {
  for (let i = 0; i < LIMIT_BURST + 10; i++) {
    await get(LIMIT_PORT, "/jobs", { "X-API-Key": KEY })
  }
  assert.strictEqual((await get(LIMIT_PORT, "/jobs", { "X-API-Key": KEY })).status, 429, "should be drained")

  await wait(2500)

  const res = await get(LIMIT_PORT, "/jobs", { "X-API-Key": KEY })
  assert.strictEqual(res.status, 200, "the bucket should have refilled")
})

test("the rate limiter runs before auth", async () => {
  // Unauthenticated requests must consume tokens too, or someone guessing keys
  // gets unlimited attempts.
  for (let i = 0; i < LIMIT_BURST + 10; i++) {
    await get(LIMIT_PORT, "/jobs", { "X-API-Key": "wrong" })
  }
  const res = await get(LIMIT_PORT, "/jobs", { "X-API-Key": "wrong" })
  assert.strictEqual(res.status, 429, "a flood of bad keys should be rate limited, not 401'd forever")
})

test("/health is exempt from rate limiting", async () => {
  // Mounted on /jobs, so /health is never touched. Docker polls it every 30s forever.
  for (let i = 0; i < LIMIT_BURST + 10; i++) {
    await get(LIMIT_PORT, "/jobs", { "X-API-Key": KEY })
  }
  assert.strictEqual((await get(LIMIT_PORT, "/health")).status, 200)
})
