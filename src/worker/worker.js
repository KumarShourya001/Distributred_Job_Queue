const config=require("../config")
const mongoose=require("mongoose")
const Job = require("../models/Job")
const { sweep } = require("./sweeper")
const {handlers}=require("./handlers")
const { PermanentError } = require("./errors")
const { claimJob } = require("./claim")
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 10000
const BASE_DELAY_MS = 1000
const CONCURRENCY = Number(process.env.CONCURRENCY) || 1
let shuttingDown=false
let sweepTimer=null
const MAX_ATTEMPTS=3
function backoffMs(attempts) {
    let d=BASE_DELAY_MS*2**attempts
    d=Math.min(d,6000)
    d=d*(0.5+Math.random()*0.5)
    return d
}

function sleep(ms){
    return new Promise(r=>setTimeout(r,ms))
}

async function tick() {
    try{
        const fence = new Date()
        const job=await claimJob(fence)
        if (!job) return
        const id=job._id
        let currentFence=fence
        console.log("claimed",job._id.toString())
        try{
            const handler=handlers[job.type]
            if(!handler){
                throw new PermanentError(`no handler for type: ${job.type}`)
            }
            if (job.payload && job.payload.shouldFail) {
                throw new Error("simulated failure")
            }

            let inFlight=Promise.resolve()
            const heartbeat=setInterval(()=>{
                const next=new Date()
                inFlight=Job.updateOne({_id:id,claimedAt:currentFence},{$set:{claimedAt:next}})
                    .then((res)=>{ if(res.modifiedCount) currentFence=next })
                    .catch((err)=>console.error("heartbeat failed:",err.message))
            },HEARTBEAT_MS)

            let result
            try{
                result=await handler(job.payload)
            }finally{
                clearInterval(heartbeat)
                await inFlight
            }

            const done=await Job.findOneAndUpdate(
                {_id:id,claimedAt:currentFence},
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
                update = { status: "pending", claimedAt: null, attempts, result: { error: joberr.message } ,runAt:new Date(Date.now() + backoffMs(attempts))}
            } else {
                update = { status: "dead", attempts, result: { error: joberr.message }, finishedAt: new Date() }
            }

            const updated=await Job.findOneAndUpdate(
                {_id:id,claimedAt:currentFence},
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
const running = new Set()
process.on('SIGTERM',()=>requestShutdown("SIGTERM"))
process.on('SIGINT',()=>requestShutdown("SIGINT"))

async function loop() {
  while(!shuttingDown){
    while(running.size<CONCURRENCY){
        const p=tick().finally(()=>running.delete(p))
        running.add(p)
    }
    await sleep(1000)
  }
  await Promise.allSettled(running)
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
