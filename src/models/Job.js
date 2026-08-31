const mongoose = require("mongoose")

const jobSchema = new mongoose.Schema({
  type: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: {
    type: String,
    enum: ["pending","claimed","completed","failed","dead"],
    default: "pending"
  },
  attempts: { type: Number, default: 0 },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  claimedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null }
}, { timestamps: true })

jobSchema.index({ status: 1, createdAt: 1 })

module.exports = mongoose.model("Job", jobSchema)