const express = require("express");
const router = express.Router();
const { handlers } = require("../worker/handlers");
const { z } = require("zod");
const {
  createJob,
  listJobs,
  getJob,
  jobStats,
  retryJob,
  cancelJob,
} = require("../services/jobService");
const  config = require("../config/index");
const mongoose = require("mongoose");

const jobTypes = Object.keys(handlers);
const schema = z.object({
  type: z.enum(jobTypes),
  payload: z.record(z.any()).default({}),
  runAt: z.coerce.date().refine((val)=>val<Date.now()+config.MAX_RUNAT_DAYS*86400000,{message:"LIMIT EXCEEDED"}).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  priority: z.coerce.number().int().min(-10).max(10).default(0),
});

const listQuerySchema = z.object({
  status: z
    .enum(["pending", "claimed", "completed", "failed", "dead"])
    .optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  cursor: z.string().regex(/^[0-9a-f]{24}$/i).optional(),
});

const ownerScope = (req) => {
  if (req.isMachine) return {};
  return { ownerId: new mongoose.Types.ObjectId(req.userId) };
};

router.get("/stats", async (req, res) => {
  res.json(await jobStats(ownerScope(req)));
});
router.get("/", async (req, res) => {
  const result = listQuerySchema.safeParse(req.query);
  if (!result.success) {
    return res.status(400).json({ error: "invalid request query" });
  }
  const { status, limit, cursor } = result.data;
  const filter = { ...ownerScope(req), ...(status ? { status } : {}) };
  const { jobs, nextCursor } = await listJobs(filter, limit, cursor);
  res.json({ jobs, nextCursor });
});

router.get("/:id", async (req, res) => {
  const job = await getJob(req.params.id, ownerScope(req));
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }
  res.json(job);
});

router.post("/", async (req, res) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "invalid request body" });
  }
  const { job, created,full } = await createJob({ ...result.data, traceId: req.traceId,ownerId:req.userId });
  if (full) {
    const scheduled = full === "scheduled";
    res.set("Retry-After", scheduled ? "300" : "30");
    return res.status(503).json({
      error: scheduled ? "too many scheduled jobs" : "queue is full",
    });
  }
  res.status(created ? 202 : 200).json({ id: job._id });
});
router.post("/:id/retry", async (req, res) => {
  const job = await retryJob(req.params.id, ownerScope(req));
  if (job) {
    return res.json(job);
  }
  const existing = await getJob(req.params.id, ownerScope(req));
  if (!existing) {
    return res.status(404).json({ error: "job not found" });
  }
  res.status(409).json({ error: `cannot retry a ${existing.status} job` });
});
router.delete("/:id", async (req, res) => {
  const result = await cancelJob(req.params.id, ownerScope(req));

  if (result.deletedCount) {
    return res.sendStatus(204);
  }

  const existing = await getJob(req.params.id, ownerScope(req));
  if (!existing) {
    return res.status(404).json({ error: "job not found" });
  }

  res.status(409).json({ error: `cannot cancel a ${existing.status} job` });
});
module.exports = router;
