require("dotenv").config()
const mongoose = require("mongoose")
const Job = require("../src/models/Job")

const args = process.argv.slice(2)
const flag = (name) => args.includes("--" + name)
const value = (name) => {
  const i = args.indexOf("--" + name)
  return i === -1 ? null : args[i + 1]
}

const USAGE = `
Bulk-delete jobs. Dry run by default; pass --yes to actually delete.

  --status <s>        pending | claimed | completed | failed | dead
  --scheduled         only pending jobs whose runAt is in the future
  --due               only pending jobs whose runAt has passed
  --older-than <days> only jobs created more than N days ago
  --test              act on MONGO_URI_TEST instead of MONGO_URI
  --yes               perform the delete (otherwise counts only)

At least one filter is required, so a bare run can never wipe the collection.

  node scripts/purge.js --status pending --scheduled
  node scripts/purge.js --status dead --older-than 7 --yes
`

;(async () => {
  if (flag("help") || args.length === 0) {
    console.log(USAGE)
    process.exit(0)
  }

  const filter = {}
  const status = value("status")
  if (status) filter.status = status
  if (flag("scheduled")) filter.runAt = { $gt: new Date() }
  if (flag("due")) filter.runAt = { $lte: new Date() }

  const days = value("older-than")
  if (days) {
    if (!Number.isFinite(Number(days))) {
      console.error("--older-than needs a number of days")
      process.exit(1)
    }
    filter.createdAt = { $lt: new Date(Date.now() - Number(days) * 86400000) }
  }

  if (Object.keys(filter).length === 0) {
    console.error("refusing to run with no filter - see --help")
    process.exit(1)
  }

  const uri = flag("test") ? process.env.MONGO_URI_TEST : process.env.MONGO_URI
  if (!uri) {
    console.error(flag("test") ? "MONGO_URI_TEST is not set" : "MONGO_URI is not set")
    process.exit(1)
  }

  await mongoose.connect(uri)

  const target = flag("test") ? "TEST" : "REAL"
  const matched = await Job.countDocuments(filter)
  const total = await Job.countDocuments({})

  console.log(`database : ${target}`)
  console.log(`filter   : ${JSON.stringify(filter)}`)
  console.log(`matched  : ${matched} of ${total} documents`)

  if (!flag("yes")) {
    console.log("\ndry run - nothing deleted. Re-run with --yes to proceed.")
    await mongoose.disconnect()
    return
  }

  const res = await Job.deleteMany(filter)
  console.log(`deleted  : ${res.deletedCount}`)
  console.log(`remaining: ${await Job.countDocuments({})}`)

  await mongoose.disconnect()
})()
