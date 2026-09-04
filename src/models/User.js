const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    Email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80
    },

    dob: {
      type: Date,
      required: true
    },

    passwordHash: {
      type: String,
      required: true,
      select: false
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Users", userSchema);
