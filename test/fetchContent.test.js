// Handler-level: a local server plays the remote site, so nothing here touches
// Mongo or the network. ALLOWED_HOSTS is set before the handler is required
// because config reads it once, at load — and without it assertSafeUrl would
// (correctly) refuse 127.0.0.1.
process.env.ALLOWED_HOSTS = "127.0.0.1"

const test = require("node:test")
const assert = require("node:assert")
const http = require("node:http")
const { handlers } = require("../src/worker/handlers")
const { PermanentError } = require("../src/worker/errors")

const fetchContent = handlers.fetch_content

// One server, one route per test, torn down at the end.
const routes = {}
const srv = http.createServer((req, res) => routes[req.url](req, res))
let base

test.before(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${srv.address().port}`
})

test.after(() => srv.close())

test("strips tags, scripts and styles, decodes entities, keeps the title", async () => {
  routes["/page"] = (_, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(`<html><head><title>Tom &amp; Jerry</title><style>p{color:red}</style>
      <script>alert("xss")</script></head>
      <body><h1>Heading</h1><p>first &lt;para&gt;</p><p>second</p><!-- hidden --></body></html>`)
  }
  const r = await fetchContent({ url: `${base}/page` })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.title, "Tom & Jerry")
  assert.strictEqual(r.text, "Tom & Jerry\nHeading\nfirst <para>\nsecond")
  assert.strictEqual(r.truncated, false)
  assert.ok(!r.text.includes("alert"), "script body leaked into text")
  assert.ok(!r.text.includes("color"), "style body leaked into text")
})

test("stops reading at 1 MB and marks the result truncated", async () => {
  routes["/big"] = (_, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    const chunk = "x".repeat(65536)
    let sent = 0
    const push = () => {
      while (sent < 3_000_000) {
        sent += chunk.length
        if (!res.write(chunk)) return res.once("drain", push)
      }
      res.end()
    }
    push()
  }
  const r = await fetchContent({ url: `${base}/big` })
  assert.strictEqual(r.bytes, 1_000_000)
  assert.strictEqual(r.truncated, true)
  assert.strictEqual(r.text.length, 10_000, "stored text is capped at 10 KB")
})

test("text past 10 KB is dropped from the stored result but counted in chars", async () => {
  routes["/medium"] = (_, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("y".repeat(20_000))
  }
  const r = await fetchContent({ url: `${base}/medium` })
  assert.strictEqual(r.chars, 20_000)
  assert.strictEqual(r.text.length, 10_000)
  assert.strictEqual(r.truncated, true)
})

test("refuses non-text content types permanently", async () => {
  routes["/img"] = (_, res) => {
    res.writeHead(200, { "content-type": "image/png" })
    res.end(Buffer.alloc(16))
  }
  await assert.rejects(fetchContent({ url: `${base}/img` }), PermanentError)
})

test("refuses redirects permanently", async () => {
  routes["/go"] = (_, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/" })
    res.end()
  }
  await assert.rejects(fetchContent({ url: `${base}/go` }), (err) =>
    err instanceof PermanentError && /redirect refused/.test(err.message))
})

test("a 5xx is transient, so it retries", async () => {
  routes["/down"] = (_, res) => {
    res.writeHead(503)
    res.end()
  }
  await assert.rejects(fetchContent({ url: `${base}/down` }), (err) =>
    !(err instanceof PermanentError) && /HTTP 503/.test(err.message))
})

test("missing url is permanent", async () => {
  await assert.rejects(fetchContent({}), PermanentError)
})
