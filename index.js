require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const admin = require("firebase-admin");

console.log("Backend starting...");

const app = express();

/* ------------------ CORS ------------------ */
const corsOptions = {
  origin: "https://skill-opportunity-translator.web.app",
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

/* ------------------ Firebase ------------------ */
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  db = admin.firestore();
  console.log("Firebase initialized successfully!");
} catch (err) {
  console.error("Firebase initialization failed:", err);
}

/* ------------------ Multer ------------------ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* ------------------ Auth ------------------ */
async function verifyUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Unauthorized");
  }
  const token = authHeader.split("Bearer ")[1];
  return admin.auth().verifyIdToken(token);
}

/* ------------------ Routes ------------------ */
app.get("/", (req, res) => {
  res.send("Backend running");
});

app.get("/internships", async (req, res) => {
  try {
    const snap = await db.collection("internships").get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/hackathons", async (req, res) => {
  try {
    const snap = await db.collection("hackathons").get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/analysis", async (req, res) => {
  try {
    const { uid } = await verifyUser(req);
    const { internshipId, hackathonId, type } = req.body;

    if (!type) return res.status(400).json({ error: "Missing type" });

    const itemId = internshipId || hackathonId;
    if (!itemId) return res.status(400).json({ error: "Missing item id" });

    const analysis = await getAnalysis({ userId: uid, itemId, type });
    res.json({ success: true, analysis });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

/* ------------------ Export ------------------ */
module.exports = app;
