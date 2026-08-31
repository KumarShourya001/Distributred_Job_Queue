const Job=require("../models/Job")
const LEASE_MS = Number(process.env.LEASE_MS) || 30000
async function sweep() {
    try{
        const result =await Job.updateMany(
            {status:"claimed",claimedAt:{$lt: new Date(Date.now()-LEASE_MS)}},
            {$set: {status:"pending",claimedAt:null}}
        )
            if (result.modifiedCount>0){
                console.log("swept",result.modifiedCount,"stranded Job(s)")

            }
    }
    catch(err){
        console.error("sweep failed",err)
    }
}
module.exports={sweep}
