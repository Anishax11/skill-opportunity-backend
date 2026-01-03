require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const admin = require("firebase-admin");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

console.log("🚀 Backend starting...");

const app = express();

/* ================== CORS ================== */
app.use(
  cors({
    origin: [
      "https://skill-opportunity-translator.web.app",
      "http://localhost:5173",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.options("*", cors());
app.use(express.json());

/* ================== FIREBASE ================== */
let db;

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  db = admin.firestore();
  console.log("✅ Firebase initialized");
} catch (err) {
  console.error("❌ Firebase init failed:", err);
}

/* ================== MULTER ================== */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* ================== AUTH MIDDLEWARE ================== */
async function verifyUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(token);

    req.user = decoded;
    next();
  } catch (err) {
    console.error("❌ Auth error:", err);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

/* ================== UTILS ================== */
function extractSkills(text) {
  if (!text) return [];

  const SKILLS = [
    "Java",
    "Python",
    "C++",
    "JavaScript",
    "React",
    "Node.js",
    "Firebase",
    "SQL",
    "MongoDB",
    "Machine Learning",
    "Data Structures",
    "Algorithms",
    "Git",
    "HTML",
    "CSS",
  ];

  const lower = text.toLowerCase();
  return SKILLS.filter(skill =>
    lower.includes(skill.toLowerCase())
  );
}

/* ================== ROUTES ================== */

app.get("/", (req, res) => {
  res.send("✅ Backend running");
});

/* ---------- INTERNSHIPS ---------- */
app.get("/internships", async (req, res) => {
  try {
    const snap = await db.collection("internships").get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- HACKATHONS ---------- */
app.get("/hackathons", async (req, res) => {
  try {
    const snap = await db.collection("hackathons").get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- UPLOAD RESUME ---------- */
app.post(
  "/upload-resume",
  verifyUser,
  upload.single("resume"),
  async (req, res) => {
    try {
      const uid = req.user.uid;

      if (!req.file) {
        return res.status(400).json({ error: "No resume uploaded" });
      }

      const parsed = await pdfParse(req.file.buffer);
      const extractedSkills = extractSkills(parsed.text);

      const updateData = {
        resumeText: parsed.text,
        resumeUpdatedAt: Date.now(),
      };

      if (extractedSkills.length) {
        updateData.skills =
          admin.firestore.FieldValue.arrayUnion(...extractedSkills);
      }

      await db.collection("users").doc(uid).set(updateData, { merge: true });

      res.json({ success: true, extractedSkills });
    } catch (e) {
      console.error("❌ Resume upload error:", e);
      res.status(500).json({ error: e.message });
    }
  }
);

/* ================== ANALYSIS ================== */
async function getAnalysis({ userId, itemId, type }) {
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return "User resume not found";

    const userData = userDoc.data();
    const resumeText = userData.resumeText || "";
    const userSkills = userData.skills || [];

    const collection =
      type === "internship" ? "internships" : "hackathons";

    const itemDoc = await db.collection(collection).doc(itemId).get();
    if (!itemDoc.exists) return "Opportunity not found";

    const item = itemDoc.data();

    const description =
      item.description || item.Description || "No description provided";

    const skillsRequired =
      item.skillsRequired ||
      item.skills ||
      item.domains ||
      item.themes ||
      [];

    const geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `
Opportunity: ${type}
Description:
${description}

Required skills:
${skillsRequired}

User resume:
${resumeText.slice(0, 4000)}

User skills:
${userSkills.join(", ")}

Analyze suitability and give recruiter-style feedback.
`,
                },
              ],
            },
          ],
        }),
      }
    );

    const data = await geminiRes.json();

    return (
      data?.candidates?.[0]?.content?.parts
        ?.map(p => p.text)
        .join("\n") || "No analysis returned"
    );
  } catch (err) {
    console.error("❌ Analysis error:", err);
    return "Analysis failed";
  }
}

/* ---------- ANALYSIS ROUTE ---------- */
app.post("/analysis", verifyUser, async (req, res) => {
  try {
    const { internshipId, hackathonId, type } = req.body;

    if (!type) return res.status(400).json({ error: "Missing type" });

    const itemId = internshipId || hackathonId;
    if (!itemId) return res.status(400).json({ error: "Missing item id" });

    const analysis = await getAnalysis({
      userId: req.user.uid,
      itemId,
      type,
    });

    res.json({ success: true, analysis });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================== EXPORT ================== */
module.exports = app;
