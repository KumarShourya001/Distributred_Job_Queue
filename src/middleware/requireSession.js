const { verify, SESSION_COOKIE,verifyFull } = require('../session')

function parseCookies(header) {
    const cookies = {}
    if (!header) return cookies
    header.split(/;\s*/).forEach((cookie) => {
        const eq = cookie.indexOf("=")
        if (eq === -1) return
        cookies[cookie.slice(0, eq)] = decodeURIComponent(cookie.slice(eq + 1))
    })
    return cookies
}

function readSession(req) {
    const cookies = parseCookies(req.headers.cookie)
    return verify(cookies[SESSION_COOKIE])
}
function readSessionPayload(req){
    const cookie=parseCookies(req.headers.cookie)
    return verifyFull(cookie[SESSION_COOKIE])
}
function requireSession(req, res, next) {
    if (req.method === "OPTIONS") {
        next()
        return
    }
    const userId = readSession(req)
    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" })
    }
    req.userId = userId
    next()
}

module.exports = { requireSession, readSession,readSessionPayload }
