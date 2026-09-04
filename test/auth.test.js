require("dotenv").config()
const { test, before, after } = require("node:test")
const assert = require("node:assert")
const mongoose = require("mongoose")
const jwt = require("jsonwebtoken")
const User = require("../src/models/User")
const { register, login } = require("../src/controllers/authController")
const session = require("../src/session")
const config = require("../src/config")

function fakeRes() {
  const r = { code: null, body: null, cookies: {} }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.body = b; return r }
  r.cookie = (name, value, opts) => { r.cookies[name] = { value, opts }; return r }
  r.clearCookie = (name) => { delete r.cookies[name]; return r }
  return r
}

const callRegister = async (body) => { const res = fakeRes(); await register({ body }, res); return res }
const callLogin = async (body) => { const res = fakeRes(); await login({ body }, res); return res }

// Every field registerSchema requires, in one place. Tests that care about a single
// field override just that one, so adding a required field later touches this line
// only - not the eight tests below it.
const VALID = {
  email: "alice@example.com",
  password: "longenough",
  name: "Alice Example",
  dob: "1995-06-15"
}
const signUp = (over = {}) => callRegister({ ...VALID, ...over })

before(async () => {
  const uri = process.env.MONGO_URI_TEST
  if (!uri) throw new Error("MONGO_URI_TEST is not set")
  await mongoose.connect(uri)
  await User.syncIndexes()
})

after(async () => {
  if (mongoose.connection.readyState !== 1) return
  await User.deleteMany({})
  await mongoose.disconnect()
})

test("a valid signup creates exactly one user", async () => {
  await User.deleteMany({})
  const res = await signUp()

  assert.strictEqual(res.code, 201)
  assert.strictEqual(await User.countDocuments({}), 1)
})

test("the stored email is normalised and the hash is not the password", async () => {
  await User.deleteMany({})
  await signUp({ email: "  ALICE@Example.COM  " })

  const stored = await User.findOne({}).select("+passwordHash").lean()
  assert.strictEqual(stored.Email, "alice@example.com", "zod trims and lowercases before the query")
  assert.strictEqual(stored.name, "Alice Example", "a field the schema does not declare is dropped silently")
  assert.strictEqual(stored.dob.toISOString().slice(0, 10), "1995-06-15", "dob must be stored as a Date, not a string")
  assert.notStrictEqual(stored.passwordHash, "longenough", "the password must never be stored as given")
  assert.ok(stored.passwordHash.startsWith("$2"), "expected a bcrypt hash")
})

test("passwordHash is hidden unless explicitly selected", async () => {
  await User.deleteMany({})
  await signUp()

  const plain = await User.findOne({}).lean()
  assert.ok(!("passwordHash" in plain), "an accidental res.json(user) must not leak the hash")
})

test("registering an existing email is indistinguishable from a new one", async () => {
  await User.deleteMany({})
  const first = await signUp()
  const second = await signUp({ password: "different1" })

  assert.strictEqual(first.code, second.code, "a different status code enumerates users")
  assert.deepStrictEqual(first.body, second.body, "a different body enumerates users")
  assert.strictEqual(await User.countDocuments({}), 1, "the duplicate must not create a second user")
})

test("concurrent signups for one email create exactly one user", async () => {
  // No pre-check exists any more: the unique index is the only arbiter, exactly like
  // the atomic claim and the idempotency key.
  await User.deleteMany({})
  const results = await Promise.all(
    Array.from({ length: 5 }, () => signUp({ email: "race@example.com" }))
  )

  assert.ok(results.every((r) => r.code === 201), "every caller should get the same answer")
  assert.strictEqual(await User.countDocuments({}), 1)
})

test("signup rejects bad input with 400, not 500", async () => {
  await User.deleteMany({})
  const tooYoung = new Date()
  tooYoung.setFullYear(tooYoung.getFullYear() - 5)

  for (const body of [
    {},
    { email: "alice@example.com" },
    { ...VALID, email: "notanemail" },
    { ...VALID, password: "short" },
    { ...VALID, password: 12345678 },
    { ...VALID, name: undefined },
    { ...VALID, name: "   " },
    { ...VALID, name: "x".repeat(81) },
    { ...VALID, dob: undefined },
    { ...VALID, dob: "not-a-date" },
    { ...VALID, dob: "3000-01-01" },
    { ...VALID, dob: "1823-04-01" },
    { ...VALID, dob: tooYoung.toISOString().slice(0, 10) }
  ]) {
    const res = await callRegister(body)
    assert.strictEqual(res.code, 400, `expected 400 for ${JSON.stringify(body)}`)
  }
  assert.strictEqual(await User.countDocuments({}), 0)
})

test("login succeeds with the right password", async () => {
  await User.deleteMany({})
  await signUp()

  const res = await callLogin({ email: "alice@example.com", password: "longenough" })
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.loggedIn, true)
})

test("login is case-insensitive about the email", async () => {
  await User.deleteMany({})
  await signUp()

  const res = await callLogin({ email: "  ALICE@Example.COM ", password: "longenough" })
  assert.strictEqual(res.code, 200, "normalisation must apply on both sides or nobody can log in")
})

test("a wrong password and an unknown email are indistinguishable", async () => {
  await User.deleteMany({})
  await signUp()

  const wrongPassword = await callLogin({ email: "alice@example.com", password: "wrongpassword" })
  const noSuchUser = await callLogin({ email: "nobody@example.com", password: "longenough" })

  assert.strictEqual(wrongPassword.code, 401)
  assert.strictEqual(noSuchUser.code, 401)
  assert.deepStrictEqual(wrongPassword.body, noSuchUser.body, "differing bodies let an attacker enumerate accounts")
})

test("login rejects malformed input with 400", async () => {
  const res = await callLogin({ email: "notanemail", password: "x" })
  assert.strictEqual(res.code, 400)
})

test("a signed session verifies back to the same user id", async () => {
  const id = "6a98270296ce4741c54d84a5"
  assert.strictEqual(session.verify(session.sign(id)), id)
})

test("a tampered or malformed token verifies to null", async () => {
  const token = session.sign("6a98270296ce4741c54d84a5")

  assert.strictEqual(session.verify(token.slice(0, -2) + "xx"), null, "signature must be checked")
  assert.strictEqual(session.verify("not-a-token"), null)
  assert.strictEqual(session.verify(""), null)
  assert.strictEqual(session.verify(undefined), null)
})

test("an expired token verifies to null", async () => {
  const expired = jwt.sign({ sub: "6a98270296ce4741c54d84a5" }, config.JWT_SECRET, { expiresIn: "-1s" })
  assert.strictEqual(session.verify(expired), null)
})

test("a token signed with a different secret is rejected", async () => {
  const forged = jwt.sign({ sub: "6a98270296ce4741c54d84a5" }, "not-the-real-secret", { expiresIn: "7d" })
  assert.strictEqual(session.verify(forged), null)
})

test("the token payload carries nothing but the user id", async () => {
  // A JWT payload is base64, not encrypted - anyone holding the cookie can read it.
  const token = session.sign("6a98270296ce4741c54d84a5")
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString())

  assert.deepStrictEqual(Object.keys(payload).sort(), ["exp", "iat", "sub"])
})

test("cookie options are safe by default", async () => {
  const o = session.cookieOptions
  assert.strictEqual(o.httpOnly, true, "JavaScript must not be able to read the session")
  assert.strictEqual(o.sameSite, "lax", "CSRF protection for a same-origin deployment")
  assert.strictEqual(o.path, "/", "must be sent to /jobs and the WebSocket, not just /auth")
  assert.strictEqual(o.secure, config.IS_PRODUCTION, "secure:true breaks login over plain http in dev")
})
