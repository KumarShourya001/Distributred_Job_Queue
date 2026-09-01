const mongoose = require("mongoose")
const JOB_TTL_SECONDS = 604800
const jobSchema = new mongoose.Schema({
  type: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: {
    type: String,
    enum: ["pending","claimed","completed","failed","dead"],
    default: "pending"
  },
  attempts: { type: Number, default: 0 },
  runAt:{type:Date,default:Date.now},
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  claimedAt: { type: Date, default: null },
  priority:{type:Number,default:0},
    idempotencyKey: { type: String },
  finishedAt: { type: Date, default: null }


}, { timestamps: true })

jobSchema.index({ status: 1, priority: -1, createdAt: 1, runAt: 1 })

jobSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
)
jobSchema.index(
  { finishedAt: 1 },
  { expireAfterSeconds: JOB_TTL_SECONDS }
)
module.exports = mongoose.model("Job", jobSchema)