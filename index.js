require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const multer = require("multer");
const pdfParse = require("pdf-parse");

const admin = require("firebase-admin");





const app = express();
app.use(cors());
app.use(express.json());

// ------------------ Firebase ------------------




// Parse the JSON from your environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// Replace literal '\n' with actual newlines in the private key
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log("Firebase initialized successfully!");


const db = admin.firestore();




// ------------------ Multer ------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ------------------ Auth ------------------

async function verifyUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Unauthorized");
  }
  const token = authHeader.split("Bearer ")[1];
  return admin.auth().verifyIdToken(token);
}

// ------------------ Routes ------------------

app.get("/", (req, res) => {
  res.send("Backend running");
});

// ---- INTERNSHIPS ----
app.get("/internships", async (req, res) => {
  try {
    res.json(await getInternships());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- HACKATHONS ----
app.get("/hackathons", async (req, res) => {
  try {
    res.json(await getHackathons());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ALL ----
app.get("/all", async (req, res) => {
  try {
    res.json(await getAllOpportunities());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- MATCHING ----
app.get("/matching_internships", async (req, res) => {
  try {
    const { uid } = await verifyUser(req);
    res.json(await getRecommendations(uid, "internship"));
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get("/matching_hackathons", async (req, res) => {
  try {
    const { uid } = await verifyUser(req);
    res.json(await getRecommendations(uid, "hackathon"));
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// ---- UPLOAD RESUME ----
app.post("/upload-resume", upload.single("resume"), async (req, res) => {
  try {
    const { uid } = await verifyUser(req);
    const parsed = await pdfParse(req.file.buffer);

    const skills = extractSkills(parsed.text);

    await db.collection("users").doc(uid).set(
      {
        resumeText: parsed.text,
        resumeUpdatedAt: Date.now(),
        ...(skills.length && {
          skills: admin.firestore.FieldValue.arrayUnion(...skills),
        }),
      },
      { merge: true }
    );

    res.json({ success: true, extractedSkills: skills });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ANALYSIS ----
app.post("/analysis", async (req, res) => {
  try {
    const { uid } = await verifyUser(req);
    const { internshipId, hackathonId, type } = req.body;

    if (!type) return res.status(400).json({ error: "Missing type" });

    const itemId = internshipId || hackathonId;
    if (!itemId) {
      return res.status(400).json({ error: "Missing item id" });
    }

    const analysis = await getAnalysis({ userId: uid, itemId, type });
    res.json({ success: true, analysis });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// ------------------ Helpers ------------------

async function getInternships() {
  const snap = await db.collection("internships").get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getHackathons() {
  const snap = await db.collection("hackathons").get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getAllOpportunities() {
  const [h, i] = await Promise.all([
    getHackathons(),
    getInternships(),
  ]);
  return [...h, ...i];
}

// ---- RECOMMENDATIONS ----
function normalizeSkill(s) {
  return s.toLowerCase().replace(/[\s.-]/g, "");
}

async function getRecommendations(uid, type) {
  const user = await db.collection("users").doc(uid).get();
  if (!user.exists) return [];

  const userSkills = (user.data().skills || []).map(normalizeSkill);
  const col = type === "internship" ? "internships" : "hackathons";

  const snap = await db.collection(col).get();

  return snap.docs
    .map(doc => {
      const data = doc.data();
      const required = (data.skillsRequired || data.skills || []).map(normalizeSkill);
      const matched = required.filter(s => userSkills.includes(s));
      return {
        id: doc.id,
        title: data.title || data.name,
        matchPercent: required.length
          ? Math.round((matched.length / required.length) * 100)
          : 0,
      };
    })
    .sort((a, b) => b.matchPercent - a.matchPercent);
}

// ---- SKILL EXTRACTION ----
function extractSkills(text) {
  if (!text) return [];
  const keywords = [
    "JavaScript", "Python", "Java", "C++", "React", "Node.js",
    "Express", "MongoDB", "SQL", "Docker", "AWS", "Git",
  ];
  const lower = text.toLowerCase();
  return keywords.filter(k => lower.includes(k.toLowerCase()));
}

// ------------------ Start ------------------

module.exports = app;