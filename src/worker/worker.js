const config=require("../config")
const mongoose=require("mongoose")
const Job = require("../models/Job")
const { sweep } = require("./sweeper")
const {handlers}=require("./handlers")
const { PermanentError } = require("./errors")

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
            const handler=handlers[job.type]
            if(!handler){
                throw new PermanentError(`no handler for type: ${job.type}`)
            }
            if (job.payload && job.payload.shouldFail) {
                throw new Error("simulated failure")
            }
    const result=await handler(job.payload)
    const done=await Job.findOneAndUpdate(
        {_id:id,claimedAt:fence},
        {$set:{status:"completed",result,finishedAt:new Date()}}
    )
    if(!done){
        console.log("lost claim,discarding result",id.toString())
        return 
    }
    
    console.log("completed",job._id.toString())
}
catch(joberr){
    const attempts=job.attempts+1
    let update
    if (joberr instanceof PermanentError) {
        update = { status: "failed", attempts, result: { error: joberr.message }, finishedAt: new Date() }
    } else if (attempts < MAX_ATTEMPTS) {
        update = { status: "pending", claimedAt: null, attempts, result: { error: joberr.message } }
    } else {
        update = { status: "dead", attempts, result: { error: joberr.message }, finishedAt: new Date() }
    }

    const updated=await Job.findOneAndUpdate(
        {_id:id,claimedAt:fence},
        {$set:update}
    )
    if(!updated){
        console.log("lost claim,discarding failure",id.toString())
        return
    }
    console.log(`${update.status} ${id} attempt ${attempts}`)
}
}
catch(err){
    console.error("tick failed:",err)
}
}

function requestShutdown(signal){
    if(shuttingDown)return
    shuttingDown=true
    console.log(signal,"received - finishing current job, then exiting")
}

process.on('SIGTERM',()=>requestShutdown("SIGTERM"))
process.on('SIGINT',()=>requestShutdown("SIGINT"))

async function loop() {
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

main().catch((err) => {
  console.error("worker failed to start:", err.message)
  process.exit(1)
})