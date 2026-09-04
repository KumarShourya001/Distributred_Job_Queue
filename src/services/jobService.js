const Job = require("../models/Job.js");
const config = require("../config")
const mongoose = require("mongoose")

async function jobStats(scope = {}) {
  const statuses = Job.schema.path("status").enumValues;
  const rows = await Job.aggregate([
    { $match: scope },
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
async function createJob({ type, payload, runAt, priority, idempotencyKey, traceId,ownerId } = {}) {
  const now = new Date();
  const isScheduled = Boolean(runAt) && runAt > now;

  if (isScheduled) {
    const scheduled = await Job.countDocuments({
      status: "pending",
      runAt: { $gt: now },
    });
    if (scheduled >= config.MAX_SCHEDULED) {
      return { job: null, created: false, full: "scheduled" };
    }
  } else {
    const runnable = await Job.countDocuments({
      status: "pending",
      runAt: { $lte: now },
    });
    if (runnable >= config.MAX_QUEUE_DEPTH) {
      return { job: null, created: false, full: "queue" };
    }
  }

  try {
    const job = await Job.create({
      type,
      payload,
      runAt,
      priority,
      traceId,
      idempotencyKey,
      ownerId,
    });
    return { job, created: true };
  } catch (err) {
    if (err.code == 11000 && idempotencyKey) {
      return { job: await Job.findOne({ idempotencyKey }), created: false };
    }
    throw err;
  }
}
async function retryJob(id, scope = {}) {
  const job = await Job.findOneAndUpdate(
    { ...scope, _id: id, status: { $in: ["dead", "failed"] } },
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
async function cancelJob(id, scope = {}) {
  return await Job.deleteOne({ ...scope, _id: id, status: "pending" });
}
async function listJobs(filter = {}, n = 50, cursor = null) {
  const query = cursor
    ? { ...filter, _id: { $lt: new mongoose.Types.ObjectId(cursor) } }
    : filter;

  const rows = await Job.find(query).sort({ _id: -1 }).limit(n + 1).lean();

  const hasMore = rows.length > n;
  const jobs = hasMore ? rows.slice(0, n) : rows;

  return {
    jobs,
    nextCursor: hasMore ? String(jobs[jobs.length - 1]._id) : null,
  };
}


async function getJob(id, scope = {}) {
  return await Job.findOne({ ...scope, _id: id }).lean();
}

module.exports = { createJob, listJobs, getJob, jobStats, retryJob, cancelJob };
