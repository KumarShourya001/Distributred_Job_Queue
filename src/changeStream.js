const Job=require("./models/Job")
const {broadcast}=require("./ws")

const log = require("./loggers")
function watchJobChanges(onEvent = broadcast){
    let stream = null
    let resumeToken = null
    let attempts = 0
    let stopped = false
    let timer = null    
    function start(){

        const options={fullDocument:"updateLookup"}
        if(resumeToken)options.resumeAfter=resumeToken
    
        stream=Job.watch([],options)
    
        stream.on("change",(change)=>{
            resumeToken=change._id
            attempts=0
            onEvent({
                event:change.operationType,
                job:change.fullDocument
            })
        })
        
        stream.on("error",(err)=>{
           if (err.code === 286) {
            resumeToken = null
            onEvent({ event: "resync" })
        }
        reconnect(err)
     })
    }
    function reconnect(err){
        if(stopped|| timer)return
        log.error("change stream error", { err: err.message })
        const delay=Math.min(1000*2**attempts,30000)
        attempts++
        timer=setTimeout(()=>{timer=null;start()},delay)
    }
    function close(){
        stopped=true
        clearTimeout(timer)
        return stream?stream.close():Promise.resolve()
    }
    start()
    log.info("watching job changes")
    return {close}
}
module.exports={watchJobChanges}