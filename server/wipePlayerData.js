#!/usr/bin/env node
/**
 * AdLands - Wipe All Player Data
 * Deletes all Firestore documents in: accounts (+ profiles subcollections), territories, leaderboards.
 * Also deletes Firebase Auth users.
 *
 * Usage: node server/wipePlayerData.js
 */

const { initFirebaseAdmin, getFirestore } = require("./firebaseAdmin");
const admin = require("firebase-admin");

const BATCH_SIZE = 100;

async function deleteCollection(db, collectionPath) {
  const collRef = db.collection(collectionPath);
  let deleted = 0;

  while (true) {
    const snapshot = await collRef.limit(BATCH_SIZE).get();
    if (snapshot.empty) break;

    const batch = db.batch();
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    deleted += snapshot.size;
  }

  return deleted;
}

async function deleteSubcollections(db, parentPath, subcollectionName) {
  const parentSnap = await db.collection(parentPath).get();
  let deleted = 0;

  for (const parentDoc of parentSnap.docs) {
    const subPath = `${parentPath}/${parentDoc.id}/${subcollectionName}`;
    deleted += await deleteCollection(db, subPath);
  }

  return deleted;
}

async function deleteAllAuthUsers() {
  let deleted = 0;
  let nextPageToken;

  do {
    const listResult = await admin.auth().listUsers(BATCH_SIZE, nextPageToken);
    const uids = listResult.users.map((u) => u.uid);

    if (uids.length > 0) {
      await admin.auth().deleteUsers(uids);
      deleted += uids.length;
    }

    nextPageToken = listResult.pageToken;
  } while (nextPageToken);

  return deleted;
}

async function main() {
  console.log("=== AdLands Player Data Wipe ===\n");

  initFirebaseAdmin();
  const db = getFirestore();

  // 1. Delete profile subcollections first (before parent accounts)
  console.log("[1/5] Deleting profiles subcollections...");
  const profilesDeleted = await deleteSubcollections(db, "accounts", "profiles");
  console.log(`  Deleted ${profilesDeleted} profile documents`);

  // 2. Delete account documents
  console.log("[2/5] Deleting account documents...");
  const accountsDeleted = await deleteCollection(db, "accounts");
  console.log(`  Deleted ${accountsDeleted} account documents`);

  // 3. Delete territories
  console.log("[3/5] Deleting territories...");
  const territoriesDeleted = await deleteCollection(db, "territories");
  console.log(`  Deleted ${territoriesDeleted} territory documents`);

  // 4. Delete leaderboards
  console.log("[4/5] Deleting leaderboards...");
  const leaderboardsDeleted = await deleteCollection(db, "leaderboards");
  console.log(`  Deleted ${leaderboardsDeleted} leaderboard documents`);

  // 5. Delete Firebase Auth users
  console.log("[5/5] Deleting Firebase Auth users...");
  const authDeleted = await deleteAllAuthUsers();
  console.log(`  Deleted ${authDeleted} auth users`);

  console.log("\n=== Wipe Complete ===");
  console.log(`  Accounts:     ${accountsDeleted}`);
  console.log(`  Profiles:     ${profilesDeleted}`);
  console.log(`  Territories:  ${territoriesDeleted}`);
  console.log(`  Leaderboards: ${leaderboardsDeleted}`);
  console.log(`  Auth Users:   ${authDeleted}`);
  console.log("\nRestart the game server to clear the in-memory ranking cache.");
}

main().catch((err) => {
  console.error("Wipe failed:", err);
  process.exit(1);
});
