/**
 * AdLands - Sponsor REST API Routes
 * Express router for /api/sponsors CRUD operations.
 * Mutations trigger live reload to broadcast changes to connected clients.
 */

const { Router } = require("express");
const zlib = require("zlib");

function createSponsorRoutes(sponsorStore, gameRoom) {
  const router = Router();

  function reloadIfLive() {
    if (gameRoom && typeof gameRoom.reloadSponsors === "function") {
      gameRoom.reloadSponsors();
    }
  }

  // GET /api/sponsors — list all sponsors
  router.get("/", (req, res) => {
    const data = {
      version: 1,
      sponsors: sponsorStore.getAll(),
      lastModified: sponsorStore._cache?.lastModified || "",
    };
    res.json(data);
  });

  // GET /api/sponsors/images — sponsor images only, gzip compressed
  router.get("/images", (req, res) => {
    const images = {};
    for (const s of sponsorStore.getAll()) {
      if (s.patternImage || s.logoImage) {
        images[s.id] = { patternImage: s.patternImage, logoImage: s.logoImage };
      }
    }
    const json = JSON.stringify(images);
    if (req.headers["accept-encoding"]?.includes("gzip")) {
      zlib.gzip(Buffer.from(json), (err, compressed) => {
        if (err) return res.status(500).end();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Encoding", "gzip");
        res.end(compressed);
      });
    } else {
      res.json(images);
    }
  });

  // GET /api/sponsors/export — download as JSON file
  router.get("/export", (req, res) => {
    const json = sponsorStore.exportJSON();
    const date = new Date().toISOString().split("T")[0];
    res.setHeader("Content-Disposition", `attachment; filename="adlands_sponsors_${date}.json"`);
    res.setHeader("Content-Type", "application/json");
    res.send(json);
  });

  // GET /api/sponsors/:id — get one sponsor
  router.get("/:id", (req, res) => {
    const sponsor = sponsorStore.getById(req.params.id);
    if (!sponsor) return res.status(404).json({ errors: ["Sponsor not found"] });
    res.json(sponsor);
  });

  // POST /api/sponsors — create new sponsor
  router.post("/", (req, res) => {
    const result = sponsorStore.create(req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    reloadIfLive();
    res.status(201).json(result.sponsor);
  });

  // POST /api/sponsors/import — bulk import
  router.post("/import", (req, res) => {
    const merge = req.body.merge !== false; // default true
    const result = sponsorStore.importJSON(req.body, merge);
    reloadIfLive();
    res.json(result);
  });

  // PUT /api/sponsors/:id — update existing sponsor
  router.put("/:id", (req, res) => {
    const result = sponsorStore.update(req.params.id, req.body);
    if (result.errors) {
      const status = result.errors.includes("Sponsor not found") ? 404 : 400;
      return res.status(status).json({ errors: result.errors });
    }
    reloadIfLive();
    res.json(result.sponsor);
  });

  // DELETE /api/sponsors/:id — delete sponsor
  router.delete("/:id", (req, res) => {
    const deleted = sponsorStore.delete(req.params.id);
    if (!deleted) return res.status(404).json({ errors: ["Sponsor not found"] });
    reloadIfLive();
    res.json({ success: true });
  });

  return router;
}

module.exports = createSponsorRoutes;
