const Job=require("../models/Job.js")

async function createJob(type,payload) {
    return await Job.create({type,payload})
}

async function listJobs(filter={},n=50){
    return await Job.find(filter).sort({createdAt:-1}).limit(n).lean()
}

async function getJob(id) {
    return await Job.findById(id).lean()
}

module.exports = { createJob, listJobs, getJob } 