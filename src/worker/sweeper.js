const Job=require("../models/Job")
const LEASE_MS = Number(process.env.LEASE_MS) || 30000
const log = require("../loggers")
async function sweep() {
    try{
        const result =await Job.updateMany(
            {status:"claimed",claimedAt:{$lt: new Date(Date.now()-LEASE_MS)}},
            {$set: {status:"pending",claimedAt:null}}
        )
            if (result.modifiedCount>0){
                log.warn("swept stranded jobs", { count: result.modifiedCount })

            }
    }
    catch(err){
        log.error("sweep failed", { err: err.message })
    }
}
module.exports={sweep}
