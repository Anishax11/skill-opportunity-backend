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
app.post("/upload-resume", verifyUser, upload.single("resume"), async (req, res) => {
  try {
    console.log("1️⃣ Upload route hit");

    const uid = req.user.uid; // set by verifyUser middleware
    console.log("2️⃣ User verified:", uid);

    if (!req.file) {
      return res.status(400).json({ error: "No resume file uploaded" });
    }

    const pdfBuffer = req.file.buffer;
    console.log("6️⃣ Buffer length:", pdfBuffer.length);

    // Parse PDF
    const parsed = await pdfParse(pdfBuffer);
    console.log("7️⃣ PDF parsed, text length:", parsed.text.length);

    // Extract skills
    const extractedSkills = extractSkills(parsed.text);
    console.log("✅ Extracted Skills:", extractedSkills);

    // Prepare Firestore update
    const updateData = {
      resumeText: parsed.text,
      resumeUpdatedAt: Date.now(),
    };

    if (extractedSkills.length > 0) {
      updateData.skills = admin.firestore.FieldValue.arrayUnion(
        ...extractedSkills
      );
    }

    await db.collection("users").doc(uid).set(updateData, { merge: true });

    res.status(200).json({
      success: true,
      extractedSkills,
    });

  } catch (err) {
    console.error("❌ Upload resume error:", err);
    res.status(500).json({ error: err.message });
  }
});

exports.uploadResume = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const decoded = await verifyUser(req);
      const uid = decoded.uid;
      console.log("User verified:", uid);

      upload.single("resume")(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });

        try {
          const pdfBuffer = req.file.buffer;
          console.log("Resume buffer length:", pdfBuffer.length);

          const parsed = await pdfParse(pdfBuffer);
          console.log("PDF parsed, text length:", parsed.text.length);

          const extractedSkills = extractSkills(parsed.text);
          console.log("Extracted Skills:", extractedSkills);

          const updateData = {
            resumeText: parsed.text,
            resumeUpdatedAt: Date.now(),
          };

          if (extractedSkills.length > 0) {
            updateData.skills = admin.firestore.FieldValue.arrayUnion(...extractedSkills);
          }

          await db.collection("users").doc(uid).set(updateData, { merge: true });

          res.status(200).json({ success: true, extractedSkills });
        } catch (e) {
          console.error("PDF parse / Firestore error:", e);
          res.status(500).json({ error: e.message });
        }
      });
    } catch (err) {
      console.error("Authentication error:", err);
      res.status(401).json({ error: err.message });
    }
  });
});
async function getAnalysis({ userId, itemId, type }) {
  try {
    console.log("Getting analysis for:", type, itemId);

    const fetch = (...args) =>
      import("node-fetch").then(({ default: fetch }) => fetch(...args));

    // 1️⃣ Get user data
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return "User resume not found";

    const userData = userDoc.data();
    const resumeText = userData.resumeText || "No resume text provided";
    const userSkills = userData.skills || [];

    // 2️⃣ Determine collection
    let collectionName;
    let promptContext;

    if (type === "internship") {
      collectionName = "internships";
      promptContext = "Internship details";
    } else if (type === "hackathon") {
      collectionName = "hackathons";
      promptContext = "Hackathon details";
    } else {
      return "Invalid analysis type";
    }

    // 3️⃣ Get item data
    const itemDoc = await db.collection(collectionName).doc(itemId).get();
    if (!itemDoc.exists) return `${type} not found`;

    const itemData = itemDoc.data();

    const description =
      itemData.description ||
      itemData.Description ||
      "No description provided";

    const skillsRequired =
      itemData.skillsRequired ||
      itemData.skills ||
      itemData.themes ||
      itemData.domains ||
      [];

    // 4️⃣ Gemini request
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `
Opportunity type: ${type}
Description:
${description}

Required skills:
${Array.isArray(skillsRequired) ? skillsRequired.join(", ") : skillsRequired}

User summary:
${resumeText.slice(0, 4000)}

User skills:
${Array.isArray(userSkills) ? userSkills.join(", ") : userSkills}


You are an expert technical recruiter and career advisor.

Required skills:
${Array.isArray(skillsRequired) ? skillsRequired.join(", ") : skillsRequired}


User profile:
Resume:
${resumeText}

User skills:
${Array.isArray(userSkills) ? userSkills.join(", ") : userSkills}

Task:
Analyze how suitable this opportunity is for the user.

Skill interpretation rules:
- Treat skill names semantically, not literally.
- Consider common variants equivalent (e.g., Node.js, NodeJS, node js).
- If a skill appears in the user's skill list, assume the user has it.
- Do NOT mark a skill as missing if it is a semantic match.
- Use reasonable inference from resume content (projects, coursework, experience).
- Do NOT invent skills or projects that are not mentioned.

Response format rules:
- Respond in plain text only.
- Use clear section headings in **bold**.
- Use ✓ for matched qualifications.
- Use ? for missing or unclear qualifications.
- Use • for bullet points.
- Keep the tone realistic, professional, and encouraging (similar to LinkedIn job insights).
- Do NOT use emojis.

Output structure (follow exactly):

--------------------------------------------------

Overall Match: XX% 

(Brief 1–2 line summary explaining the match percentage.)

Application Verdict
Choose ONE and state it clearly:
- "Strongly recommended to apply"
- "Recommended to apply with preparation"
- "Apply only if willing to upskill"
- "Not recommended at this stage"

Then add a very short and to rhe point justification paragraph, written like a recruiter review.

---

Required Qualifications Match
Matches X of Y required qualifications:

✓ Skill name — short explanation of how the user demonstrates this  
? Skill name — clear reason why it is missing or unclear (e.g., “No mention of Unreal Engine”)

---

Missing Skills & How to Learn Them
For each missing or unclear skill:

Skill Name
• Why it matters for this role  
• Suggested learning roadmap (beginner → intermediate → applied)  
• Estimated time to reach basic competence  

Recommended Resources
• Official docs / trusted platforms (e.g., Unreal Engine Docs, Coursera, Udemy, freeCodeCamp, YouTube channels, GitHub repos)
• Avoid obscure or unreliable sources

---

These skills may be assessed during interviews or assignments:
• Soft skills
• Domain interest
• Problem-solving ability
• Communication / collaboration
• Portfolio or project discussion

---

Final Advice
End with a concise, actionable paragraph answering:
“What should the user do next if they want to pursue this opportunity?”

--------------------------------------------------`

                }
              ]
            }
          ]
        })
      }
    );

    const data = await res.json();
    console.log("Gemini API Response:", JSON.stringify(data, null, 2));

    const aiText =
      data?.candidates?.[0]?.content?.parts
        ?.map(p => p.text)
        .join("\n") || "No analysis returned";

    // console.log("Analysis result:", aiText);
    return aiText;

  } catch (err) {
    console.error("Gemini fetch failed:", err);
    return "Analysis failed. Please try again later.";
  }
}


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
