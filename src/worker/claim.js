const Job = require("../models/Job")
async function claimJob(fence) {
            const job=await Job.findOneAndUpdate({
             status:"pending",runAt:{$lte:new Date()}},
             {$set:{status:"claimed",claimedAt:fence}},
             {sort:{priority:-1,createdAt:1},returnDocument: 'after'},
         )
    return job
}

module.exports={claimJob}