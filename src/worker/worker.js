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
const log = require("../loggers")
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
        const traceId=job.traceId
        let currentFence=fence
        log.info("claimed", { jobId: id.toString(), type: job.type, traceId })
        try{
            const handler=handlers[job.type]
            if(!handler){
                throw new PermanentError(`no handler for type: ${job.type}`)
            }
            

            let inFlight=Promise.resolve()
            const heartbeat=setInterval(()=>{
                const next=new Date()
                inFlight=Job.updateOne({_id:id,claimedAt:currentFence},{$set:{claimedAt:next}})
                    .then((res)=>{ if(res.modifiedCount) currentFence=next })
                    .catch((err)=>log.error("heartbeat failed", { jobId: id.toString(), err: err.message, traceId }))
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
                log.warn("lost claim", { jobId: id.toString(), discarded: "result", traceId })
                return
            }

            log.info("completed", { jobId: id.toString(), traceId })
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
                log.warn("lost claim", { jobId: id.toString(), discarded: "failure", traceId })
                return
            }
            log.info("job settled", { jobId: id.toString(), status: update.status, attempts, traceId })
        }
    }
    catch(err){
        log.error("tick failed", { err: err.message })
    }
}

function requestShutdown(signal){
    if(shuttingDown)return
    shuttingDown=true
    log.info("shutdown requested", { signal })
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
  log.info("worker stopped cleanly")
  process.exit(0)
}

async function main() {
    await mongoose.connect(config.mongoUri)
    log.info("worker up", { concurrency: CONCURRENCY })
    sweepTimer=setInterval(sweep,5000)
    loop()
}

main().catch((err) => {
  console.error("worker failed to start:", err.message)
  process.exit(1)
})
