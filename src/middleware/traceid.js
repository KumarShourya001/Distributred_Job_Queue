const log = require("../loggers")

const INCOMING = /^[A-Za-z0-9._-]{8,64}$/

function traceids(req, res, next) {
    const start = Date.now()
    const path = req.originalUrl

    const supplied = req.headers["x-request-id"]
    const traceId = INCOMING.test(supplied || "") ? supplied : crypto.randomUUID()

    req.traceId = traceId
    res.set("X-Request-Id", traceId)

    res.on("finish", () => {
        if (path === "/health") return
        log.info("request", {
            traceId,
            method: req.method,
            path,
            status: res.statusCode,
            ms: Date.now() - start
        })
    })

    next()
}

module.exports = { traceids }
