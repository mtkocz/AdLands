/**
 * AdLands - Multiplayer Server
 * Entry point: HTTP server + Socket.IO + game room management.
 *
 * Run with: node index.js
 * Or for development: npm run dev (auto-restarts on file changes)
 */

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const GameRoom = require("./GameRoom");
const SponsorStore = require("./SponsorStore");
const { createSponsorRoutes, extractSponsorImages } = require("./sponsorRoutes");

// ========================
// CONFIG
// ========================

const PORT = process.env.PORT || 3000;

// ========================
// SERVER SETUP
// ========================

const app = express();
app.use(express.json({ limit: "50mb" }));
const server = http.createServer(app);

// ========================
// SPONSOR STORE + API
// ========================

const sponsorStore = new SponsorStore(path.join(__dirname, "..", "data", "sponsors.json"));
sponsorStore.load();

// Extract base64 sponsor images to static PNG files (avoids sending MB of base64 over WebSocket)
const gameDir = path.join(__dirname, "..");
const sponsorImageUrls = extractSponsorImages(sponsorStore, gameDir);

// Routes mounted after GameRoom creation (below) so live reload can reference mainRoom

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
app.use("/shared", express.static(path.join(__dirname, "shared")));

// Serve the main game directory (parent of server/)
app.use(express.static(gameDir));

// Fallback: serve index.html for root
app.get("/", (req, res) => {
  res.sendFile(path.join(gameDir, "index.html"));
});

// ========================
// GAME ROOM MANAGEMENT
// ========================

// For now: one global room. Later you'd add matchmaking / multiple rooms.
const mainRoom = new GameRoom(io, "main", sponsorStore, sponsorImageUrls);
mainRoom.start();

// Mount sponsor API routes (after GameRoom so live reload can broadcast)
app.use("/api/sponsors", createSponsorRoutes(sponsorStore, mainRoom));

// ========================
// CONNECTION HANDLING
// ========================

io.on("connection", (socket) => {
  console.log(`[Server] New connection: ${socket.id}`);

  // Add player to the main room
  const player = mainRoom.addPlayer(socket);

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

  // ---- Portal Selection ----
  socket.on("choose-portal", (data) => {
    if (typeof data?.portalTileIndex !== "number") return;
    mainRoom.handleChoosePortal(socket.id, data.portalTileIndex);
  });

  // ---- Self-Damage (debug K key) ----
  socket.on("self-damage", (data) => {
    if (typeof data?.amount !== "number") return;
    mainRoom.handleSelfDamage(socket.id, data.amount);
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

  // ---- Disconnect ----
  socket.on("disconnect", (reason) => {
    mainRoom.removePlayer(socket.id);
    console.log(`[Server] Disconnected: ${socket.id} (${reason})`);
  });
});

// ========================
// START
// ========================

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
