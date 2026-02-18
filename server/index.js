/**
 * AdLands - Multiplayer Server
 * Entry point: HTTP server + Socket.IO + game room management.
 *
 * Run with: node index.js
 * Or for development: npm run dev (auto-restarts on file changes)
 */

const express = require("express");
let compression;
try { compression = require("compression"); } catch (_) {}
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const GameRoom = require("./GameRoom");
const SponsorStore = require("./SponsorStore");
const { createSponsorRoutes, extractSponsorImages } = require("./sponsorRoutes");
const MoonSponsorStore = require("./MoonSponsorStore");
const { createMoonSponsorRoutes, extractMoonSponsorImages } = require("./moonSponsorRoutes");
const BillboardSponsorStore = require("./BillboardSponsorStore");
const { createBillboardSponsorRoutes, extractBillboardSponsorImages } = require("./billboardSponsorRoutes");
const { initFirebaseAdmin, verifyToken, getFirestore } = require("./firebaseAdmin");

// ========================
// CONFIG
// ========================

const PORT = process.env.PORT || 3000;

// ========================
// FIREBASE ADMIN
// ========================

initFirebaseAdmin();

// ========================
// SERVER SETUP
// ========================

const app = express();
if (compression) app.use(compression());
app.use(express.json({ limit: "50mb" }));
const server = http.createServer(app);

// ========================
// SPONSOR STORE + API
// ========================

const sponsorStore = new SponsorStore(path.join(__dirname, "..", "data", "sponsors.json"), { getFirestore });

// Extract base64 sponsor images to static PNG files (avoids sending MB of base64 over WebSocket)
const gameDir = path.join(__dirname, "..");

/**
 * Reconcile player territories from Firestore → SponsorStore on startup.
 * Ensures sponsors.json always has player territory entries, even if the file
 * was overwritten by Dropbox sync or entries were lost during a restart.
 */
async function reconcilePlayerTerritories() {
  try {
    const db = getFirestore();
    const snap = await db.collection("territories").where("active", "==", true).get();
    if (snap.empty) return;

    // Batch-lookup emails for all owner UIDs
    const ownerUids = [...new Set(snap.docs.map(d => d.data().ownerUid).filter(Boolean))];
    const emailMap = new Map();
    for (const uid of ownerUids) {
      try {
        const acc = await db.collection("accounts").doc(uid).get();
        if (acc.exists) emailMap.set(uid, acc.data().email || null);
      } catch (_) {}
    }

    let created = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      const existing = sponsorStore.getAll().find(s => s._territoryId === doc.id);
      const email = emailMap.get(data.ownerUid);
      const displayName = email || data.playerName || "Player";
      if (!existing) {
        const result = await sponsorStore.create({
          _territoryId: doc.id,
          name: displayName,
          cluster: { tileIndices: data.tileIndices || [] },
          patternImage: data.patternImage || null,
          pendingImage: data.pendingImage || null,
          patternAdjustment: data.patternAdjustment || {},
          ownerType: "player",
          tierName: data.tierName || "outpost",
          imageStatus: data.imageStatus || "placeholder",
          ownerUid: data.ownerUid,
          ownerEmail: email || null,
        });
        if (result.sponsor) created++;
        else if (result.errors) console.warn(`[Reconcile] Failed for ${doc.id}:`, result.errors);
      } else {
        // Only update name to email if we actually found one — never downgrade to profile name
        const updates = {};
        if (email && existing.name !== email) updates.name = email;
        if (email && existing.ownerEmail !== email) updates.ownerEmail = email;
        if (Object.keys(updates).length > 0) {
          await sponsorStore.update(existing.id, updates);
        }
      }
    }
    if (created > 0) {
      console.log(`[Startup] Reconciled ${created} player territories from Firestore → SponsorStore`);
    }
  } catch (err) {
    console.warn("[Startup] Territory reconciliation failed:", err.message);
  }
}

// Moon sponsor store
const moonSponsorStore = new MoonSponsorStore(path.join(__dirname, "..", "data", "moonSponsors.json"), { getFirestore });

// Billboard sponsor store
const billboardSponsorStore = new BillboardSponsorStore(path.join(__dirname, "..", "data", "billboardSponsors.json"), { getFirestore });

// Socket.IO with CORS for development (allows connecting from file:// or other origins)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  // Performance tuning
  transports: ["websocket"],       // Skip HTTP long-polling, go straight to WebSocket
  perMessageDeflate: false,        // Disable per-message compression (adds latency for small msgs)
  pingInterval: 10000,             // How often to check if client is alive
  pingTimeout: 5000,               // How long to wait for pong before disconnect
  maxHttpBufferSize: 50e6,         // 50MB — welcome payload includes base64 sponsor textures

});

// ========================
// SERVE THE GAME CLIENT
// ========================

// Serve the shared physics module so the client can use it too
app.use("/shared", express.static(path.join(__dirname, "shared"), { maxAge: "1d" }));

// Serve the main game directory (parent of server/)
app.use(express.static(gameDir, { maxAge: "1d" }));

// Fallback: serve index.html for root
app.get("/", (req, res) => {
  res.sendFile(path.join(gameDir, "index.html"));
});

// ========================
// GAME ROOM + ROUTES (async — image extraction must finish first)
// ========================

let mainRoom;

(async () => {
  // Load sponsor stores (reads JSON from disk, then merges Firestore data)
  await sponsorStore.load();
  await moonSponsorStore.load();
  await billboardSponsorStore.load();

  // Reconcile Firestore territories → SponsorStore (self-healing sync)
  await reconcilePlayerTerritories();

  // Await image extraction so URL maps are ready for routes and GameRoom
  const sponsorImageUrls = await extractSponsorImages(sponsorStore, gameDir);
  const moonSponsorImageUrls = await extractMoonSponsorImages(moonSponsorStore, gameDir);
  const billboardSponsorImageUrls = await extractBillboardSponsorImages(billboardSponsorStore, gameDir);

  // For now: one global room. Later you'd add matchmaking / multiple rooms.
  mainRoom = new GameRoom(io, "main", sponsorStore, sponsorImageUrls, moonSponsorStore, moonSponsorImageUrls, billboardSponsorStore, billboardSponsorImageUrls);
  mainRoom.start();

  // Mount sponsor API routes (after GameRoom so live reload can broadcast)
  app.use("/api/sponsors", createSponsorRoutes(sponsorStore, mainRoom, {
    imageUrls: sponsorImageUrls,
    gameDir,
  }));

  // Mount moon sponsor API routes
  app.use("/api/moon-sponsors", createMoonSponsorRoutes(moonSponsorStore, mainRoom, {
    imageUrls: moonSponsorImageUrls,
    gameDir,
  }));

  // Mount billboard sponsor API routes
  app.use("/api/billboard-sponsors", createBillboardSponsorRoutes(billboardSponsorStore, mainRoom, {
    imageUrls: billboardSponsorImageUrls,
    gameDir,
  }));

  console.log("[Server] Sponsor images extracted, routes mounted");

  // Start listening only after images are extracted and routes are ready
  server.listen(PORT, () => {
    console.log("");
    console.log("═══════════════════════════════════════════════");
    console.log("  AdLands - Multiplayer Server");
    console.log("  A Limited Liability Company");
    console.log("═══════════════════════════════════════════════");
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://<your-ip>:${PORT}`);
    console.log(`  Tick:    ${mainRoom.tickRate}/sec`);
    console.log("═══════════════════════════════════════════════");
    console.log("");
  });
})();

// ========================
// AUTH MIDDLEWARE
// ========================

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    // Guest/anonymous — no Firebase token provided
    socket.uid = null;
    socket.isGuest = true;
    socket.profileData = null;
    socket.profileIndex = 0;
    return next();
  }

  const decoded = await verifyToken(token);
  if (!decoded) {
    // Token invalid but don't block connection — treat as guest
    console.warn(`[Auth] Invalid token from ${socket.id}, allowing as guest`);
    socket.uid = null;
    socket.isGuest = true;
    socket.profileData = null;
    socket.profileIndex = 0;
    return next();
  }

  socket.uid = decoded.uid;
  socket.email = decoded.email || null;
  socket.isGuest = decoded.firebase?.sign_in_provider === "anonymous";

  // Load active profile from Firestore
  try {
    const db = getFirestore();
    const accountDoc = await db.collection("accounts").doc(decoded.uid).get();
    if (accountDoc.exists) {
      const account = accountDoc.data();
      const profileIndex = account.activeProfileIndex || 0;
      const profileDoc = await db
        .collection("accounts").doc(decoded.uid)
        .collection("profiles").doc(String(profileIndex))
        .get();
      socket.profileData = profileDoc.exists ? profileDoc.data() : null;
      socket.profileIndex = profileIndex;
    } else {
      socket.profileData = null;
      socket.profileIndex = 0;
    }
  } catch (err) {
    console.warn(`[Auth] Failed to load profile for ${decoded.uid}:`, err.message);
    socket.profileData = null;
    socket.profileIndex = 0;
  }

  next();
});

// ========================
// CONNECTION HANDLING
// ========================

io.on("connection", (socket) => {
  console.log(`[Server] New connection: ${socket.id}${socket.uid ? ` (uid: ${socket.uid})` : " (guest)"}`);

  // Attempt to restore an existing session for authenticated players
  let player = socket.uid ? mainRoom.reconnectPlayer(socket) : null;
  if (!player) {
    player = mainRoom.addPlayer(socket);
  }

  // ---- Input ----
  // Client sends input every frame (keys + turret angle + sequence number)
  socket.on("input", (data) => {
    mainRoom.handleInput(socket.id, data);
  });

  // ---- Fire ----
  socket.on("fire", (data) => {
    mainRoom.handleFire(socket.id, data?.power || 0, data?.turretAngle);
  });

  // ---- Profile (badges, crypto) ----
  socket.on("profile", (data) => {
    if (data && typeof data === "object") {
      mainRoom.handleProfile(socket.id, data);
    }
  });

  // ---- Enter Fast Travel (commander pressed E at portal) ----
  socket.on("enter-fast-travel", () => {
    mainRoom.handleEnterFastTravel(socket.id);
  });

  // ---- Portal Selection ----
  socket.on("choose-portal", (data) => {
    if (typeof data?.portalTileIndex !== "number") return;
    mainRoom.handleChoosePortal(socket.id, data.portalTileIndex);
  });

  // ---- Level Up Purchase ----
  socket.on("level-up", () => {
    mainRoom.handleLevelUp(socket.id);
  });

  // ---- Loadout Slot Unlock ----
  socket.on("unlock-slot", (data) => {
    if (data?.slotId) mainRoom.handleUnlockSlot(socket.id, data.slotId);
  });

  // ---- Self-Damage (debug K key) ----
  socket.on("self-damage", (data) => {
    if (typeof data?.amount !== "number") return;
    mainRoom.handleSelfDamage(socket.id, data.amount);
  });

  // ---- Player Identity (onboarding screen) ----
  socket.on("set-identity", (data) => {
    if (!data || typeof data.name !== "string") return;
    const validFactions = ["rust", "cobalt", "viridian"];
    if (!validFactions.includes(data.faction)) return;
    mainRoom.handleSetIdentity(socket.id, data.name, data.faction);
  });

  // ---- Faction Change ----
  socket.on("change-faction", (data) => {
    const validFactions = ["rust", "cobalt", "viridian"];
    if (!data || !validFactions.includes(data.faction)) return;
    mainRoom.handleFactionChange(socket.id, data.faction);
  });

  // ---- Commander Tip ----
  socket.on("tip", (data) => {
    if (data && typeof data.targetId === "string") {
      mainRoom.handleTip(socket.id, data);
    }
  });

  // ---- Commander Resign / Cancel ----
  socket.on("commander-resign", (data) => {
    if (typeof data?.duration === "number") {
      mainRoom.handleResign(socket.id, data.duration);
    }
  });
  socket.on("commander-cancel-resign", () => {
    mainRoom.handleCancelResign(socket.id);
  });
  socket.on("commander-override", () => {
    mainRoom.handleCommanderOverride(socket.id, socket);
  });

  // ---- Commander Ping (broadcast to faction) ----
  socket.on("commander-ping", (data) => {
    if (data && typeof data === "object") {
      mainRoom.handleCommanderPing(socket.id, data);
    }
  });

  // ---- Commander Drawing (broadcast to faction) ----
  socket.on("commander-drawing", (data) => {
    if (data && typeof data === "object") {
      mainRoom.handleCommanderDrawing(socket.id, data);
    }
  });

  // ---- Chat ----
  socket.on("chat", (msg) => {
    // Relay chat with player info
    if (typeof msg.text !== "string" || msg.text.length > 500) return;

    const validModes = ["faction", "lobby", "squad"];
    const mode = validModes.includes(msg.mode) ? msg.mode : "lobby";

    const chatData = {
      id: socket.id,
      name: player.name,
      faction: player.faction,
      text: msg.text.substring(0, 500),
      mode: mode,
    };

    if (mode === "faction") {
      // Faction chat: broadcast to all — client-side cipher scrambles for enemy factions
      io.to(mainRoom.roomId).emit("chat", chatData);
    } else if (mode === "squad") {
      // Squad chat: broadcast to all (squad tracking is client-side only)
      // Client-side filtering handles squad visibility
      io.to(mainRoom.roomId).emit("chat", chatData);
    } else {
      // Lobby: broadcast to all players
      io.to(mainRoom.roomId).emit("chat", chatData);
    }
  });

  // ---- Ping measurement (echo timestamp back) ----
  socket.on("ping-measure", (ts) => {
    socket.emit("pong-measure", ts);
  });

  // ---- Token Refresh (long sessions) ----
  socket.on("refresh-token", async (token) => {
    const decoded = await verifyToken(token);
    if (decoded) {
      socket.uid = decoded.uid;
    } else {
      console.warn(`[Auth] Token refresh failed for ${socket.id}`);
    }
  });

  // ---- Profile Switch ----
  socket.on("set-profile", async (data) => {
    if (!socket.uid) return;
    const { profileIndex, profileData } = data || {};
    if (![0, 1, 2].includes(profileIndex)) return;
    if (!profileData || typeof profileData !== "object") return;

    // Save current profile stats to Firestore
    await mainRoom.savePlayerProfile(socket.id);

    // Update socket references
    socket.profileData = profileData;
    socket.profileIndex = profileIndex;

    // Update active profile on account
    try {
      const db = getFirestore();
      await db.collection("accounts").doc(socket.uid).update({
        activeProfileIndex: profileIndex,
      });
    } catch (err) {
      console.warn(`[Auth] Failed to update activeProfileIndex:`, err.message);
    }

    // Reset player in GameRoom with new profile data
    mainRoom.handleProfileSwitch(socket.id, profileData);
  });

  // ---- Territory Claim (server-authoritative, persists to Firestore) ----
  socket.on("claim-territory", async (data) => {
    if (!socket.uid) return;
    const { territoryId, tileIndices, tierName, patternImage, patternAdjustment, playerName,
            title, tagline, websiteUrl, pendingImage } = data || {};
    if (!territoryId || !Array.isArray(tileIndices) || tileIndices.length === 0) return;

    // Sanitize text fields (stored as pending — active fields stay empty until admin approves)
    const safeTitle = typeof title === "string" ? title.slice(0, 40).trim() : "";
    const safeTagline = typeof tagline === "string" ? tagline.slice(0, 80).trim() : "";
    let safeUrl = typeof websiteUrl === "string" ? websiteUrl.slice(0, 200).trim() : "";
    if (safeUrl && !/^https?:\/\//i.test(safeUrl)) safeUrl = "https://" + safeUrl;

    try {
      const db = getFirestore();

      // Look up account email for admin display (token email as fallback)
      let ownerEmail = socket.email || null;
      try {
        const accountDoc = await db.collection("accounts").doc(socket.uid).get();
        if (accountDoc.exists) ownerEmail = accountDoc.data().email || ownerEmail;
      } catch (_) {}
      const displayName = ownerEmail || playerName || "Player";

      // All player-submitted info goes to pending fields awaiting admin approval
      const hasPendingContent = safeTitle || safeTagline || safeUrl || pendingImage;
      await db.collection("territories").doc(territoryId).set({
        ownerUid: socket.uid,
        ownerEmail,
        tileIndices,
        tierName: tierName || "outpost",
        // Active fields: placeholder until admin approves
        patternImage: patternImage || null,
        patternAdjustment: patternAdjustment || {},
        playerName: playerName || "Player",
        title: "",
        tagline: "",
        websiteUrl: "",
        // Pending fields: await admin review
        pendingTitle: safeTitle,
        pendingTagline: safeTagline,
        pendingWebsiteUrl: safeUrl,
        pendingImage: pendingImage || null,
        submissionStatus: hasPendingContent ? "pending" : "placeholder",
        purchasedAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
        active: true,
      });

      // Create SponsorStore entry so admin portal can see/manage this territory
      const createResult = await sponsorStore.create({
        _territoryId: territoryId,
        name: displayName,
        tagline: "",
        websiteUrl: "",
        cluster: { tileIndices },
        patternImage: patternImage || null,
        patternAdjustment: patternAdjustment || {},
        ownerType: "player",
        tierName: tierName || "outpost",
        submissionStatus: hasPendingContent ? "pending" : "placeholder",
        pendingTitle: safeTitle,
        pendingTagline: safeTagline,
        pendingWebsiteUrl: safeUrl,
        pendingImage: pendingImage || null,
        ownerUid: socket.uid,
        ownerEmail: ownerEmail || null,
      });
      if (createResult.errors) {
        console.warn(`[Territory] SponsorStore create failed for ${territoryId}:`, createResult.errors);
      } else {
        console.log(`[Territory] SponsorStore entry created: ${createResult.sponsor.id}`);
      }

      // Broadcast placeholder territory to all players (no player-submitted info yet)
      io.to(mainRoom.roomId).emit("player-territory-claimed", {
        id: territoryId,
        tileIndices,
        patternImage,
        patternAdjustment: patternAdjustment || {},
        playerName: playerName || "Player",
        title: "",
        tagline: "",
        websiteUrl: "",
      });

      // Elon Tusk commentary on territory rent
      mainRoom.tuskChat?.onTerritoryRent?.(playerName || "Someone", socket.id);

      console.log(`[Territory] Player ${socket.uid} claimed ${tierName}: ${tileIndices.length} hexes (submissionStatus: ${hasPendingContent ? "pending" : "placeholder"})`);
    } catch (err) {
      console.warn(`[Territory] Claim failed:`, err.message);
    }
  });

  // ---- Territory Image Submission (queued for admin review) ----
  socket.on("submit-territory-image", async (data) => {
    if (!socket.uid) {
      console.warn(`[Territory] Image submit rejected: no uid (guest user), socket=${socket.id}`);
      socket.emit("territory-image-submitted", { territoryId: data?.territoryId, status: "error", message: "Not authenticated" });
      return;
    }
    const { territoryId, pendingImage, patternAdjustment } = data || {};
    if (!territoryId || !pendingImage) {
      console.warn(`[Territory] Image submit rejected: missing data (territoryId=${!!territoryId}, pendingImage=${!!pendingImage})`);
      return;
    }

    try {
      const db = getFirestore();
      const doc = await db.collection("territories").doc(territoryId).get();
      if (!doc.exists) {
        console.warn(`[Territory] Image submit rejected: territory ${territoryId} not found in Firestore`);
        socket.emit("territory-image-submitted", { territoryId, status: "error", message: "Territory not found" });
        return;
      }
      if (doc.data().ownerUid !== socket.uid) {
        console.warn(`[Territory] Image submit rejected: ownership mismatch (doc.ownerUid=${doc.data().ownerUid}, socket.uid=${socket.uid})`);
        socket.emit("territory-image-submitted", { territoryId, status: "error", message: "Not the owner" });
        return;
      }

      // Save pending image to Firestore for review
      await db.collection("territories").doc(territoryId).update({
        pendingImage,
        pendingImageAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
        submissionStatus: "pending",
        patternAdjustment: patternAdjustment || doc.data().patternAdjustment || {},
      });

      // Update SponsorStorage so admin portal sees the pending image
      const allSponsors = sponsorStore.getAll();
      const match = allSponsors.find(s => s._territoryId === territoryId || s.id === territoryId);
      if (match) {
        // Preserve/restore ownerEmail if missing
        let matchEmail = match.ownerEmail || socket.email || null;
        if (!matchEmail) {
          try {
            const accDoc = await db.collection("accounts").doc(socket.uid).get();
            if (accDoc.exists) matchEmail = accDoc.data().email || null;
          } catch (_) {}
        }
        const updateResult = await sponsorStore.update(match.id, {
          pendingImage,
          pendingImageAt: new Date().toISOString(),
          submissionStatus: "pending",
          ownerUid: socket.uid,
          ownerEmail: matchEmail,
          patternAdjustment: patternAdjustment || match.patternAdjustment || {},
        });
        if (updateResult.errors) {
          console.warn(`[Territory] SponsorStore update failed for ${match.id}:`, updateResult.errors);
        }
      } else {
        // Territory not yet in SponsorStore — create it from Firestore data
        const firestoreData = doc.data();
        // Look up account email for admin display (token email as fallback)
        let ownerEmail = socket.email || null;
        try {
          const accDoc = await db.collection("accounts").doc(socket.uid).get();
          if (accDoc.exists) ownerEmail = accDoc.data().email || ownerEmail;
        } catch (_) {}
        const createResult = await sponsorStore.create({
          _territoryId: territoryId,
          name: ownerEmail || firestoreData.playerName || "Player",
          cluster: { tileIndices: firestoreData.tileIndices || [] },
          patternImage: firestoreData.patternImage || null,
          pendingImage,
          pendingImageAt: new Date().toISOString(),
          patternAdjustment: patternAdjustment || firestoreData.patternAdjustment || {},
          ownerType: "player",
          tierName: firestoreData.tierName || "outpost",
          submissionStatus: "pending",
          ownerUid: socket.uid,
          ownerEmail: ownerEmail || null,
          createdAt: firestoreData.purchasedAt?.toDate?.()?.toISOString() || new Date().toISOString(),
        });
        if (createResult.errors) {
          console.warn(`[Territory] SponsorStore create failed for ${territoryId}:`, createResult.errors);
        }
      }

      socket.emit("territory-image-submitted", { territoryId, status: "pending" });
      console.log(`[Territory] Player ${socket.uid} submitted image for review: ${territoryId}`);
    } catch (err) {
      console.warn(`[Territory] Image submission failed:`, err.message);
      socket.emit("territory-image-submitted", { territoryId, status: "error", message: err.message });
    }
  });

  // ---- Territory Info Update (title, tagline, URL) — stored as pending for admin review ----
  socket.on("update-territory-info", async (data) => {
    if (!socket.uid) return;
    const { territoryId, title, tagline, websiteUrl, pendingImage } = data || {};
    if (!territoryId) return;

    // Sanitize
    const safeTitle = typeof title === "string" ? title.slice(0, 40).trim() : "";
    const safeTagline = typeof tagline === "string" ? tagline.slice(0, 80).trim() : "";
    let safeUrl = typeof websiteUrl === "string" ? websiteUrl.slice(0, 200).trim() : "";
    if (safeUrl && !/^https?:\/\//i.test(safeUrl)) safeUrl = "https://" + safeUrl;

    try {
      const db = getFirestore();
      const doc = await db.collection("territories").doc(territoryId).get();
      if (!doc.exists || doc.data().ownerUid !== socket.uid) return;

      // Store as pending fields awaiting admin approval (active fields unchanged)
      const updateFields = {
        pendingTitle: safeTitle,
        pendingTagline: safeTagline,
        pendingWebsiteUrl: safeUrl,
        submissionStatus: "pending",
      };
      if (pendingImage) {
        updateFields.pendingImage = pendingImage;
      }
      await db.collection("territories").doc(territoryId).update(updateFields);

      // Update SponsorStore with pending fields
      const allSponsors = sponsorStore.getAll();
      const match = allSponsors.find(s => s._territoryId === territoryId || s.id === territoryId);
      if (match) {
        const storeUpdate = {
          pendingTitle: safeTitle,
          pendingTagline: safeTagline,
          pendingWebsiteUrl: safeUrl,
          submissionStatus: "pending",
        };
        if (pendingImage) {
          storeUpdate.pendingImage = pendingImage;
        }
        await sponsorStore.update(match.id, storeUpdate);
      }

      // Confirm to submitter (do NOT broadcast to other players — wait for admin approval)
      socket.emit("territory-info-submitted", { territoryId, status: "pending" });

      console.log(`[Territory] Player ${socket.uid} submitted info update for review: ${territoryId}`);
    } catch (err) {
      console.warn(`[Territory] Info update failed:`, err.message);
    }
  });

  // ---- Disconnect ----
  socket.on("disconnect", async (reason) => {
    // Save profile to Firestore before removing the player
    if (socket.uid) {
      try {
        await mainRoom.savePlayerProfile(socket.id);
      } catch (err) {
        console.warn(`[Server] Failed to save profile on disconnect for ${socket.id}:`, err.message);
      }
    }
    mainRoom.removePlayer(socket.id);
    console.log(`[Server] Disconnected: ${socket.id} (${reason})`);
  });
});

// ---- Graceful Shutdown ----
// Save all player profiles before the server exits (restart, Ctrl+C, deploy, etc.)
async function gracefulShutdown(signal) {
  console.log(`\n[Server] ${signal} received — saving all data before exit...`);
  try {
    await Promise.allSettled([
      mainRoom.saveAllPlayers(),
      mainRoom.saveCaptureState(),
    ]);
    console.log("[Server] All profiles and capture state saved. Shutting down.");
  } catch (err) {
    console.warn("[Server] Error during shutdown save:", err.message);
  }
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

