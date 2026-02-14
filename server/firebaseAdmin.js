/**
 * AdLands - Firebase Admin SDK
 * Server-side initialization + token verification helper.
 *
 * Setup:
 * 1. Go to Firebase Console → Project Settings → Service Accounts
 * 2. Click "Generate New Private Key" to download your service account JSON
 * 3. Set the GOOGLE_APPLICATION_CREDENTIALS env variable to the path of that file,
 *    OR place the file as server/serviceAccountKey.json
 */

const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

let initialized = false;

function initFirebaseAdmin() {
  if (initialized) return;

  // Try multiple credential sources in order of preference
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Option 1: Environment variable pointing to service account JSON
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  } else {
    // Option 2: Local service account key file
    const keyPath = path.join(__dirname, "serviceAccountKey.json");
    if (fs.existsSync(keyPath)) {
      const serviceAccount = require(keyPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } else {
      // Option 3: No credentials — Firebase Admin will fail on auth operations
      // but the server can still run for development without auth
      console.warn(
        "[Firebase Admin] No credentials found. Auth verification disabled.",
      );
      console.warn(
        "  Set GOOGLE_APPLICATION_CREDENTIALS env var or place serviceAccountKey.json in server/",
      );
      admin.initializeApp();
    }
  }

  initialized = true;
  console.log("[Firebase Admin] Initialized");
}

/**
 * Verify a Firebase ID token and return the decoded claims.
 * @param {string} token - Firebase ID token from client
 * @returns {Promise<object|null>} Decoded token or null if invalid
 */
async function verifyToken(token) {
  if (!token) return null;
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (err) {
    console.warn("[Firebase Admin] Token verification failed:", err.message);
    return null;
  }
}

/**
 * Get a Firestore reference (server-side).
 * @returns {admin.firestore.Firestore}
 */
function getFirestore() {
  return admin.firestore();
}

module.exports = { initFirebaseAdmin, verifyToken, getFirestore };
