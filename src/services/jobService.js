const Job=require("../models/Job.js")

async function createJob(type,payload) {
    return await Job.create({type,payload})
}

module.exports={createJob}