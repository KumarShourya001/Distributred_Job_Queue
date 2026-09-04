const { readSession } = require('./requireSession')
const { hasValidApiKey } = require('./auth')

function requireAuth(req, res, next) {
    if (req.method === "OPTIONS") {
        next()
        return
    }

    const userId = readSession(req)
    if (userId) {
        req.userId = userId
        next()
        return
    }

    if (hasValidApiKey(req)) {
        req.isMachine = true
        next()
        return
    }

    return res.status(401).json({ error: "Unauthorized" })
}

module.exports = { requireAuth }
