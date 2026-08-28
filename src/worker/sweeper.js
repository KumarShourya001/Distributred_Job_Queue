const Job=require("../models/Job")

async function sweep() {
    try{
        const result =await Job.updateMany(
            {status:"claimed",claimedAt:{$lt: new Date(Date.now()-30000)}},
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
