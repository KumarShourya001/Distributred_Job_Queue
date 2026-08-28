const config=require("../config")
const mongoose=require("mongoose")
const Job = require("../models/Job")
const { sweep } = require("./sweeper")

let shuttingDown=false
let sweepTimer=null
const MAX_ATTEMPTS=3



function sleep(ms){
    return new Promise(r=>setTimeout(r,ms))
}
async function tick() {
    try{
        const fence = new Date()
        const job=await Job.findOneAndUpdate({
            status:"pending"},
            {$set:{status:"claimed",claimedAt:fence}},
            {sort:{createdAt:1},returnDocument: 'after'},
        )
        if (!job) return
        const id=job._id
        console.log("claimed",job._id.toString())
        try{
            await sleep(500)
            if (job.payload && job.payload.shouldFail) {
                throw new Error("simulated failure")
    }
    const done=await Job.findOneAndUpdate(
        {_id:id,claimedAt:fence},
        {$set:{status:"completed",result:{ok:true}}}
    )
    if(!done){
        console.log("lost claim,discarding result",id.toString())
        return 
    }
    
    console.log("completed",job._id.toString())
}
catch(joberr){
    const attempts=job.attempts+1
    const update=attempts<MAX_ATTEMPTS?{status:"pending",claimedAt:null,attempts,result:{error:joberr.message}}:
    {status:"dead",attempts,result:{error:joberr.message}}
    const updated=await Job.findOneAndUpdate(
        {_id:id,claimedAt:fence},
        {$set:update}
    )
    if(!updated){
        console.log("lost claim,discarding failure",id.toString())
        return
    }
    console.log(
        attempts<MAX_ATTEMPTS?`failing,retrying ${id} attempt ${attempts}`:`failed,dead lettered ${id}`
    ) 
}
}
catch(err){
    console.error("tick failed:",err)
}
}

function requestShutdown(signal){
    if(shuttingDown)return
    shuttingDown=true
    console.log(signal,"recieved-finishing current job,then exiting")
}

process.on('SIGTERM',()=>requestShutdown("SIGTERM"))
process.on('SIGINT',()=>requestShutdown("SIGINT"))

async function loop(params) {
    while(!shuttingDown){
        await tick()
        if(shuttingDown)break
        await sleep(1000)
    }
    clearInterval(sweepTimer)
    await mongoose.disconnect()
    console.log("worker stopped cleanly")
    process.exit(0)
}

async function main() {
    await mongoose.connect(config.mongoUri)
    console.log("worker up")
    sweepTimer=setInterval(sweep,5000)
    loop()
}

main()
