/**
 * AdLands - Firebase Configuration
 * Initializes Firebase app with project credentials.
 *
 * TODO: Replace the placeholder values below with your Firebase project config.
 * Find these at: Firebase Console → Project Settings → General → Your apps → Web app
 */

const firebaseConfig = {
  apiKey: "AIzaSyBrO3VZ9jn7I5KC_lbwcTe5srY2d4aNuuM",
  authDomain: "adlands.firebaseapp.com",
  projectId: "adlands",
  storageBucket: "adlands.firebasestorage.app",
  messagingSenderId: "602256160625",
  appId: "1:602256160625:web:944042f05be627a90e68d0",
};

// Initialize Firebase (uses compat SDK loaded via CDN in index.html)
firebase.initializeApp(firebaseConfig);

// Expose Firestore and Auth instances globally
const firebaseAuth = firebase.auth();
const firebaseDb = firebase.firestore();

// Enable Firestore offline persistence for better UX on flaky connections
firebaseDb.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  if (err.code === "failed-precondition") {
    console.warn("[Firebase] Persistence failed: multiple tabs open");
  } else if (err.code === "unimplemented") {
    console.warn("[Firebase] Persistence not available in this browser");
  }
});
