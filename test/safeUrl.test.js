const test = require("node:test")
const assert = require("node:assert")
const { assertSafeUrl, isBlockedAddress } = require("../src/worker/safeUrl")
const { PermanentError } = require("../src/worker/errors")


// These assume ALLOWED_HOSTS is unset. If it is set, assertSafeUrl short-circuits to the
// allowlist and the denylist cases below never run.
const BLOCKED_V4 = [
  "169.254.169.254",   // cloud metadata -- the attack this exists for
  "127.0.0.1",         // loopback: our own API
  "10.0.0.5",          // RFC1918
  "172.16.0.1",        // RFC1918 lower edge
  "172.31.255.255",    // RFC1918 upper edge
  "192.168.1.1",       // RFC1918
  "0.0.0.0",           // "this host"
  "100.64.0.1"         // carrier-grade NAT
]

const BLOCKED_V6 = ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1"]

const BLOCKED_MAPPED = [
  "::ffff:169.254.169.254",   // dotted spelling
  "::ffff:a9fe:a9fe",         // hex spelling -- a9fe = 169.254
  "::ffff:127.0.0.1"
]

const PUBLIC = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]

test("isBlockedAddress blocks private, loopback and link-local IPv4", () => {
  for (const ip of BLOCKED_V4) {
    assert.strictEqual(isBlockedAddress(ip), true, `${ip} should be blocked`)
  }
})

test("isBlockedAddress blocks IPv6 loopback and local ranges", () => {
  for (const ip of BLOCKED_V6) {
    assert.strictEqual(isBlockedAddress(ip), true, `${ip} should be blocked`)
  }
})

test("isBlockedAddress unwraps IPv4-mapped IPv6 in both spellings", () => {
  for (const ip of BLOCKED_MAPPED) {
    assert.strictEqual(isBlockedAddress(ip), true, `${ip} should be blocked`)
  }
})

test("isBlockedAddress allows ordinary public addresses", () => {
  for (const ip of PUBLIC) {
    assert.strictEqual(isBlockedAddress(ip), false, `${ip} should be allowed`)
  }
})

test("isBlockedAddress refuses anything that is not an IP", () => {
  assert.strictEqual(isBlockedAddress("not-an-ip"), true)
  assert.strictEqual(isBlockedAddress(""), true)
})

test("assertSafeUrl rejects the cloud metadata endpoint", async () => {
  await assert.rejects(
    assertSafeUrl("http://169.254.169.254/latest/meta-data/"),
    (err) => err instanceof PermanentError && /blocked address/i.test(err.message)
  )
})

test("assertSafeUrl rejects loopback and private addresses", async () => {
  for (const url of ["http://127.0.0.1:3000/jobs", "http://10.0.0.5/admin", "http://192.168.1.1/"]) {
    await assert.rejects(assertSafeUrl(url), PermanentError, `${url} should be rejected`)
  }
})

test("assertSafeUrl rejects non-http protocols", async () => {
  await assert.rejects(assertSafeUrl("file:///etc/passwd"), /blocked protocol/)
  await assert.rejects(assertSafeUrl("ftp://example.com/x"), /blocked protocol/)
})

test("assertSafeUrl rejects bracketed IPv6 loopback", async () => {
  await assert.rejects(assertSafeUrl("http://[::1]:3000"), PermanentError)
})

test("assertSafeUrl rejects the IPv4-mapped bypass", async () => {
  await assert.rejects(assertSafeUrl("http://[::ffff:169.254.169.254]/"), PermanentError)
})

test("assertSafeUrl rejects malformed input", async () => {
  await assert.rejects(assertSafeUrl("not-a-url"), /not a valid|not Valid/i)
  await assert.rejects(assertSafeUrl(""), /non.empty string/i)
  await assert.rejects(assertSafeUrl(undefined), /non.empty string/i)
})

test("assertSafeUrl rejects localhost by resolving it", async () => {
  await assert.rejects(assertSafeUrl("http://localhost:27017"), PermanentError)
})

test("a DNS failure is retryable, not permanent", async () => {
  await assert.rejects(
    assertSafeUrl("http://this-host-does-not-exist-xyz123.invalid/"),
    (err) => err instanceof Error && !(err instanceof PermanentError)
  )
})

test("assertSafeUrl allows a public host (needs network)", async () => {
  const parsed = await assertSafeUrl("https://example.com/webhook")
  assert.strictEqual(parsed.hostname, "example.com")
})