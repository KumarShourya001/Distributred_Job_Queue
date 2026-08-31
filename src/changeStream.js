const Job=require("./models/Job")
const {broadcast}=require("./ws")
function watchJobChanges(){
    const stream=Job.watch([],{fullDocument:"updateLookup"})

    stream.on("change",(change)=>{
        broadcast({
            event:change.operationType,
            job:change.fullDocument
        })
    })

    stream.on("error",(err)=>{
        console.error("change stream error :",err)

    })
    console.log("watching job changes")
    return stream
}
module.exports={watchJobChanges}