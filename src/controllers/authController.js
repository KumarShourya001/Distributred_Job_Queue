const User = require("../models/User");
const bcrypt = require("bcrypt");
const { z } = require("zod");
const {sign,cookieOptions,SESSION_COOKIE}=require('../session')
const email = z.string().trim().toLowerCase().email();

const MIN_AGE_MS = 13 * 365.25 * 86400000;

const registerSchema = z.object({
  email,
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(80),
  dob: z.coerce
    .date()
    .refine((d) => d < new Date())
    .refine((d) => d > new Date("1900-01-01"))
    .refine((d) => Date.now() - d.getTime() >= MIN_AGE_MS),
});

const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

async function hashPassword(pass) {
  const saltRounds = 10;
  const hashedPassword = await bcrypt.hash(pass, saltRounds);
  return hashedPassword;
}
async function createUser({ email, password, name, dob }) {
  const newUser = new User({
    Email: email,
    passwordHash: password,
    name,
    dob,
  });
  const savedUser = await newUser.save();
  return savedUser;
}
async function validatePassword(password, hashedPassword) {
  try {
    const isMatch = await bcrypt.compare(password, hashedPassword);
    return isMatch;
  } catch (error) {
    console.error("password validation error", error);
    throw error;
  }
}
const register = async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const { email, password, name, dob } = parsed.data;

    const hashedPassword = await hashPassword(password);

    try {
      await createUser({ email, password: hashedPassword, name, dob });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }

    res.status(201).json({ message: "account created if that email was available" });
  } catch (error) {
    res.status(500).json({ error: "Server error check failed" });
  }
};

const login = async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const { email, password } = parsed.data;

    const user = await User.findOne({ Email: email }).select(
      "+passwordHash",
    );
    if(!user){
        res.status(401).json({loggedIn:false,message:"invalid email or password"})
        return 
    }
    const isMatch = await validatePassword(password, user.passwordHash);
    if (isMatch) {
      res.cookie(SESSION_COOKIE,sign(user._id),cookieOptions)
      res.status(200).json({ loggedIn: true, message: "Login Successful" });
    } else {
      res.status(401).json({
        loggedIn:false,
        message:"invalid email or password"
      });
    }
  } catch (error) {
    res.status(500).json({ error: "Server error check failed" });
  }
};
const logout=async(req,res)=>{
  try{
    res.clearCookie(SESSION_COOKIE,cookieOptions)
    res.sendStatus(204)
    
  }catch{
    console.log("Unable to log out ")
  }

}
module.exports = { register, login,logout };
