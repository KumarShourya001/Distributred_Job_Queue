const Job=require("../models/Job.js")

async function jobStats() { 
    const statuses=Job.schema.path("status").enumValues
    const rows= await Job.aggregate([
        {
            $group:{_id:"$status",count:{$sum:1}}
        }]
    )
    
    const obj = Object.fromEntries(statuses.map(s => [s, 0]));
    
    for  (const row of rows){
        if(row._id in obj){
            obj[row._id]=row.count
        }
    }
    obj.total = Object.values(obj).reduce((n, c) => n + c, 0)
    return obj
 }
async function createJob(type,payload) {
    return await Job.create({type,payload})
}

async function listJobs(filter={},n=50){
    return await Job.find(filter).sort({createdAt:-1}).limit(n).lean()
}

async function getJob(id) {
    return await Job.findById(id).lean()
}

module.exports = { createJob, listJobs, getJob,jobStats } 