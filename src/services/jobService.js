const Job = require("../models/Job.js");
const config = require("../config")

async function jobStats() {
  const statuses = Job.schema.path("status").enumValues;
  const rows = await Job.aggregate([
    {
      $group: { _id: "$status", count: { $sum: 1 } },
    },
  ]);

  const obj = Object.fromEntries(statuses.map((s) => [s, 0]));

  for (const row of rows) {
    if (row._id in obj) {
      obj[row._id] = row.count;
    }
  }
  obj.total = Object.values(obj).reduce((n, c) => n + c, 0);
  return obj;
}
async function createJob(type, payload, runAt, priority, idempotencyKey) {
    const pending = await Job.countDocuments({ status: "pending" })
    if (pending >= config.MAX_QUEUE_DEPTH) {
        return { job: null, created: false, full: true }
    }
    try {
    const job = await Job.create({
      type,
      payload,
      runAt,
      priority,
      idempotencyKey,
    });
    return { job, created: true };
  } catch (err) {
    if (err.code == 11000 && idempotencyKey) {
      return { job: await Job.findOne({ idempotencyKey }), created: false };
    }
    throw err;
  }
}
async function retryJob(id) {
  const job = await Job.findOneAndUpdate(
    { _id: id, status: { $in: ["dead", "failed"] } },
    {
      $set: {
        status: "pending",
        attempts: 0,
        claimedAt: null,
        finishedAt: null,
        result: null,
        runAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  return job;
}
async function cancelJob(id) {
  return await Job.deleteOne({ _id: id, status: "pending" });
}
async function listJobs(filter = {}, n = 50) {
  return await Job.find(filter).sort({ createdAt: -1 }).limit(n).lean();
}

async function getJob(id) {
  return await Job.findById(id).lean();
}

module.exports = { createJob, listJobs, getJob, jobStats, retryJob, cancelJob };
