#!/usr/bin/env node
/**
 * AdLands - Cleanup Stale Territories
 * Deactivates Firestore territory docs that have no matching SponsorStore entry.
 * These are leftovers from deletions where the Firestore cleanup failed.
 *
 * Usage: node server/cleanupTerritories.js
 *        node server/cleanupTerritories.js --dry-run   (preview only)
 */

const path = require("path");
const { initFirebaseAdmin, getFirestore } = require("./firebaseAdmin");
const SponsorStore = require("./SponsorStore");

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log("=== AdLands Territory Cleanup ===");
  if (DRY_RUN) console.log("(dry run — no changes will be made)\n");
  else console.log();

  initFirebaseAdmin();
  const db = getFirestore();

  // Load SponsorStore to know which territories are still valid
  const sponsorStore = new SponsorStore(
    path.join(__dirname, "..", "data", "sponsors.json"),
    { getFirestore }
  );
  await sponsorStore.load();
  const sponsors = sponsorStore.getAll();
  const validTerritoryIds = new Set(
    sponsors.filter(s => s._territoryId).map(s => s._territoryId)
  );

  console.log(`SponsorStore has ${validTerritoryIds.size} active player territories`);

  // Query all active territory docs from Firestore
  const snap = await db.collection("territories").where("active", "==", true).get();
  console.log(`Firestore has ${snap.size} active territory docs\n`);

  let deactivated = 0;
  let deleted = 0;

  for (const doc of snap.docs) {
    if (validTerritoryIds.has(doc.id)) continue;

    const data = doc.data();
    console.log(`  Stale: ${doc.id} (owner: ${data.ownerEmail || data.ownerUid || "unknown"})`);

    if (!DRY_RUN) {
      await db.collection("territories").doc(doc.id).update({ active: false });
      deactivated++;
      await db.collection("territories").doc(doc.id).delete();
      deleted++;
    }
  }

  if (DRY_RUN) {
    const staleCount = snap.size - [...snap.docs].filter(d => validTerritoryIds.has(d.id)).length;
    console.log(`\nFound ${staleCount} stale territories. Run without --dry-run to clean up.`);
  } else {
    console.log(`\n=== Cleanup Complete ===`);
    console.log(`  Deactivated: ${deactivated}`);
    console.log(`  Deleted:     ${deleted}`);
    if (deactivated > 0) {
      console.log("\nRestart the server to clear any in-memory remnants.");
    }
  }
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
