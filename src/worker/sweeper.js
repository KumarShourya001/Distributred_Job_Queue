const Job = require("../models/Job")
const config = require("../config")
const log = require("../loggers")

async function sweep() {
    try {
        const cutoff = new Date(Date.now() - config.LEASE_MS)
        const exhausted = { $gte: ["$attempts", config.MAX_ATTEMPTS] }

        const result = await Job.updateMany(
            { status: "claimed", claimedAt: { $lt: cutoff } },
            [
                { $set: { attempts: { $add: ["$attempts", 1] }, claimedAt: null } },
                {
                    $set: {
                        status: { $cond: [exhausted, "dead", "pending"] },
                        finishedAt: { $cond: [exhausted, "$$NOW", null] },
                        result: {
                            $cond: [
                                exhausted,
                                { error: "worker died and the lease expired" },
                                "$result"
                            ]
                        }
                    }
                }
            ],
            { updatePipeline: true }
        )

        if (result.modifiedCount > 0) {
            log.warn("swept stranded jobs", { count: result.modifiedCount })
        }
    } catch (err) {
        log.error("sweep failed", { err: err.message })
    }
}

module.exports = { sweep }
