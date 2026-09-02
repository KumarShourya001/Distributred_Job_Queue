const { assertSafeUrl } = require("./safeUrl") 
const { PermanentError } = require("./errors")

async function httpRequest(payload) {
    const { url, body } = payload
    if (!url) {
        throw new PermanentError("http_request needs a url in the payload")
    }
    await assertSafeUrl(url)
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
        redirect:"manual",
        signal: AbortSignal.timeout(10000)
    })

    if(res.status>=300 && res.status<400){
        throw new PermanentError(`redirect refused: HTTP ${res.status} to ${res.headers.get("location") ?? "unknown"}`)    }
    if (!res.ok) {
        throw new Error(`request failed: HTTP ${res.status}`)
    }
    
    return { status: res.status, url }
}

async function sleepJob(payload) {
    const ms = Number(payload.ms)

    if (!Number.isFinite(ms) || ms < 0) {
        throw new PermanentError("sleep needs a non-negative ms in the payload")
    }
    if (ms > 120000) {
        throw new PermanentError("sleep ms is capped at 120000")
    }

    await new Promise((resolve) => setTimeout(resolve, ms))

    return { sleptMs: ms }
}

async function fail(payload) {
    throw new Error(payload.message||"simulated failure")
}

const handlers = {
    http_request: httpRequest,
    sleep: sleepJob,
    fail:fail,
}

module.exports = { handlers }