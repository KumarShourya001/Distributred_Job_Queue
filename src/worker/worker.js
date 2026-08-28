const config=require("../config")
const mongoose=require("mongoose")
const Job = require("../models/Job")
const { sweep } = require("./sweeper")

const MAX_ATTEMPTS=3

function sleep(ms){
    return new Promise(r=>setTimeout(r,ms))
}
async function tick() {

    try{
        const job=await Job.findOneAndUpdate({
        status:"pending"},
        {$set:{status:"claimed",claimedAt:new Date()}},
        {sort:{createdAt:1},returnDocument: 'after'},
    )
    if (!job) return
    console.log("claimed",job._id.toString())
    try{
    await sleep(500)
    if (job.payload && job.payload.shouldFail) {
        throw new Error("simulated failure")
    }
    job.status="completed"
    job.result={ok:true}
    await job.save()
    console.log("completed",job._id.toString())
    }
    catch(joberr){
        job.attempts+=1
        if(job.attempts<MAX_ATTEMPTS){
            job.status="pending"
            job.claimedAt=null
            console.log("failing,retrying" ,job._id.toString(),"attempt",job.attempts)
        }
        else{
            job.status="dead"
            console.log("failed,dead lettered",job._id.toString())
        }
        job.result={error:joberr.message}
        await job.save()
    }
}
catch(err){
    console.error("tick failed:",err)
}
}

async function main() {
    await mongoose.connect(config.mongoUri)
    console.log("worker up")
    setInterval(tick,1000)
    setInterval(sweep,5000)
}

main()
