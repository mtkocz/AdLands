/**
 * AdLands - Main Game Module
 * Core game initialization, systems coordination, and game loop
 */

(function () {
  "use strict";

  // ========================
  // CONFIGURATION
  // ========================

  const CONFIG = {
    sphereRadius: 480,
    dayNightCycleMinutes: 30,
    bloom: {
      strength: 3,
      radius: 1.2,
      threshold: 0.8, // Higher threshold - only bright HDR objects bloom
    },
  };

  // Bot name pool for variety
  const BOT_NAME_POOL = [
    // Classic gamer tags
    "xXSlayerXx",
    "N00bKiller",
    "TankMaster",
    "DeathWish",
    "ShadowFury",
    "IronClad",
    "VoidWalker",
    "CyberPunk",
    "NightHawk",
    "StormBringer",
    "PhantomX",
    "BlazeFire",
    "FrostBite",
    "ThunderBolt",
    "VenomStrike",
    "RageBeast",
    "SilentDeath",
    "ChaosMaker",
    "DoomBringer",
    "HexMaster",
    "PixelPro",
    "ByteMe",
    "LazerEyes",
    "CritHit",
    "HeadShot",
    "Pwn3d",
    "L33tHax",
    "RektU",
    "GG_EZ",
    "NoScope360",
    // Female-inspired names
    "NightQueen",
    "VixenStrike",
    "LunaWolf",
    "ScarletRage",
    "IvyBlade",
    "AthenaX",
    "ValkyrieFury",
    "NovaFlare",
    "ZeldaMain",
    "SamusRun",
    "LadyHavoc",
    "QueenBee",
    "Artemis99",
    "MissChief",
    "SheWolf",
    "PixieKill",
    "RavenClaw",
    "SirenSong",
    "FemFatale",
    "DarkAngelX",
    "CrimsonWitch",
    "MysticRose",
    "VelvetStorm",
    "DivaDestroy",
    "EmpressX",
  ];

  // Accomplishment labels for display
  const ACCOMPLISHMENT_LABELS = {
    capture: "Capture Territory",
    hold_1m: "Hold 1 Minute",
    hold_5m: "Hold 5 Minutes",
    hold_10m: "Hold 10 Minutes",
    hold_1h: "Hold 1 Hour",
    hold_6h: "Hold 6 Hours",
    hold_12h: "Hold 12 Hours",
    hold_24h: "Hold 24 Hours",
  };

  // ========================
  // SPONSOR MANAGEMENT
  // ========================

  // Tracks whether sponsor textures have been preloaded (gates loading screen).
  // In multiplayer mode, start as false — the welcome payload delivers sponsors.
  let sponsorTexturesReady = typeof io === "undefined";

  // Granular sponsor loading progress (0-1) for the loading bar.
  // In multiplayer, starts at 0 (waiting for server). In singleplayer/offline, starts at 1 (no sponsors to wait for).
  let sponsorLoadProgress = typeof io === "undefined" ? 1 : 0;
  let sponsorLoadActive = false;

  async function loadAndApplySponsors(planet) {
    // In multiplayer mode, sponsors come from the server welcome payload.
    // MultiplayerClient.js handles applying them via planet.applySponsorVisuals().
    if (typeof io !== "undefined") {
      return;
    }

    try {
      await SponsorStorage.init();
      const activeSponsors = SponsorStorage.getAll().filter(
        (s) => s.active !== false,
      );

      if (activeSponsors.length === 0) {
        planet.mergeClusterTiles();
        return;
      }

      // Preload all sponsor pattern textures during loading screen
      sponsorTexturesReady = false;
      sponsorLoadActive = true;
      sponsorLoadProgress = 0;
      await planet.preloadSponsorTextures(activeSponsors, (p) => { sponsorLoadProgress = p; });
      sponsorLoadProgress = 1;
      sponsorTexturesReady = true;

      for (const sponsor of activeSponsors) {
        if (
          sponsor.cluster &&
          sponsor.cluster.tileIndices &&
          sponsor.cluster.tileIndices.length > 0
        ) {
          planet.applySponsorCluster(sponsor);
        }
      }

      // Remove terrain elevation from sponsor hexes (keep them flat)
      planet.deElevateSponsorTiles();

      // Merge cluster tiles for draw call reduction
      planet.mergeClusterTiles();
    } catch (e) {
      console.error("Error loading sponsors:", e);
      sponsorTexturesReady = true; // Don't block loading screen on failure
      planet.mergeClusterTiles(); // Still merge for draw call reduction
    }
  }

  // ========================
  // THREE.JS SETUP
  // ========================

  const scene = new THREE.Scene();

  // Skybox sphere — layer 0 only so the bloom camera (layer 1) never sees it.
  // MeshBasicMaterial: unlit, no emissive, normal (non-additive) blending.
  const skyboxGeo = new THREE.SphereGeometry(48000, 32, 16);
  const skyboxMat = new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  const skybox = new THREE.Mesh(skyboxGeo, skyboxMat);
  skybox.renderOrder = -9999;
  skybox.layers.set(0);
  scene.add(skybox);

  new THREE.TextureLoader().load('assets/sprites/hdri.png', (tex) => {
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    skyboxMat.map = tex;
    skyboxMat.needsUpdate = true;
  });

  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    9.6,
    96000,
  );
  // Configure camera to see both default layer (0) and bloom layer (1)
  camera.layers.enable(0); // Default layer
  camera.layers.enable(1); // Bloom layer
  camera.layers.enable(2); // Inner crust layer

  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: "high-performance",
  });

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // Selective bloom: layer-based system for precise control over what blooms
  // Bloom camera ONLY sees Layer 1 (bloom objects) for maximum performance
  const BLOOM_LAYER = 1;
  const bloomCamera = camera.clone();
  bloomCamera.layers.set(BLOOM_LAYER); // Only see bloom layer - renders minimal geometry!
  bloomCamera.layers.enable(3); // Also see bloom-source-only objects (e.g. core glow)

  // Black material for occluding sun in bloom pass (depth testing only)
  const bloomOcclusionMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    colorWrite: false, // Don't write color, only depth
    depthWrite: true, // Explicitly write to depth buffer
    depthTest: true, // Test against depth buffer
    side: THREE.DoubleSide, // Block bloom from both sides (billboard planes)
  });

  // Bloom composer (renders only bloom objects using bloomCamera)
  const bloomWidth = Math.floor(window.innerWidth / 2);
  const bloomHeight = Math.floor(window.innerHeight / 2);

  const bloomComposer = new THREE.EffectComposer(renderer);
  bloomComposer.setSize(bloomWidth, bloomHeight);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(new THREE.RenderPass(scene, bloomCamera));
  const bloomPass = new THREE.UnrealBloomPass(
    new THREE.Vector2(bloomWidth, bloomHeight),
    CONFIG.bloom.strength,
    CONFIG.bloom.radius,
    CONFIG.bloom.threshold,
  );
  bloomComposer.addPass(bloomPass);

  // Final composer (renders full scene and blends bloom on top)
  const bloomBlendShader = {
    uniforms: {
      baseTexture: { value: null },
      bloomTexture: { value: bloomComposer.renderTarget2.texture },
    },
    vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
    fragmentShader: `
            uniform sampler2D baseTexture;
            uniform sampler2D bloomTexture;
            varying vec2 vUv;
            void main() {
                vec4 base = texture2D(baseTexture, vUv);
                vec4 bloom = texture2D(bloomTexture, vUv);
                gl_FragColor = base + bloom;
            }
        `,
  };

  const finalComposer = new THREE.EffectComposer(renderer);
  const finalRenderPass = new THREE.RenderPass(scene, camera);
  finalComposer.addPass(finalRenderPass);
  const bloomBlendPass = new THREE.ShaderPass(bloomBlendShader, "baseTexture");
  bloomBlendPass.uniforms.bloomTexture.value =
    bloomComposer.renderTarget2.texture;
  bloomBlendPass.needsSwap = true;

  finalComposer.addPass(bloomBlendPass);

  // ========================
  // TERRITORY RING OVERLAY (rendered into post-processing chain)
  // ========================

  // Use the territory ring 2D canvas as a Three.js texture so post-processing
  // effects (vignette, chromatic aberration, damage effects, etc.) apply to it.
  const territoryRingOverlayTexture = new THREE.CanvasTexture(
    document.getElementById("territory-ring"),
  );
  territoryRingOverlayTexture.minFilter = THREE.NearestFilter;
  territoryRingOverlayTexture.magFilter = THREE.NearestFilter;
  territoryRingOverlayTexture.generateMipmaps = false;

  const territoryRingOverlayShader = {
    uniforms: {
      tDiffuse: { value: null },
      overlayTexture: { value: territoryRingOverlayTexture },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D overlayTexture;
      varying vec2 vUv;
      void main() {
        vec4 base = texture2D(tDiffuse, vUv);
        vec4 overlay = texture2D(overlayTexture, vUv);
        // Normal (straight) alpha blend
        gl_FragColor = vec4(mix(base.rgb, overlay.rgb, overlay.a), 1.0);
      }
    `,
  };

  const territoryRingPass = new THREE.ShaderPass(territoryRingOverlayShader);
  territoryRingPass.needsSwap = true;
  // ShaderPass clones uniforms — re-bind the canvas texture so needsUpdate works
  territoryRingPass.uniforms.overlayTexture.value = territoryRingOverlayTexture;
  finalComposer.addPass(territoryRingPass);

  // ========================
  // LENS DIRT POST-PROCESSING
  // ========================

  // Create lens dirt ShaderPass (appended after bloom blend)
  let dirtTextureAspect = 2.0; // default assumes 2:1 (1024x512 fallback)
  function updateDirtUvScale() {
    const screenAR = window.innerWidth / window.innerHeight;
    if (screenAR > dirtTextureAspect) {
      // Screen wider than texture — show full width, crop height
      lensDirtPass.uniforms.dirtUvScale.value.set(1.0, dirtTextureAspect / screenAR);
    } else {
      // Texture wider than screen — show full height, crop width
      lensDirtPass.uniforms.dirtUvScale.value.set(screenAR / dirtTextureAspect, 1.0);
    }
  }
  const lensDirtPass = new THREE.ShaderPass(LensDirtShader);
  lensDirtPass.uniforms.bloomTexture.value =
    bloomComposer.renderTarget2.texture;
  lensDirtPass.uniforms.bloomTexelSize.value.set(1.0 / bloomWidth, 1.0 / bloomHeight);
  lensDirtPass.needsSwap = true;
  finalComposer.addPass(lensDirtPass);

  // Load lens dirt texture from PNG, with procedural Canvas2D fallback
  const textureLoader = new THREE.TextureLoader();
  textureLoader.load(
    "assets/sprites/lenstexture.png",
    (tex) => {
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      lensDirtPass.uniforms.dirtTexture.value = tex;
      dirtTextureAspect = tex.image.width / tex.image.height;
      updateDirtUvScale();
    },
    undefined,
    (err) => {
      console.warn(
        "[VFX] Failed to load lenstexture.png, generating procedural fallback",
        err,
      );
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 512;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 50; i++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        const r = 30 + Math.random() * 120;
        const bVal = Math.floor((0.3 + Math.random() * 0.7) * 255);
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
        gradient.addColorStop(
          0,
          `rgb(${bVal}, ${Math.floor(bVal * 0.96)}, ${Math.floor(bVal * 0.88)})`,
        );
        gradient.addColorStop(
          0.4,
          `rgba(${bVal}, ${Math.floor(bVal * 0.94)}, ${Math.floor(bVal * 0.82)}, 0.5)`,
        );
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      lensDirtPass.uniforms.dirtTexture.value = tex;
      dirtTextureAspect = canvas.width / canvas.height;
      updateDirtUvScale();
    },
  );

  // ========================
  // DAMAGE EFFECTS POST-PROCESSING
  // ========================

  // Damage effects pass (scanlines, noise, glitch, signal loss)
  const damageEffectsPass = new THREE.ShaderPass(DamageEffectsShader);
  damageEffectsPass.needsSwap = true;
  finalComposer.addPass(damageEffectsPass);

  // ========================
  // CHROMATIC ABERRATION POST-PROCESSING
  // ========================

  // Chromatic aberration pass (after damage effects, before vignette)
  const chromaticPass = new THREE.ShaderPass(ChromaticAberrationShader);
  chromaticPass.needsSwap = true;
  finalComposer.addPass(chromaticPass);

  // ========================
  // VIGNETTE POST-PROCESSING
  // ========================

  // Vignette pass (last in chain — frames everything)
  const vignettePass = new THREE.ShaderPass(VignetteShader);
  vignettePass.needsSwap = true;
  finalComposer.addPass(vignettePass);

  // ========================
  // GAME SYSTEMS INIT
  // ========================

  // Random player setup (until onboarding is implemented)
  const FACTIONS = ["rust", "cobalt", "viridian"];
  let playerFaction = FACTIONS[Math.floor(Math.random() * FACTIONS.length)];
  let playerName =
    BOT_NAME_POOL[Math.floor(Math.random() * BOT_NAME_POOL.length)];
  // Expose as globals (read by Dashboard, ProfileCard, ScreenshotSystem, CommanderDrawing)
  window.playerFaction = playerFaction;
  window.playerName = playerName;
  // Player level comes from crypto system (initialized later, default to 1)
  let playerLevel = 1;
  // Server-authoritative faction rank (updated from state ticks)
  window.playerRank = 0;
  // Generate random avatar color (same style as player tags)
  let playerAvatarColor = (() => {
    const hue = Math.floor(Math.random() * 360);
    const sat = 50 + Math.floor(Math.random() * 30); // 50-80%
    const lit = 40 + Math.floor(Math.random() * 20); // 40-60%
    return `hsl(${hue}, ${sat}%, ${lit}%)`;
  })();
  window.avatarColor = playerAvatarColor;

  const planet = new Planet(scene, CONFIG.sphereRadius);
  const environment = new Environment(scene, CONFIG.sphereRadius);
  const tank = new Tank(scene, CONFIG.sphereRadius);

  // Merged hex-tile hull for bloom occlusion (matches actual planet surface with gaps)
  const occlusionSphereMesh = new THREE.Mesh(
    planet.createHullOccluderGeometry(),
    bloomOcclusionMaterial,
  );
  occlusionSphereMesh.name = "planetOccluder";
  occlusionSphereMesh.layers.set(BLOOM_LAYER);
  occlusionSphereMesh.matrixAutoUpdate = false;
  occlusionSphereMesh.updateMatrix();
  planet.hexGroup.add(occlusionSphereMesh);

  const gameCamera = new GameCamera(camera, renderer, CONFIG.sphereRadius);

  // Set player tank faction colors
  tank.setFactionColors(playerFaction);

  // Connect tank to planet for terrain collision
  tank.setPlanet(planet);

  // Load and apply sponsors
  loadAndApplySponsors(planet);

  // Initialize presence tracker (for sponsor card charts)
  if (typeof PresenceTracker !== "undefined") {
    PresenceTracker.init(planet);
  }

  // Fast travel system
  const fastTravel = new FastTravel(scene, planet, tank, gameCamera, renderer);

  // Portal selection is deferred until after onboarding completes
  // (sky beams stay hidden until the player confirms name & faction)
  function startPortalSelection() {
    gameCamera.enterFastTravelImmediate();
    fastTravel.enterFastTravelAtStart();
  }

  // Auth manager (Firebase Auth state management)
  const authManager = new AuthManager();
  window.authManager = authManager;

  // Auth screen (replaces OnboardingScreen — multi-stage login + profile selection)
  const authScreen = new AuthScreen(authManager);
  window._authScreenInstance = authScreen; // Expose for Dashboard profile switching

  // Legacy onboarding screen kept as fallback for offline mode
  const onboardingScreen = new OnboardingScreen();

  // Dust shockwave effect system (create early so fastTravel can use it)
  const dustShockwave = new DustShockwave(scene, CONFIG.sphereRadius);
  dustShockwave.setSunLight(environment.sunLight); // Set sun light for shadow direction
  dustShockwave.setCamera(gameCamera); // Set camera for distance fade
  dustShockwave.setPlanet(planet); // For cliff height capping of effects
  fastTravel.setDustShockwave(dustShockwave);

  // Capture pulse wave effect (sonar-ping during territory capture)
  const capturePulse = new CapturePulse(scene, CONFIG.sphereRadius);
  capturePulse.setPlanet(planet);
  capturePulse.setCamera(gameCamera);
  capturePulse.setTank(tank);

  // Visual effects systems
  // Tread tracks attached to planet so they rotate with it
  const treadTracks = new TreadTracks(planet.hexGroup, CONFIG.sphereRadius);

  // Multiplayer detection (Socket.IO present = server is running)
  const isMultiplayer = typeof io !== "undefined";

  // Bot tanks (after visual effects so they can use tracks)
  // In multiplayer mode, skip bot spawning — only real players
  const botTanks = new BotTanks(
    scene,
    CONFIG.sphereRadius,
    planet,
    treadTracks,
    { skipSpawn: isMultiplayer },
  );
  window.botTanks = botTanks;

  // A* pathfinding for bot navigation — built during init (loading screen visible)
  // Skip in multiplayer (no bots, and pathfinding is expensive to build)
  if (typeof BotPathfinder !== "undefined" && !isMultiplayer) {
    const botPathfinder = new BotPathfinder(planet);
    botTanks.setPathfinder(botPathfinder);
  }

  // Connect fastTravel to botTanks for spawn collision checking
  fastTravel.setBotTanks(botTanks);

  // Connect dust shockwave to bot tanks for deploy effects
  botTanks.setDustShockwave(dustShockwave);

  // Cannon projectile system
  const cannonSystem = new CannonSystem(scene, CONFIG.sphereRadius);
  cannonSystem.setCamera(gameCamera);
  cannonSystem.setPlayerTank(tank);
  cannonSystem.setBotTanks(botTanks);
  cannonSystem.setDustShockwave(dustShockwave);
  cannonSystem.setPlanet(planet);

  // Weapon Slot System (computes loadout modifiers for combat)
  const weaponSlotSystem = new WeaponSlotSystem();
  cannonSystem.weaponSlotSystem = weaponSlotSystem;
  window.weaponSlotSystem = weaponSlotSystem;

  // Crypto System (initialized early, connected to cannon system below)
  const cryptoSystem = new CryptoSystem();
  cannonSystem.setCryptoSystem(cryptoSystem);

  // Connect tread tracks to cannon system for oil puddle detection
  treadTracks.setCannonSystem(cannonSystem);

  // Connect tank to cannon system for ghost reticle range
  tank.setCannonSystem(cannonSystem);

  // Tank damage effects (smoke/fire)
  const tankDamageEffects = new TankDamageEffects(scene, CONFIG.sphereRadius);

  // Tread dust particles
  const treadDust = new TreadDust(scene, CONFIG.sphereRadius);
  treadDust.registerTank("player", tank.group, tank.state);

  // Tank headlights (night-only forward light cones)
  const tankHeadlights = new TankHeadlights();
  tankHeadlights.registerTank("player", tank.group, playerFaction, tank, { spotLights: true, bodyGroup: tank.bodyGroup });

  // Tank collision system
  const tankCollision = new TankCollision(scene, CONFIG.sphereRadius);
  tankCollision.registerTank("player", {
    group: tank.group,
    state: tank.state,
    isBot: false,
    playerRef: tank,
  });

  tankCollision.setPlanet(planet);

  // Connect bot tanks to collision system (singleplayer: bots register on spawn)
  botTanks.setTankCollision(tankCollision);

  // Set up dust lighting (subtle tinting based on sun/fill light)
  const lightConfig = environment.getLightingConfig();
  treadDust.setLightingConfig(lightConfig);
  tankCollision.setLightingConfig(lightConfig);
  cannonSystem.setLightingConfig(lightConfig);
  tankDamageEffects.setLightingConfig(lightConfig);
  tank.setLightingConfig(lightConfig); // Player tank LOD dot
  botTanks.setLightingConfig(lightConfig); // Bot tank LOD dots
  dustShockwave.setLightingConfig(lightConfig); // Muzzle smoke, dustwave, shockwave
  tankHeadlights.setLightingConfig(lightConfig);
  tankHeadlights.setSphereRadius(CONFIG.sphereRadius);

  // Crypto Visuals (connects to cryptoSystem initialized above, with planet for occlusion)
  const cryptoVisuals = new CryptoVisuals(camera, cryptoSystem, planet);
  window.cryptoVisuals = cryptoVisuals; // Global reference for spend floaters
  window.cryptoSystem = cryptoSystem; // Global reference for debugging

  // Register player for tread tracks
  treadTracks.registerTank("player", tank.group, tank.state);

  // Elon Tusk commentary system
  const tuskCommentary = new TuskCommentary();
  window.tuskCommentary = tuskCommentary; // Global reference for other modules

  // Player tags system
  const playerTags = new PlayerTags(camera, CONFIG.sphereRadius);
  window.playerTags = playerTags; // Global reference for commander system

  // Proximity chat system
  const proximityChat = new ProximityChat(playerTags);
  window.proximityChat = proximityChat; // Global reference for commander tip announcements
  proximityChat.setPlayerFaction(playerFaction); // Match player's faction

  // Respawn complete callback - recreate player tag and re-enable chat
  fastTravel.onRespawnComplete = () => {
    // Reset vignette overlay on respawn
    visualEffects.onRespawn();

    playerTags.createTag("player", tank, {
      name: playerName,
      level: playerLevel,
      rank: window.playerRank || 0,
      avatar: null,
      avatarColor: playerAvatarColor,
      squad: null,
      faction: playerFaction,
      isPlayer: true,
      title: window.titleSystem?.getTitle() || "Contractor",
    });
    proximityChat.setPlayerDead(false);

    // Notify commander system of respawn (bodyguards respawn too)
    if (window.commanderSystem) {
      if (window.commanderSystem.isHumanCommander()) {
        window.commanderSystem.onCommanderRespawn(playerFaction);
      } else if (!window.commanderSystem.multiplayerMode) {
        // Dead players are excluded from rankings, so a bot likely stole
        // commander while we were dead. Force an immediate re-evaluation
        // now that we're alive to reclaim commander without waiting for
        // the next 5-second ranking check.
        window.commanderSystem.recheckCommander();
      }
    }
  };

  // Track if player has spawned in
  let hasSpawnedIn = false;

  // Commander leaves the planet surface — despawn bodyguards
  fastTravel.onEnterFastTravel = () => {
    commanderBodyguards.onCommanderLeaveSurface();
  };

  // Commander lands on the planet surface — spawn bodyguards if commander
  fastTravel.onExitFastTravel = () => {
    cryptoSystem.enabled = true;
    hasSpawnedIn = true;

    // Notify bodyguards that commander is on the surface.
    // If a spawn was deferred (became commander while in fast travel), this triggers it.
    commanderBodyguards.onCommanderLand();

    // If commander is already active but bodyguards aren't (returning from fast travel),
    // spawn fresh bodyguards at the new position.
    if (!commanderBodyguards.isActive() && commanderSystem.isHumanCommander() && !commanderSystem.multiplayerMode) {
      const faction = commanderSystem.humanPlayerFaction;
      const commander = commanderSystem.commanders[faction];
      if (commander) {
        commanderBodyguards.spawn(commander, faction);
      }
    }
  };

  // Connect chat system to bot tanks
  botTanks.setChatSystem(proximityChat, playerTags);

  // Register local player with bot system (maintains 100 total players)
  botTanks.registerHumanPlayer("player", tank.group.position, playerFaction);

  // Register all bots for headlights
  botTanks.bots.forEach((bot) => {
    tankHeadlights.registerTank(bot.playerId, bot.group, bot.faction, bot);
  });

  // Start presence tracking for sponsor card charts
  if (typeof PresenceTracker !== "undefined") {
    PresenceTracker.startSampling(botTanks, tank, playerFaction);
  }

  // Create player tag with pre-generated avatar color
  playerTags.createTag("player", tank, {
    name: playerName,
    level: playerLevel,
    rank: window.playerRank || 0,
    avatar: null,
    avatarColor: playerAvatarColor,
    squad: null,
    faction: playerFaction,
    isPlayer: true,
  });

  // Update player tag when level changes
  const originalOnLevelUp = cryptoSystem.onLevelUp;
  cryptoSystem.onLevelUp = (newLevel, oldLevel) => {
    // Update player tag level display
    playerTags.updateLevel("player", newLevel);
    playerLevel = newLevel;
    // Update dashboard level badge (if dashboard exists)
    if (window.dashboard) {
      window.dashboard.setPlayerLevel(newLevel);
    }
    // Trigger Tusk commentary
    tuskCommentary.onLevelUp(newLevel, oldLevel);
    // Call original handler (cryptoVisuals)
    if (originalOnLevelUp) originalOnLevelUp(newLevel, oldLevel);
    // Nudge guest users to sign in
    if (window.authManager?.isGuest && window.dashboard) {
      window.dashboard.showGuestNudge("levelup", `Level ${newLevel}! Sign in to keep your progress`);
    }
  };

  // Create bot tags with random names and levels, and register for dust
  botTanks.bots.forEach((bot) => {
    // Use playerId from lodDot.userData (set during bot creation) for consistency
    const playerId = bot.lodDot.userData.playerId;
    const randomName =
      BOT_NAME_POOL[Math.floor(Math.random() * BOT_NAME_POOL.length)];
    const botLevel = 1 + Math.floor(Math.random() * 5); // 1-5
    const botCrypto = Math.floor(Math.random() * 5001); // 0-5000
    playerTags.createTag(playerId, bot, {
      name: randomName,
      level: botLevel,
      avatar: null,
      squad: null,
      faction: bot.faction,
    });
    // Register with ProfileCard so right-click shows level/crypto
    if (window.profileCard) {
      window.profileCard.registerPlayer({
        id: playerId,
        name: randomName,
        faction: bot.faction,
        level: botLevel,
        crypto: botCrypto,
        rank: 0,
        title: "Contractor",
        badges: [],
        hp: 100,
        maxHp: 100,
        isOnline: true,
        isSelf: false,
      });
    }
    // Register bot for tread dust and tracks
    treadDust.registerTank(playerId, bot.group, bot.state);
    treadTracks.registerTank(playerId, bot.group, bot.state);
    // Register bot for collision detection
    tankCollision.registerTank(playerId, {
      group: bot.group,
      state: bot.state,
      isBot: true,
      botRef: bot,
    });
  });

  // Player count display - counts are now shown in chat headers
  function updatePlayerCount() {
    const allBots = botTanks.bots;
    const remotes = window._mpState?.remoteTanks;
    const remoteCount = remotes ? remotes.size : 0;

    // Only count active bots (not deploying, not dead+fading)
    const activeBots = allBots.filter((b) => !b.isDeploying && (!b.isDead || !b.isFading));
    const totalCount = 1 + activeBots.length + remoteCount;

    // Count faction members (player faction) - only active bots
    let remoteFactionCount = 0;
    if (remotes) {
      remotes.forEach((rt) => {
        if (rt.faction === playerFaction) remoteFactionCount++;
      });
    }
    const factionCount =
      1 + activeBots.filter((b) => b.faction === playerFaction).length + remoteFactionCount;

    // Count squad members (player squad) - currently just the player since bots don't have squads
    const squadCount = 1;

    // Update chat window headers if available
    if (chatWindow) {
      chatWindow.updatePlayerCounts(squadCount, factionCount, totalCount);
    }
  }

  // ========================
  // DAMAGE SYSTEM CALLBACKS
  // ========================

  // Player damage callback - update health bar, VFX, screen shake
  tank.onDamage = (hp, maxHp, amount) => {
    playerTags.updateHP("player", hp, maxHp);
    visualEffects.triggerDamageFlash(amount, maxHp);
    visualEffects.setHealth(hp, maxHp);
    const shakeIntensity = Math.min(amount / (maxHp * 0.5), 1.0);
    const pos = tank.getPosition();
    gameCamera.triggerShake(pos, pos, shakeIntensity, 100);
  };

  // Player damage state callback - update smoke/fire effects
  tank.onDamageStateChange = (state) => {
    tankDamageEffects.setDamageState("player", tank.group, state);
  };

  // Player smoke fade callback - two-phase fade: smoke first, then tank
  tank.onSmokeFadeUpdate = (deadTank, opacity) => {
    tankDamageEffects.setOpacity("player", opacity);
  };

  // Player tank fade callback - tank is fading (smoke already gone)
  tank.onFadeUpdate = (deadTank, opacity) => {
    // Tank opacity is handled in tank.js, nothing extra needed here
  };

  // Player fade complete callback - clean up when fully faded
  tank.onFadeComplete = (deadTank) => {
    // Remove damage effects
    tankDamageEffects.removeTank("player");
    // Hide the tank (setVisible sets _hidden flag so LOD system won't restore visibility)
    deadTank.setVisible(false);
  };

  // Player death callback
  tank.onDeath = (deadTank, killerFaction) => {
    const pos = deadTank.group.position.clone();

    // Vignette death overlay
    try {
      visualEffects.onDeath();
    } catch (e) {
      console.error("[onDeath] visualEffects error:", e);
    }

    // Spawn death explosion + shockwave/dustwave (same scale as bots)
    try {
      cannonSystem._spawnExplosion(pos, deadTank.faction, 1.5);
      dustShockwave.emit(pos, 1.5);
    } catch (e) {
      console.error("[onDeath] explosion error:", e);
    }

    // Spawn oil puddle beneath the tank
    try {
      cannonSystem.spawnOilPuddle(pos);
    } catch (e) {
      console.error("[onDeath] oil puddle error:", e);
    }

    // Cancel any active charge (prevents lingering camera shake/pullback)
    cannonSystem.cancelCharge();

    // Disable player controls and chat
    tank.setControlsEnabled(false);
    proximityChat.setPlayerDead(true);

    // Hide territory control ring immediately
    setTerritoryRingVisible(false);

    // Fade out player tag over 3 seconds
    playerTags.fadeOutTag("player", 3000);

    // Clear player's chat bubbles immediately
    proximityChat.clearMessages("player");

    // Suppress Tusk and pings during terminal sequence
    tuskCommentary.setSuppressed(true);
    pingMarkerSystem.suppressed = true;
    tuskCommentary.onDeath(playerFaction);

    // Track death for title system (lifespan in seconds)
    const lifespan = (Date.now() - (tank.lastSpawnTime || Date.now())) / 1000;
    titleSystem.trackDeath(lifespan);
    badgeSystem.trackDeath();

    // Elon global chat: reset kill streak, track death streak
    playerKillStreak = 0;
    const now = Date.now();
    const deathWindowMs = 300000; // 5 minutes
    if (now - playerDeathWindowStart > deathWindowMs) {
      playerDeathCount = 0;
      playerDeathWindowStart = now;
    }
    playerDeathCount++;
    if (playerDeathCount >= 3 && tuskCommentary.tuskChat) {
      const minutes = Math.floor((now - playerDeathWindowStart) / 60000) || 1;
      tuskCommentary.tuskChat.onDeathStreak(
        playerName,
        playerDeathCount,
        minutes,
        "player",
      );
    }

    // Notify commander system of death (bodyguards die too)
    if (commanderSystem.isHumanCommander()) {
      commanderSystem.onCommanderDeath(playerFaction);
      tuskCommentary.onCommanderDeath(playerName, playerFaction);
    }

    // Respawn triggered by signal lost terminal sequence completing
    visualEffects.onSignalLostComplete = () => {
      tuskCommentary.setSuppressed(!uiVisible);
      pingMarkerSystem.suppressed = false;
      fastTravel.startRespawn();
    };
  };

  // Bot damage state callback - update smoke/fire effects
  botTanks.onBotDamageStateChange = (bot, state) => {
    if (bot.playerId) {
      tankDamageEffects.setDamageState(bot.playerId, bot.group, state);
    }
  };

  // Bot fade update callback - two-phase fade: smoke first, then tank
  // phase='smoke' means only fade smoke effects (tank stays visible)
  // phase=undefined means fade tank (smoke already gone)
  botTanks.onBotFadeUpdate = (bot, opacity, phase) => {
    if (bot.playerId) {
      if (phase === "smoke") {
        // Phase 1: Only fade smoke effects, tank stays at full opacity
        tankDamageEffects.setOpacity(bot.playerId, opacity);
      }
      // Phase 2: Tank is fading in botTanks._updateBotFade, no need to update smoke (already gone)
    }
  };

  // Bot fade complete callback - clean up effects when fully faded
  botTanks.onBotFadeComplete = (bot) => {
    if (bot.playerId) {
      // Remove damage effects
      tankDamageEffects.removeTank(bot.playerId);
    }
    // Unregister lodDot from raycast detection
    if (bot.lodDot && window.tankLODInteraction) {
      window.tankLODInteraction.unregisterDot(bot.lodDot);
    }
    // Hide the bot (keep in array for potential respawn)
    bot.group.visible = false;
  };

  // Elon global chat kill/death tracking
  let playerKillStreak = 0;
  let playerDeathCount = 0;
  let playerDeathWindowStart = Date.now();
  let lastLeadingFaction = null;
  const KILL_MILESTONES = [10, 25, 50, 100];

  // Bot death callback
  botTanks.onBotDeath = (bot, killerFaction) => {
    // Spawn death explosion + shockwave/dustwave (convert to world position since bot is parented to hexGroup)
    const worldPos = new THREE.Vector3();
    bot.group.getWorldPosition(worldPos);
    cannonSystem._spawnExplosion(worldPos, bot.faction, 1.5);
    dustShockwave.emit(worldPos, 1.5);

    // Spawn oil puddle beneath the bot
    cannonSystem.spawnOilPuddle(worldPos);

    // Fade out tag over 3 seconds and clear chat bubbles
    if (bot.playerId) {
      playerTags.fadeOutTag(bot.playerId, 3000);
      proximityChat.clearMessages(bot.playerId);
    }

    // Update player count
    updatePlayerCount();

    // Trigger Tusk commentary if player got the kill
    if (killerFaction === playerFaction) {
      tuskCommentary.onKill(killerFaction, bot.faction);
      titleSystem.trackKill();
      badgeSystem.trackKill(bot.id);

      // Elon global chat: kill announcement, streaks, milestones
      // Pass player IDs for deferred name resolution (names may change between event and send)
      const victimName = bot.lodDot?.userData?.username || "someone";
      if (tuskCommentary.tuskChat) {
        tuskCommentary.tuskChat.onKill(
          playerName,
          victimName,
          playerFaction,
          bot.faction,
          "player",
          bot.playerId,
        );

        playerKillStreak++;
        if (playerKillStreak >= 3) {
          tuskCommentary.tuskChat.onKillStreak(playerName, playerKillStreak, "player");
        }

        const totalKills = cryptoSystem.stats.kills;
        if (KILL_MILESTONES.includes(totalKills)) {
          tuskCommentary.tuskChat.onPlayerMilestone(playerName, totalKills, "player");
        }
      }
    }

    // If this bot was a commander, notify commander system (escort bots die, gold trim removed)
    if (bot.playerId && commanderSystem.isCommander(bot.playerId)) {
      commanderSystem.onCommanderDeath(bot.faction);
      const victimName = bot.lodDot?.userData?.username || "Commander";
      tuskCommentary.onCommanderDeath(victimName, bot.faction);
    }

    // Schedule bot respawn at random portal (5 seconds, same as player)
    setTimeout(() => {
      botTanks.respawnBot(bot);
    }, 5000);
  };

  // Bot respawn callback - recreate tag
  botTanks.onBotRespawn = (bot) => {
    // Use the playerId stored on the lodDot, not the array index
    const playerId = bot.lodDot?.userData?.playerId;
    if (playerId) {
      const randomName =
        BOT_NAME_POOL[Math.floor(Math.random() * BOT_NAME_POOL.length)];
      const botLevel = 1 + Math.floor(Math.random() * 5); // 1-5
      const botCrypto = Math.floor(Math.random() * 5001); // 0-5000
      playerTags.createTag(playerId, bot, {
        name: randomName,
        level: botLevel,
        avatar: null,
        squad: null,
        faction: bot.faction,
      });
      // Update ProfileCard cache with new identity
      if (window.profileCard) {
        window.profileCard.registerPlayer({
          id: playerId,
          name: randomName,
          faction: bot.faction,
          level: botLevel,
          crypto: botCrypto,
          rank: 0,
          title: "Contractor",
          badges: [],
          hp: 100,
          maxHp: 100,
          isOnline: true,
          isSelf: false,
        });
      }

      // Sync new name to lodDot userData
      bot.lodDot.userData.username = randomName;

      // Re-register lodDot for raycast detection
      if (window.tankLODInteraction) {
        window.tankLODInteraction.registerDot(bot.lodDot);
      }

      // Update player count
      updatePlayerCount();
    }
  };

  // ========================
  // GAME STATE
  // ========================

  const dayNightSpeed = (Math.PI * 2) / (CONFIG.dayNightCycleMinutes * 60);
  let planetRotation = 0;

  // Cannon charging system - hold to charge, release to fire
  // Only allow firing in surface mode when controls are enabled
  // Ignore clicks on UI elements
  const isUIClick = (e) => {
    // Block all mouse interaction while auth screen is open
    if (window._authScreenInstance?.isVisible) return true;
    // Check if click is on an interactive UI element
    const target = e.target;
    if (target.tagName === "CANVAS") return false; // Canvas is game
    if (target.closest("#dashboard-container")) return true;
    if (target.closest("#chat-window")) return true;
    if (target.closest("#chat-input-container")) return true;
    if (target.closest("#fast-travel-controls")) return true;
    if (target.closest("#territory-intel-popup")) return true;
    if (target.closest("#tusk-dialogue")) return true;
    if (target.closest("#hud-panel")) return true;
    if (target.closest(".chat-resize-handle")) return true;
    if (target.closest("#commander-tip-panel")) return true;
    if (target.tagName === "BUTTON") return true;
    if (target.tagName === "INPUT") return true;
    if (target.tagName === "SELECT") return true;
    return false;
  };

  // Block browser back/forward navigation from trackpad horizontal swipe.
  // Must be on document (not canvas) to catch swipes over HUD/UI overlays.
  // Allow native scroll inside UI panels with overflow-y.
  document.addEventListener(
    "wheel",
    (e) => {
      if (
        e.target.closest(
          ".dashboard-panels, .chat-section-messages, .dropdown-items",
        )
      )
        return;
      e.preventDefault();
    },
    { passive: false },
  );

  window.addEventListener("mousedown", (e) => {
    if (window._modalOpen) return;
    if (
      e.button === 0 &&
      tank.controlsEnabled &&
      !tank.isDead &&
      gameCamera.mode === "surface"
    ) {
      if (!isUIClick(e)) {
        cannonSystem.startCharge();
      }
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) {
      if (cannonSystem.isCharging()) {
        // Only fire if still in surface mode with controls enabled and alive
        if (
          tank.controlsEnabled &&
          !tank.isDead &&
          gameCamera.mode === "surface"
        ) {
          cannonSystem.releaseCharge(tank, playerFaction);
          // Notify multiplayer server of fire event (include charge power + turret angle)
          if (window._mp && window._mp.onFire) {
            window._mp.onFire(cannonSystem.getLastChargePower(), tank.state.turretAngle);
          }
        } else {
          cannonSystem.cancelCharge();
        }
      }
    }
  });

  // Cancel charge if controls become disabled (e.g., fast travel)
  window.addEventListener("blur", () => {
    cannonSystem.cancelCharge();
  });

  // Chat window (right side panel)
  const chatWindow = new ChatWindow();
  chatWindow.setPlayerInfo(playerFaction, '7"Army');
  proximityChat.chatWindow = chatWindow;
  proximityChat.tuskCommentary = tuskCommentary;

  // Connect Tusk to chat window for global chat posting
  tuskCommentary.chatWindow = chatWindow;
  // In multiplayer, server generates Tusk global chat messages (via tusk-chat events)
  // Only init client-side TuskGlobalChat in single-player mode
  if (!isMultiplayer) {
    tuskCommentary.initGlobalChat();
    // Provide name resolver so Tusk always uses the human player's current gamer tag.
    // Only the human player's name is resolved at send time — bot names stay as
    // captured at event time (bots respawn as different characters).
    if (tuskCommentary.tuskChat) {
      tuskCommentary.tuskChat.getPlayerNameById = (playerId) => {
        if (playerId === "player") return playerName;
        return null; // Bot names handled at event time, not deferred
      };
    }
  }

  // Settings Manager (handles settings persistence and application)
  const settingsManager = new SettingsManager();
  settingsManager.renderer = renderer;
  settingsManager.tuskCommentary = tuskCommentary;
  settingsManager.cryptoVisuals = cryptoVisuals;
  settingsManager.cannonSystem = cannonSystem;
  settingsManager.dustShockwave = dustShockwave;
  settingsManager.treadDust = treadDust;
  settingsManager.environment = environment;
  settingsManager.gameCamera = gameCamera;
  settingsManager.applyAll();
  window.settingsManager = settingsManager; // Global reference for debugging

  // Visual Effects Manager (coordinates post-processing effects)
  const visualEffects = new VisualEffectsManager();
  visualEffects.setLensDirtPass(lensDirtPass);
  visualEffects.setDamageEffectsPass(damageEffectsPass);
  visualEffects.setChromaticPass(chromaticPass);
  visualEffects.setVignettePass(vignettePass);
  visualEffects.setFactionColor(FACTION_COLORS[playerFaction].hex);
  settingsManager.visualEffects = visualEffects;
  cannonSystem.setVisualEffects(visualEffects);
  window.visualEffects = visualEffects; // Global reference for debugging
  window.gameCamera = gameCamera; // Global reference for CommanderDrawing

  // Dashboard (collapsible left panel with settings, stats, etc.)
  const dashboard = new Dashboard();
  dashboard.setCryptoSystem(cryptoSystem);
  dashboard.setSettingsManager(settingsManager);
  dashboard.setPlayerInfo(
    playerName,
    playerFaction,
    playerLevel,
    playerAvatarColor,
    (newFaction) => {
      // Handle faction change from dashboard dropdown
      playerFaction = newFaction;
      window.playerFaction = newFaction;
      tank.setFactionColors(playerFaction);
      tankHeadlights.updateFaction("player", newFaction);
      playerTags.updateFaction("player", playerFaction);
      proximityChat.setPlayerFaction(playerFaction);
      visualEffects.setFactionColor(FACTION_COLORS[playerFaction].hex);
      chatWindow.clearFactionChat(); // Clear old faction's messages
      chatWindow.setPlayerInfo(playerFaction, chatWindow.playerSquad);
      botTanks.registerHumanPlayer(
        "player",
        tank.group.position,
        playerFaction,
      );
      updatePlayerCount();
      // Update presence tracker faction
      if (typeof PresenceTracker !== "undefined") {
        PresenceTracker.setPlayerFaction(playerFaction);
      }
      // Track faction switch for title system (titleSystem created later, use window ref)
      if (window.titleSystem) {
        window.titleSystem.trackFactionSwitch();
      }
      // Update commander system faction
      if (window.commanderSystem) {
        window.commanderSystem.onPlayerFactionChange(newFaction);
      }
      // Notify server of faction change in multiplayer
      if (window.networkManager?.isMultiplayer) {
        window.networkManager.sendFactionChange(newFaction);
      }
    },
  );
  window.dashboard = dashboard; // Global reference for debugging

  // Cosmetics Shop (account-level purchases, profile-level equipping)
  const cosmeticsShop = new CosmeticsShop();
  window.cosmeticsShop = cosmeticsShop;

  // Initialize SponsorStorage for player territory persistence
  // Store the promise so downstream code can await it before using SponsorStorage
  if (typeof SponsorStorage !== "undefined") {
    window._sponsorStorageReady = SponsorStorage.init().catch((e) =>
      console.warn("[main] SponsorStorage init failed:", e),
    );
  }

  // Territory system - give dashboard access to planet, tank, and camera
  dashboard.setTerritoryRefs(planet, tank, gameCamera);

  // Badge System (track achievements and unlock badges)
  const badgeSystem = new BadgeSystem();
  dashboard.setBadgeSystem(badgeSystem);
  window.badgeSystem = badgeSystem; // Global reference for debugging

  // Title System (dynamic titles based on 24hr performance)
  const titleSystem = new TitleSystem(cryptoSystem);
  dashboard.setTitleSystem(titleSystem);
  cannonSystem.setTitleSystem(titleSystem);
  titleSystem.onTitleChange = (newTitle, oldTitle) => {
    playerTags.updateTitle("player", newTitle);
    dashboard.updateTitle(newTitle);
    // Broadcast title change to other players
    if (window.networkManager?.connected) {
      window.networkManager.sendProfile({
        badges: window.badgeSystem?.getUnlockedBadges()?.map((b) => b.id) || [],
        totalCrypto: window.cryptoSystem?.stats?.totalCrypto || 0,
        title: newTitle,
        avatarColor: window.avatarColor || null,
      });
    }
  };
  // Update player tag with current title (tag was created before titleSystem)
  playerTags.updateTitle("player", titleSystem.getTitle());
  window.titleSystem = titleSystem; // Global reference for debugging

  // Firestore sync and profile manager
  const firestoreSync = new FirestoreSync();
  const profileManager = new ProfileManager(firestoreSync);
  profileManager.cryptoSystem = cryptoSystem;
  profileManager.badgeSystem = badgeSystem;
  profileManager.titleSystem = titleSystem;
  profileManager.dashboard = dashboard;
  profileManager.settingsManager = settingsManager;
  profileManager.weaponSlotSystem = weaponSlotSystem;
  window.firestoreSync = firestoreSync;
  window.profileManager = profileManager;

  // Profile Card System (right-click player profiles)
  const profileCard = new ProfileCard(badgeSystem, titleSystem);
  profileCard.playerTags = playerTags; // Wire up for tank-to-player lookups
  window.profileCard = profileCard; // Global reference for debugging

  // ========================
  // COMMANDER SYSTEM
  // ========================

  // Commander visual effects (gold trim)
  const commanderSkin = new CommanderSkin();

  // Commander bodyguards (2 bots that follow and protect)
  const commanderBodyguards = new CommanderBodyguards(
    scene,
    CONFIG.sphereRadius,
    planet,
  );
  commanderBodyguards.setCannonSystem(cannonSystem);
  commanderBodyguards.setTreadDust(treadDust);
  commanderBodyguards.setTankCollision(tankCollision);
  commanderBodyguards.setDustShockwave(dustShockwave);
  commanderBodyguards.setPlayerTags(playerTags);
  commanderBodyguards.setTankDamageEffects(tankDamageEffects);
  commanderBodyguards.setTankHeadlights(tankHeadlights);

  // Connect bodyguard damage state changes to smoke/fire effects
  commanderBodyguards.onGuardDamageStateChange = (guard, state) => {
    tankDamageEffects.setDamageState(
      `bodyguard-${guard.index}`,
      guard.group,
      state,
    );
  };

  // Connect bodyguard fade updates to smoke opacity
  commanderBodyguards.onGuardFadeUpdate = (guard, opacity, phase) => {
    if (phase === "smoke") {
      tankDamageEffects.setOpacity(`bodyguard-${guard.index}`, opacity);
    }
  };

  // Commander drawing system (tactical drawings on planet)
  const commanderDrawing = new CommanderDrawing(
    scene,
    camera,
    planet,
    CONFIG.sphereRadius,
    renderer,
  );

  // Ping marker system (tactical pings visible to faction/squad)
  const pingMarkerSystem = new PingMarkerSystem(
    scene,
    camera,
    planet,
    CONFIG.sphereRadius,
    renderer,
  );

  // Commander tip system (crypto tipping to other players)
  const commanderTipSystem = new CommanderTipSystem(cryptoSystem);

  // Core commander system (manages commander state and rankings)
  const commanderSystem = new CommanderSystem();
  commanderSystem.setCryptoSystem(cryptoSystem);
  commanderSystem.setBotTanks(botTanks);
  commanderSystem.setSkin(commanderSkin);
  commanderSystem.setBodyguards(commanderBodyguards);
  commanderSystem.setDrawing(commanderDrawing);
  commanderSystem.setTipSystem(commanderTipSystem);

  // Wire up crypto system callback for commander ranking
  cryptoSystem.onSessionCryptoChange = (playerId, sessionCrypto) => {
    commanderSystem.updateSessionCrypto(playerId, sessionCrypto);
  };

  // Commander change callback
  commanderSystem.onCommanderChange = (newCommander, oldCommander, faction) => {
    // Tusk commentary on commander changes
    if (newCommander && newCommander.isHuman) {
      tuskCommentary.onNewCommander(newCommander.username, faction);
      badgeSystem.trackBecameCommander();
    }
    if (
      oldCommander &&
      oldCommander.isHuman &&
      newCommander &&
      !newCommander.isHuman
    ) {
      tuskCommentary.onCommanderDemotion(oldCommander.username, faction);
    }

    // Sync commander status to LOD dots for hover tooltips
    if (window.tankLODInteraction) {
      // Update old commander's dot (no longer commander)
      if (oldCommander) {
        window.tankLODInteraction.updateDotData(oldCommander.playerId, {
          isCommander: false,
        });
      }
      // Update new commander's dot
      if (newCommander) {
        window.tankLODInteraction.updateDotData(newCommander.playerId, {
          isCommander: true,
        });
      }
    }
  };

  // Set commander system reference for drawing, tips, and pings
  commanderDrawing.setCommanderSystem(commanderSystem);
  commanderTipSystem.setCommanderSystem(commanderSystem);
  pingMarkerSystem.setCommanderSystem(commanderSystem);
  pingMarkerSystem.setProximityChat(proximityChat);
  pingMarkerSystem.setPlayerTank(tank);
  pingMarkerSystem.setBotTanks(botTanks);

  // Global reference for settings manager and other systems
  window.commanderSystem = commanderSystem;
  window.pingMarkerSystem = pingMarkerSystem;

  // ========================
  // MULTIPLAYER BRIDGE
  // ========================
  // Expose references for MultiplayerClient.js to hook into.
  // These are only used if multiplayer mode is active.
  window._mp = {
    isMultiplayer,
    tank,
    scene,
    sphereRadius: CONFIG.sphereRadius,
    planet,
    playerTags,
    cannonSystem,
    treadDust,
    treadTracks,
    tankHeadlights,
    tankCollision,
    tankDamageEffects,
    dustShockwave,
    gameCamera,
    visualEffects,
    environment,
    proximityChat,
    botTanks,
    capturePulse,
    commanderDrawing,
    updatePlayerCount,

    // Called by MultiplayerClient when server assigns faction
    setPlayerFaction: (faction) => {
      playerFaction = faction;
      window.playerFaction = faction;
      tank.setFactionColors(faction);
      tankHeadlights.updateFaction("player", faction);
      playerTags.updateFaction("player", faction);
      proximityChat.setPlayerFaction(faction);
      visualEffects.setFactionColor(FACTION_COLORS[faction].hex);
      // Update ChatWindow faction (for faction tab header color + filtering)
      if (proximityChat.chatWindow) {
        proximityChat.chatWindow.clearFactionChat();
        proximityChat.chatWindow.setPlayerInfo(faction, proximityChat.chatWindow.playerSquad);
      }
      botTanks.registerHumanPlayer("player", tank.group.position, faction);
      updatePlayerCount();
      // Update dashboard faction display
      if (window.dashboard) {
        window.dashboard.playerFaction = faction;
        window.dashboard._updateAvatarFaction(faction);
        window.dashboard._updateFactionDropdown(faction);
        window.dashboard._updateTankPreview();
        window.dashboard._resetFactionPanel(faction);
      }
      if (typeof PresenceTracker !== "undefined") {
        PresenceTracker.setPlayerFaction(faction);
      }
      if (window.titleSystem) {
        window.titleSystem.trackFactionSwitch();
      }
      if (window.commanderSystem) {
        window.commanderSystem.onPlayerFactionChange(faction);
      }
    },

    // Called by MultiplayerClient when server assigns name
    setPlayerName: (name) => {
      playerName = name;
      window.playerName = name;
      playerTags.updateName("player", name);
      if (tank.lodDot) {
        tank.lodDot.userData.username = name;
      }
      // Update dashboard name display
      if (window.dashboard) {
        window.dashboard.playerName = name;
        const nameEl = document.getElementById("dashboard-player-name");
        if (nameEl) nameEl.textContent = name;
      }
    },

    // Fast travel reference (for multiplayer to exit portal selection)
    fastTravel,

    // Mark player as spawned in (for multiplayer skip-portal flow)
    setSpawnedIn: () => {
      hasSpawnedIn = true;
      cryptoSystem.enabled = true;
    },

    // Planet rotation sync
    getPlanetRotation: () => planetRotation,
    setPlanetRotation: (pr) => {
      planetRotation = pr;
    },

    // Celestial body sync
    applyCelestialConfig: (config) => environment.applyCelestialConfig(config),

    // Territory ring HUD functions (called by MultiplayerClient in multiplayer mode)
    updateTugOfWarUI,
    setTerritoryRingVisible,
    clearTugOfWarUI,
    triggerTickFlash,
    getHasSpawnedIn: () => hasSpawnedIn,

    // Hook for multiplayer frame updates (called in animate())
    onFrameUpdate: null,

    // Hook for fire events
    onFire: null,

    // Called by MultiplayerClient to report sponsor texture loading progress (0-1)
    setSponsorLoadProgress: (p) => { sponsorLoadProgress = p; },
    // Called by MultiplayerClient after sponsor textures are preloaded
    setSponsorTexturesReady: () => { sponsorLoadProgress = 1; sponsorTexturesReady = true; },
  };

  // Wire auth screen confirm callback (used when Firebase is available)
  authScreen.onConfirm = ({ name, faction, profileIndex, profileData }) => {
    // Detect mid-game profile switch (profile was already loaded)
    const isProfileSwitch = profileManager.loaded;

    // Store profile context for other systems
    window.activeProfileIndex = profileIndex;
    window.activeProfileData = profileData;

    // Load profile data into all game systems via ProfileManager
    profileManager.loadProfile(profileIndex, profileData);

    // Load cosmetics purchases + equipped items from Firestore
    cosmeticsShop.loadFromFirestore();

    // Update local state via the mp interface
    window._mp.setPlayerFaction(faction);
    window._mp.setPlayerName(name);

    // Reset rank (server will send the correct rank for this profile)
    window.playerRank = 0;
    window.playerRankTotal = 0;

    // Update dashboard with new profile's name, faction, and level
    if (window.dashboard) {
      // On profile switch, reset crypto display state so the new value can be set
      if (isProfileSwitch) {
        window.dashboard.resetForProfileSwitch();
      }
      window.dashboard.playerName = name;
      window.dashboard.playerFaction = faction;
      window.dashboard.playerLevel = playerLevel;
      const nameEl = document.getElementById("dashboard-player-name");
      if (nameEl) nameEl.textContent = name;
      window.dashboard.updateProfile({
        level: profileData.level || 1,
        crypto: profileData.totalCrypto || 0,
        rank: 0,
        rankTotal: 0,
      });
    }

    // Update ProfileCard crypto state for self on profile switch
    if (isProfileSwitch && window.profileCard && window.networkManager?.playerId) {
      window.profileCard.latestCryptoState[window.networkManager.playerId] = profileData.totalCrypto || 0;
    }

    // Update avatar across all systems (profile picture or fallback color)
    const avatarValue = profileData?.profilePicture || playerAvatarColor;
    playerAvatarColor = avatarValue;
    window.avatarColor = avatarValue;

    // Update dashboard avatar
    if (window.dashboard) {
      window.dashboard.avatarColor = avatarValue;
      const avatarInnerEl = document.getElementById("dashboard-avatar-inner");
      if (avatarInnerEl) {
        if (avatarValue.startsWith("data:")) {
          avatarInnerEl.style.background = "";
          avatarInnerEl.style.backgroundImage = `url(${avatarValue})`;
          avatarInnerEl.style.backgroundSize = "cover";
          avatarInnerEl.style.backgroundPosition = "center";
        } else {
          avatarInnerEl.style.backgroundImage = "";
          avatarInnerEl.style.background = avatarValue;
        }
      }
    }

    // Recreate player tag with current avatar
    playerTags.createTag("player", tank, {
      name: name,
      level: playerLevel,
      rank: window.playerRank || 0,
      avatar: null,
      avatarColor: avatarValue,
      squad: null,
      faction: faction,
      isPlayer: true,
      title: window.titleSystem?.getTitle() || "Contractor",
    });

    // Send chosen identity to server (token already sent via Socket.IO handshake)
    if (window.networkManager) {
      window.networkManager.sendIdentity(name, faction);

      // Resend profile with correct avatarColor (initial sendProfile fires before
      // auth confirms, so window.avatarColor was still a random HSL fallback)
      if (window.networkManager.connected) {
        window.networkManager.sendProfile({
          badges: window.badgeSystem?.getUnlockedBadges()?.map((b) => b.id) || [],
          totalCrypto: window.cryptoSystem?.stats?.totalCrypto || 0,
          title: window.titleSystem?.getTitle?.() || "Contractor",
          avatarColor: window.avatarColor || null,
        });
      }

      // On mid-game profile switch, notify server of full profile change
      // so it resets player.crypto and broadcasts to all clients
      if (isProfileSwitch && window.networkManager.connected) {
        window.networkManager.sendSetProfile(profileIndex, profileData);
      }
    }

    // Show "Switch Profile" button in dashboard
    dashboard.showSwitchProfileButton(true);

    // Fade out auth screen, then reveal sky beams + portal selection
    authScreen.hide(() => {
      startPortalSelection();
    });
  };

  // Wire legacy onboarding screen confirm callback (offline/fallback)
  onboardingScreen.onConfirm = ({ name, faction }) => {
    // Update local state via the mp interface
    window._mp.setPlayerFaction(faction);
    window._mp.setPlayerName(name);

    // Send chosen identity to server
    if (window.networkManager) {
      window.networkManager.sendIdentity(name, faction);
    }

    // Fade out onboarding, then reveal sky beams + portal selection
    onboardingScreen.hide(() => {
      startPortalSelection();
    });
  };

  // Ping marker placement - left-click in orbital/fast travel mode
  // (Must be after pingMarkerSystem and commanderSystem are initialized)
  const pingRaycaster = new THREE.Raycaster();
  const pingMouse = new THREE.Vector2();

  window.addEventListener("click", (e) => {
    // Only left-click in orbital or fast travel mode
    if (e.button !== 0) return;
    if (gameCamera.mode !== "orbital" && gameCamera.mode !== "fastTravel")
      return;
    if (isUIClick(e)) return;
    if (tank.isDead) return;

    // Don't place ping if commander is drawing or tip-dragging
    if (commanderDrawing.isCurrentlyDrawing()) return;
    if (commanderTipSystem.isBlockingWeaponFire()) return;

    // Convert mouse to normalized device coords
    pingMouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    pingMouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    // Don't place ping if clicking on a sky beam (fast travel destination selection)
    if (fastTravel.isClickOnBeam(pingMouse.x, pingMouse.y)) return;

    const isCommander = commanderSystem.isHumanCommander();
    const playerSquad = proximityChat.playerSquad;

    // Check if clicking on a player dot (ping follows that player)
    const clickedPlayer = tankLODInteraction.getClickedPlayer(
      pingMouse.x,
      pingMouse.y,
    );
    if (clickedPlayer) {
      pingMarkerSystem.placePing(
        "player",
        clickedPlayer.position,
        isCommander,
        playerFaction,
        playerSquad,
        { followingPlayerId: clickedPlayer.playerId },
      );
      // Broadcast commander pings to faction via server
      if (isCommander && window.networkManager?.isMultiplayer) {
        const localPos = planet.hexGroup
          .worldToLocal(clickedPlayer.position.clone())
          .normalize();
        window.networkManager.sendCommanderPing({
          x: localPos.x,
          y: localPos.y,
          z: localPos.z,
        });
      }
      return;
    }

    // Raycast to planet (static ground ping)
    pingRaycaster.setFromCamera(pingMouse, camera);
    const intersects = pingRaycaster.intersectObject(planet.hexGroup, true);

    if (intersects.length > 0) {
      const worldPoint = intersects[0].point;

      pingMarkerSystem.placePing(
        "player",
        worldPoint,
        isCommander,
        playerFaction,
        playerSquad,
      );
      // Broadcast commander pings to faction via server
      if (isCommander && window.networkManager?.isMultiplayer) {
        const localPos = planet.hexGroup
          .worldToLocal(worldPoint.clone())
          .normalize();
        window.networkManager.sendCommanderPing({
          x: localPos.x,
          y: localPos.y,
          z: localPos.z,
        });
      }
    }
  });

  // Register human player with commander system
  commanderSystem.registerHumanPlayer(
    "player",
    playerFaction,
    tank,
    playerName,
  );

  // Apply commander override setting if it was saved as enabled (single-player only;
  // in multiplayer the server handles override via commander-override socket event)
  if (settingsManager.get("testing.commanderOverride") && typeof io === "undefined") {
    commanderSystem.setCommanderOverride(true);
  }

  // Screenshot System (capture and share screenshots)
  const screenshotSystem = new ScreenshotSystem(renderer, badgeSystem);
  screenshotSystem.setupQuickCapture(); // Enable F12 quick capture
  dashboard.setScreenshotSystem(screenshotSystem);
  window.screenshotSystem = screenshotSystem; // Global reference for debugging

  // Tank LOD Interaction (hover/right-click for colored dots in commander mode)
  const tankLODInteraction = new TankLODInteraction(camera, scene);
  tankLODInteraction.registerDot(tank.lodDot); // Register player's LOD dot

  // Update player's lodDot userData with correct name and faction
  if (tank.lodDot) {
    tank.lodDot.userData.username = playerName;
    tank.lodDot.userData.faction = playerFaction;
    tank.lodDot.userData.playerId = "player";
  }

  // Register all bot dots and sync names from playerTags
  botTanks.bots.forEach((bot) => {
    if (bot.lodDot) {
      tankLODInteraction.registerDot(bot.lodDot);
      // Sync bot name from playerTags to lodDot userData
      const playerId = bot.lodDot.userData.playerId;
      const tagData = playerTags.getTagConfig(playerId);
      if (tagData) {
        bot.lodDot.userData.username = tagData.name;
        bot.lodDot.userData.squad = tagData.squad;
      }
    }
  });

  window.tankLODInteraction = tankLODInteraction;

  // Initial player count update (after chatWindow is created)
  updatePlayerCount();

  const factionColorMap = {
    rust: FACTION_COLORS.rust.css,
    cobalt: FACTION_COLORS.cobalt.css,
    viridian: FACTION_COLORS.viridian.css,
  };

  // Track previous owners for flip detection
  const previousOwners = new Map();
  const sponsorPreviousOwners = new Map();

  // ========================
  // TERRITORY CHART - TUSK COMMENTARY
  // ========================

  const pieColors = {
    rust: FACTION_COLORS.rust.css,
    cobalt: FACTION_COLORS.cobalt.css,
    viridian: FACTION_COLORS.viridian.css,
    unclaimed: "#2a2a2a",
  };

  // Preallocated for updateTerritoryChart (avoid .map() allocation)
  const _territoryCounts = { rust: 0, cobalt: 0, viridian: 0, unclaimed: 0 };
  const _territoryFactionCounts = [
    { faction: "rust", count: 0 },
    { faction: "cobalt", count: 0 },
    { faction: "viridian", count: 0 },
  ];

  function updateTerritoryChart() {
    const totalClusters = planet.clusterData.length;
    const ownership = planet.clusterOwnership;

    // Count clusters per faction (reuse preallocated object)
    _territoryCounts.rust = 0;
    _territoryCounts.cobalt = 0;
    _territoryCounts.viridian = 0;
    _territoryCounts.unclaimed = 0;
    for (let i = 0; i < totalClusters; i++) {
      const faction = ownership.get(i);
      if (faction) {
        _territoryCounts[faction]++;
      } else {
        _territoryCounts.unclaimed++;
      }
    }
    const counts = _territoryCounts;

    // Check faction standing for Elon Tusk commentary (update in place, avoid .map())
    _territoryFactionCounts[0].faction = "rust";
    _territoryFactionCounts[0].count = counts.rust;
    _territoryFactionCounts[1].faction = "cobalt";
    _territoryFactionCounts[1].count = counts.cobalt;
    _territoryFactionCounts[2].faction = "viridian";
    _territoryFactionCounts[2].count = counts.viridian;
    _territoryFactionCounts.sort((a, b) => b.count - a.count);
    const factionCounts = _territoryFactionCounts;

    const playerFactionCount = counts[playerFaction];
    const maxCount = factionCounts[0].count;
    const minCount = factionCounts[2].count;

    // Only trigger if there's meaningful territory claimed
    if (maxCount > 0) {
      if (playerFactionCount === maxCount && playerFactionCount > minCount) {
        // Player's faction is leading
        tuskCommentary.onFactionLeading();
      } else if (
        playerFactionCount === minCount &&
        playerFactionCount < maxCount
      ) {
        // Player's faction is losing (has least territory)
        tuskCommentary.onFactionLosing();
      }

      // Elon global chat: faction lead change
      if (tuskCommentary.tuskChat) {
        const currentLeader = factionCounts[0].faction;
        if (currentLeader !== lastLeadingFaction && maxCount > minCount) {
          lastLeadingFaction = currentLeader;
          const percent = (factionCounts[0].count / totalClusters) * 100;
          const loser1 = factionCounts[1].faction;
          const loser2 = factionCounts[2].faction;
          tuskCommentary.tuskChat.onFactionLeadChange(
            currentLeader,
            percent,
            loser1,
            loser2,
          );
        }

        // Faction struggling: any faction below 10% territory
        const claimedClusters = totalClusters - counts.unclaimed;
        if (claimedClusters > 5) {
          for (const fc of factionCounts) {
            const pct = (fc.count / totalClusters) * 100;
            if (pct > 0 && pct < 10) {
              tuskCommentary.tuskChat.onFactionStruggle(fc.faction, pct);
              break; // Only report one struggling faction at a time
            }
          }
        }
      }
    }
  }

  // Initial chart render
  updateTerritoryChart();

  // ========================
  // FULLSCREEN GLOBAL CONTROL OVERLAY
  // ========================

  function showGlobalControlOverlay() {
    const overlay = document.getElementById("global-control-overlay");
    overlay.classList.remove("hidden");
    renderFullscreenPieChart();
  }

  function hideGlobalControlOverlay() {
    const overlay = document.getElementById("global-control-overlay");
    overlay.classList.add("hidden");
  }

  function renderFullscreenPieChart() {
    const canvas = document.getElementById("global-control-canvas");
    const ctx = canvas.getContext("2d");

    // Resize canvas to fill viewport
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Calculate pie chart dimensions (bigger - 95% of viewport)
    const size = Math.min(canvas.width, canvas.height) * 0.95;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const radius = size / 2;

    // Reuse existing data calculation logic
    const totalClusters = planet.clusterData.length;
    const ownership = planet.clusterOwnership;

    const counts = { rust: 0, cobalt: 0, viridian: 0, unclaimed: 0 };
    for (let i = 0; i < totalClusters; i++) {
      const faction = ownership.get(i);
      if (faction) {
        counts[faction]++;
      } else {
        counts.unclaimed++;
      }
    }

    const pcts = {};
    for (const faction in counts) {
      pcts[faction] =
        totalClusters > 0 ? (counts[faction] / totalClusters) * 100 : 0;
    }

    // Draw donut chart with same color scheme
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const innerRadius = radius * 0.5; // Donut hole is 50% of outer radius

    // Calculate angles for each faction
    const angles = {};
    for (const faction in counts) {
      angles[faction] = (counts[faction] / totalClusters) * Math.PI * 2;
    }

    // Build draw order: Player → Other1 → Unclaimed → Other2
    // Same orientation as territory ring: player at top, unclaimed at bottom
    const otherFactions = ["rust", "cobalt", "viridian"].filter(
      (f) => f !== playerFaction,
    );
    const order = [
      playerFaction,
      otherFactions[0],
      "unclaimed",
      otherFactions[1],
    ];

    // Start angle: center player faction at 12 o'clock (top)
    let startAngle = -Math.PI / 2 - angles[playerFaction] / 2;

    for (const faction of order) {
      const sliceAngle = angles[faction];
      if (sliceAngle > 0) {
        // Draw donut segment (arc with inner cutout)
        ctx.beginPath();
        ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
        ctx.arc(cx, cy, innerRadius, startAngle + sliceAngle, startAngle, true);
        ctx.closePath();
        ctx.fillStyle = pieColors[faction];
        ctx.fill();

        startAngle += sliceAngle;
      }
    }

    // Position DOM percentage labels at the midpoint of each slice
    const statsEl = document.getElementById("global-control-stats");
    statsEl.innerHTML = "";
    const labelRadius = (radius + innerRadius) / 2; // Center of donut ring
    let labelAngle = -Math.PI / 2 - angles[playerFaction] / 2;

    for (const faction of order) {
      const sliceAngle = angles[faction];
      if (sliceAngle > 0 && pcts[faction] > 0) {
        const midAngle = labelAngle + sliceAngle / 2;
        const lx = cx + Math.cos(midAngle) * labelRadius;
        const ly = cy + Math.sin(midAngle) * labelRadius;

        const label = document.createElement("div");
        label.className = "slice-label";
        label.textContent = pcts[faction].toFixed(1) + "%";
        label.style.left = lx + "px";
        label.style.top = ly + "px";
        statsEl.appendChild(label);

        labelAngle += sliceAngle;
      }
    }
  }

  // ========================
  // CAPTURE SYSTEM
  // ========================

  const clusterInfoEl = document.getElementById("cluster-info");

  // Preallocated objects for updateCapture (avoid per-call GC)
  const _captureClusterTankCounts = new Map();
  const _captureFactions = ["rust", "cobalt", "viridian"];
  const _captureOldTics = { rust: 0, cobalt: 0, viridian: 0 };
  const _capturePlayerWorldPos = new THREE.Vector3();


  function updateCapture() {
    // Build tank counts per cluster (reuse preallocated Map)
    _captureClusterTankCounts.clear();
    const clusterTankCounts = _captureClusterTankCounts;

    // Add player tank (skip if dead)
    const playerCluster = tank.getCurrentClusterId(planet);

    if (playerCluster !== undefined && !tank.isDead && hasSpawnedIn) {
      if (!clusterTankCounts.has(playerCluster)) {
        clusterTankCounts.set(playerCluster, {
          rust: 0,
          cobalt: 0,
          viridian: 0,
        });
      }
      clusterTankCounts.get(playerCluster)[playerFaction]++;
    }

    // Add bot tanks
    const botCounts = botTanks.getBotsPerCluster();
    botCounts.forEach((counts, clusterId) => {
      if (!clusterTankCounts.has(clusterId)) {
        clusterTankCounts.set(clusterId, { rust: 0, cobalt: 0, viridian: 0 });
      }
      const existing = clusterTankCounts.get(clusterId);
      existing.rust += counts.rust;
      existing.cobalt += counts.cobalt;
      existing.viridian += counts.viridian;
    });

    // Process all clusters with tanks
    clusterTankCounts.forEach((counts, clusterId) => {
      const state = planet.clusterCaptureState.get(clusterId);
      if (!state) return;

      // Manual copy avoids object spread allocation
      _captureOldTics.rust = state.tics.rust;
      _captureOldTics.cobalt = state.tics.cobalt;
      _captureOldTics.viridian = state.tics.viridian;
      const previousOwner = state.owner;

      // Calculate current total tics to determine if we're in filling or contest phase
      const currentTotalTics =
        state.tics.rust + state.tics.cobalt + state.tics.viridian;
      const isFull = currentTotalTics >= state.capacity;

      // Process tic gains - inline loop avoids .filter() array allocation
      for (const faction of _captureFactions) {
        if (counts[faction] <= 0) continue;
        const ticsToAdd = counts[faction];

        // Subtract from enemy factions (split evenly among those with tics)
        let enemyCount = 0;
        for (const f of _captureFactions) {
          if (f !== faction && state.tics[f] > 0) enemyCount++;
        }

        if (enemyCount > 0) {
          const lossPerEnemy = ticsToAdd / enemyCount;
          for (const f of _captureFactions) {
            if (f !== faction && state.tics[f] > 0) {
              state.tics[f] = Math.max(0, state.tics[f] - lossPerEnemy);
            }
          }
        }

        state.tics[faction] += ticsToAdd;

        // Award crypto for player contributing tics
        if (
          faction === playerFaction &&
          clusterId === playerCluster &&
          !tank.isDead
        ) {
          // Calculate enemy tic presence
          const enemyTics =
            state.tics.rust +
            state.tics.cobalt +
            state.tics.viridian -
            state.tics[playerFaction];

          // Check if territory is fully owned with no contest
          const isFullyOwned =
            state.owner === playerFaction &&
            state.tics[playerFaction] >= state.capacity * 0.99;
          const hasEnemyPresence = enemyTics > 0.5; // Account for floating point math

          // Only award crypto if territory is NOT fully secured (contested or uncaptured)
          if (!isFullyOwned || hasEnemyPresence) {
            tank.group.getWorldPosition(_capturePlayerWorldPos);
            cryptoSystem.awardTicCrypto(_capturePlayerWorldPos);
            capturePulse.emit(_capturePlayerWorldPos, playerFaction, playerCluster);
          }
        }
      }

      // Cap total tics at cluster capacity
      const totalTics =
        state.tics.rust + state.tics.cobalt + state.tics.viridian;
      if (totalTics > state.capacity) {
        // Scale down proportionally to fit capacity
        const scale = state.capacity / totalTics;
        for (const faction of _captureFactions) {
          state.tics[faction] *= scale;
        }
      }

      // Calculate momentum for UI
      for (const faction of _captureFactions) {
        state.momentum[faction] = state.tics[faction] - _captureOldTics[faction];
      }

      // Determine ownership (only when capacity is filled)
      const currentTotal =
        state.tics.rust + state.tics.cobalt + state.tics.viridian;
      if (currentTotal >= state.capacity) {
        // Find faction with most tics
        let maxTics = 0;
        let leadingFaction = null;
        let isTied = false;

        for (const faction of _captureFactions) {
          if (state.tics[faction] > maxTics) {
            maxTics = state.tics[faction];
            leadingFaction = faction;
            isTied = false;
          } else if (state.tics[faction] === maxTics && maxTics > 0) {
            isTied = true;
          }
        }

        // Only assign owner if there's a clear leader (no tie)
        state.owner = isTied ? null : leadingFaction;
      } else {
        // Capacity not filled yet - no owner
        state.owner = null;
      }

      // Track ownership flip for animation
      if (state.owner !== previousOwner) {
        previousOwners.set(clusterId, { from: previousOwner, to: state.owner });
        planet.setTerritoryWeak(clusterId, null);

        // Tusk commentary on territory changes (player faction only)
        if (state.owner === playerFaction) {
          tuskCommentary.onCapture(state.owner, clusterId);
          titleSystem.trackClusterCapture();
          // Crypto is now awarded per-minute for holding, not on capture
        }
        if (previousOwner === playerFaction) {
          tuskCommentary.onLoseTerritory(previousOwner, clusterId);
        }

        // Elon global chat: announce any cluster capture
        if (state.owner && tuskCommentary.tuskChat) {
          const clusterLabel = `Sector ${clusterId}`;
          let capturerName = playerName;
          let capturerPlayerId = "player";
          if (state.owner !== playerFaction) {
            // Pick a random bot name from the capturing faction
            const factionBots = (botTanks.bots || []).filter(
              (b) => b && !b.isDead && b.faction === state.owner,
            );
            const randomBot =
              factionBots.length > 0
                ? factionBots[Math.floor(Math.random() * factionBots.length)]
                : null;
            capturerName = randomBot?.lodDot?.userData?.username || state.owner;
            capturerPlayerId = randomBot?.playerId || null;
          }
          tuskCommentary.tuskChat.onClusterCapture(
            capturerName,
            clusterLabel,
            state.owner,
            capturerPlayerId,
          );
        }
      } else {
        // Check for weak territory (enemy close to taking over)
        if (state.owner) {
          const ownerTics = state.tics[state.owner];
          let attackingFaction = null;
          let maxAttackerTics = 0;
          for (const f of _captureFactions) {
            if (f !== state.owner && state.tics[f] > ownerTics * 0.85) {
              if (state.tics[f] > maxAttackerTics) {
                maxAttackerTics = state.tics[f];
                attackingFaction = f;
              }
            }
          }
          planet.setTerritoryWeak(clusterId, attackingFaction);
        } else {
          planet.setTerritoryWeak(clusterId, null);
        }
      }

      planet.updateClusterVisual(clusterId);
    });

    // Update tug-of-war UI for player's current cluster
    if (playerCluster !== undefined) {
      const state = planet.clusterCaptureState.get(playerCluster);
      if (!state) {
        // Player is on a tile with no capture state (portal/neutral) — treat as no cluster
        clearTugOfWarUI();
        if (hasSpawnedIn) setTerritoryRingVisible(false);
      } else {
        const counts = clusterTankCounts.get(playerCluster) || {
          rust: 0,
          cobalt: 0,
          viridian: 0,
        };
        updateTugOfWarUI(playerCluster, state, counts);
        // Only show ring if player has spawned in
        if (hasSpawnedIn) {
          setTerritoryRingVisible(true); // Fade in when on active cluster
        }

        if (previousOwners.has(playerCluster)) {
          triggerOwnershipFlip();
          previousOwners.delete(playerCluster);
        }
      }
    } else {
      clearTugOfWarUI();
      if (hasSpawnedIn) {
        setTerritoryRingVisible(false); // Fade out when on neutral territory
      }
    }

    updateTerritoryChart();
    updateSponsorHoldTimers();
    planet.updateDirtyFactionOutlines();
  }

  // ========================
  // TUG-OF-WAR UI (Ring + Sidebar)
  // ========================

  // Territory ring canvas setup
  const territoryRingCanvas = document.getElementById("territory-ring");
  const territoryRingCtx = territoryRingCanvas.getContext("2d");
  const territoryRingContainer = document.getElementById(
    "territory-ring-container",
  );

  // Ring is hidden via CSS (visibility: hidden) — keep display: block so canvas has dimensions
  // Ring visibility is controlled by ringAnimState.opacity (drawn into post-processing chain)

  // Animation state for smooth transitions between clusters
  const ringAnimState = {
    current: { rust: 0, cobalt: 0, viridian: 0, capacity: 100 },
    stepped: { rust: 0, cobalt: 0, viridian: 0 }, // Whole-tic targets (advanced 1/sec with flash/pulse/crypto)
    target: { rust: 0, cobalt: 0, viridian: 0, capacity: 100 },
    tankCounts: { rust: 0, cobalt: 0, viridian: 0 }, // Tank presence in current cluster
    lastClusterId: null,
    animationSpeed: 12.0, // Higher = faster transition — completes in ~250ms for clear 1/sec stepping
    isContested: false, // Whether cluster is currently contested
    tickFlash: { rust: 0, cobalt: 0, viridian: 0 }, // Per-faction flash intensity (1 = bright, decays to 0)
    opacity: 0, // Current ring opacity (0 = hidden, 1 = visible)
    targetOpacity: 0, // Target opacity to animate toward
    fadeSpeed: 10.0, // Opacity units per second — matches Tusk panel's 0.3s animation
    // Dirty tracking to skip redundant canvas redraws
    isDirty: true,
    lastDrawn: {
      rust: -1,
      cobalt: -1,
      viridian: -1,
      capacity: -1,
      opacity: -1,
      isContested: false,
    },
  };

  // Set canvas resolution for crisp rendering
  function resizeTerritoryRing() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    territoryRingCanvas.width = w * dpr;
    territoryRingCanvas.height = h * dpr;
    // Reset transform before scaling (prevents compound scaling)
    territoryRingCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ringAnimState.isDirty = true;
  }
  window.addEventListener("resize", resizeTerritoryRing);
  resizeTerritoryRing(); // Initial sizing

  // Show/hide territory ring based on deployment state (uses fade animation)
  // Respects uiVisible — ring stays hidden when HUD is toggled off with H
  function setTerritoryRingVisible(visible) {
    ringAnimState.targetOpacity =
      visible && uiVisible && !tank.isDead ? 1.0 : 0;
    ringAnimState.isDirty = true;
  }

  // Update ring animation (call each frame)
  function updateRingAnimation(deltaTime) {
    const speed = ringAnimState.animationSpeed * deltaTime;
    let valueChanged = false;

    // Ease current toward stepped (stepped advances 1/sec in sync with flash/crypto/shockwave)
    for (const faction of ["rust", "cobalt", "viridian"]) {
      const diff = ringAnimState.stepped[faction] - ringAnimState.current[faction];
      if (Math.abs(diff) > 0.01) {
        ringAnimState.current[faction] += diff * Math.min(speed, 1);
        valueChanged = true;
      } else if (ringAnimState.current[faction] !== ringAnimState.stepped[faction]) {
        ringAnimState.current[faction] = ringAnimState.stepped[faction];
        valueChanged = true;
      }
    }

    // Also animate capacity changes
    const capDiff =
      ringAnimState.target.capacity - ringAnimState.current.capacity;
    if (Math.abs(capDiff) > 0.1) {
      ringAnimState.current.capacity += capDiff * Math.min(speed, 1);
      valueChanged = true;
    } else {
      ringAnimState.current.capacity = ringAnimState.target.capacity;
    }


    // Decay tick flash intensities
    for (const faction of ["rust", "cobalt", "viridian"]) {
      if (ringAnimState.tickFlash[faction] > 0.01) {
        ringAnimState.tickFlash[faction] *= Math.pow(0.01, deltaTime); // Soft decay over ~1s for clean 1/s pulse
        valueChanged = true;
      } else {
        ringAnimState.tickFlash[faction] = 0;
      }
    }

    // Animate opacity for fade in/out
    const opacityDiff = ringAnimState.targetOpacity - ringAnimState.opacity;
    if (Math.abs(opacityDiff) > 0.01) {
      ringAnimState.opacity +=
        opacityDiff * Math.min(ringAnimState.fadeSpeed * deltaTime, 1);
      valueChanged = true;
    } else {
      ringAnimState.opacity = ringAnimState.targetOpacity;
    }

    // Mark dirty if any visual value changed
    if (valueChanged) {
      ringAnimState.isDirty = true;
    }
  }

  // Trigger a ring flash for factions with active tic growth.
  // In single-player this is called from updateCapture (1/sec).
  // In multiplayer this is called from onTicCrypto (1/sec, synced with pulse + crypto + shockwave).
  function triggerTickFlash() {
    if (ringAnimState.lastClusterId == null) return;
    const state = planet.clusterCaptureState.get(ringAnimState.lastClusterId);
    if (!state) return;
    for (const faction of ["rust", "cobalt", "viridian"]) {
      const newStepped = Math.floor(state.tics[faction]);
      if (newStepped > ringAnimState.stepped[faction]) {
        ringAnimState.stepped[faction] = newStepped;
        ringAnimState.tickFlash[faction] = 1;
        ringAnimState.isDirty = true;
      } else if (newStepped < ringAnimState.stepped[faction]) {
        ringAnimState.stepped[faction] = newStepped;
        ringAnimState.isDirty = true;
      }
    }
  }

  // Set new target values (called when cluster data updates)
  function setRingTargets(state, clusterId) {
    // In single-player, trigger flash + advance stepped targets here (runs 1/sec from updateCapture).
    // In multiplayer, flash + stepped are triggered by onTicCrypto for 1/sec sync with pulse + shockwave.
    if (!isMultiplayer && clusterId === ringAnimState.lastClusterId) {
      for (const faction of ["rust", "cobalt", "viridian"]) {
        const newStepped = Math.floor(state.tics[faction]);
        if (newStepped > ringAnimState.stepped[faction]) {
          ringAnimState.stepped[faction] = newStepped;
          ringAnimState.tickFlash[faction] = 1;
          ringAnimState.isDirty = true;
        } else if (newStepped < ringAnimState.stepped[faction]) {
          ringAnimState.stepped[faction] = newStepped;
          ringAnimState.isDirty = true;
        }
      }
    }

    ringAnimState.target.rust = state.tics.rust;
    ringAnimState.target.cobalt = state.tics.cobalt;
    ringAnimState.target.viridian = state.tics.viridian;
    ringAnimState.target.capacity = state.capacity;

    // Snap current + stepped values when entering a new cluster (avoids slow animation from stale defaults)
    if (clusterId !== ringAnimState.lastClusterId) {
      ringAnimState.stepped.rust = Math.floor(state.tics.rust);
      ringAnimState.stepped.cobalt = Math.floor(state.tics.cobalt);
      ringAnimState.stepped.viridian = Math.floor(state.tics.viridian);
      ringAnimState.current.rust = ringAnimState.stepped.rust;
      ringAnimState.current.cobalt = ringAnimState.stepped.cobalt;
      ringAnimState.current.viridian = ringAnimState.stepped.viridian;
      ringAnimState.current.capacity = state.capacity;
    }
    ringAnimState.lastClusterId = clusterId;
  }

  function drawTerritoryRing() {
    const canvas = territoryRingCanvas;
    const ctx = territoryRingCtx;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const size = Math.min(w, h) * 0.9; // 90% of smaller dimension (matches old 90vmin)

    // Skip redraw if nothing changed (dirty tracking optimization)
    if (!ringAnimState.isDirty) return;
    ringAnimState.isDirty = false;

    // Sync canvas changes to post-processing texture (only when actually redrawn)
    if (territoryRingOverlayTexture) territoryRingOverlayTexture.needsUpdate = true;

    // Skip drawing if fully transparent — just clear
    if (ringAnimState.opacity < 0.01) {
      ctx.clearRect(0, 0, w, h);
      return;
    }

    // Clear canvas (full viewport)
    ctx.clearRect(0, 0, w, h);

    const centerX = w / 2;
    const centerY = h / 2;
    const outerRadius = size * 0.48;
    const innerRadius = size * 0.465;
    const ringWidth = outerRadius - innerRadius;

    // Use animated current values
    const tics = ringAnimState.current;
    const capacity = ringAnimState.current.capacity;

    // Use cached faction colors from FACTION_COLORS (avoid getComputedStyle per frame)
    const colors = {
      rust: FACTION_COLORS.rust.css,
      cobalt: FACTION_COLORS.cobalt.css,
      viridian: FACTION_COLORS.viridian.css,
    };

    // Calculate angles (as percentage of capacity)
    const angles = {
      rust: (tics.rust / capacity) * Math.PI * 2 || 0,
      cobalt: (tics.cobalt / capacity) * Math.PI * 2 || 0,
      viridian: (tics.viridian / capacity) * Math.PI * 2 || 0,
    };

    // Clamp: never exceed 100%, and close gap when territory is at capacity.
    // Math.floor() on stepped values can lose up to 2 tics total (one per faction),
    // creating a visible unclaimed sliver even though server says territory is full.
    const claimedTotal = angles.rust + angles.cobalt + angles.viridian;
    const targetTotal = ringAnimState.target.rust + ringAnimState.target.cobalt + ringAnimState.target.viridian;
    const isAtCapacity = targetTotal >= ringAnimState.target.capacity - 0.01;
    if (claimedTotal > 0 && (claimedTotal > Math.PI * 2 || isAtCapacity)) {
      const scale = (Math.PI * 2) / claimedTotal;
      angles.rust *= scale;
      angles.cobalt *= scale;
      angles.viridian *= scale;
    }
    const unclaimedAngle = Math.max(0, Math.PI * 2 - angles.rust - angles.cobalt - angles.viridian);

    // Build draw order: Player → Other1 → Unclaimed → Other2
    // This puts player at top, unclaimed at bottom, others flanking on sides
    // Use stable ordering (consistent with original array order) to prevent flickering
    const otherFactions = ["rust", "cobalt", "viridian"].filter(
      (f) => f !== playerFaction,
    );
    const drawOrder = [
      playerFaction,
      otherFactions[0],
      "__unclaimed__",
      otherFactions[1],
    ];

    // Starting angle: center player at 12 o'clock (top)
    const startAngle = -Math.PI / 2 - angles[playerFaction] / 2;
    const midRadius = (outerRadius + innerRadius) / 2;

    ctx.globalAlpha = ringAnimState.opacity;
    ctx.lineCap = "butt";

    // Draw dark outline for the ring (outer and inner edges)
    const outlineWidth = 2;
    ctx.lineWidth = outlineWidth;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";

    // Outer edge outline
    ctx.beginPath();
    ctx.arc(centerX, centerY, outerRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Inner edge outline
    ctx.beginPath();
    ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Now draw the colored ring segments
    ctx.lineWidth = ringWidth;

    // Track label positions and draw arcs
    const labelPositions = {};
    let currentAngle = startAngle;

    // Draw arcs in custom order: Player → Other1 → Unclaimed → Other2
    for (const item of drawOrder) {
      if (item === "__unclaimed__") {
        // Draw unclaimed portion (gray) at this position in the sequence
        if (unclaimedAngle > 0.01) {
          const endAngle = currentAngle + unclaimedAngle;
          ctx.beginPath();
          ctx.arc(centerX, centerY, midRadius, currentAngle, endAngle);
          ctx.strokeStyle = "rgba(100, 100, 100, 0.4)";
          ctx.stroke();
          currentAngle = endAngle;
        }
      } else {
        const faction = item;
        const arcAngle = angles[faction];
        if (arcAngle > 0.001) {
          const endAngle = currentAngle + arcAngle;
          const midAngle = currentAngle + arcAngle / 2;

          // Draw arc
          ctx.beginPath();
          ctx.arc(centerX, centerY, midRadius, currentAngle, endAngle);
          ctx.strokeStyle = colors[faction];
          ctx.stroke();

          // Draw tick flash overlay (white burst that decays)
          if (ringAnimState.tickFlash[faction] > 0.01) {
            ctx.beginPath();
            ctx.arc(centerX, centerY, midRadius, currentAngle, endAngle);
            ctx.strokeStyle = `rgba(255, 255, 255, ${ringAnimState.tickFlash[faction] * 0.7})`;
            ctx.stroke();
          }

          // Store label position
          const percentage = (tics[faction] / capacity) * 100;
          labelPositions[faction] = {
            x: centerX + Math.cos(midAngle) * midRadius,
            y: centerY + Math.sin(midAngle) * midRadius,
            percentage: percentage,
          };

          currentAngle = endAngle;
        }
      }
    }

    // Draw tank presence dots
    const tankCounts = ringAnimState.tankCounts;
    const dotRingRadius = innerRadius - 14; // Distance from ring
    currentAngle = startAngle;

    // Save context once for all tank dots — share ring opacity
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = ringAnimState.opacity;

    for (const item of drawOrder) {
      if (item === "__unclaimed__") {
        // Skip unclaimed angle for dots positioning
        currentAngle += unclaimedAngle;
      } else {
        const faction = item;
        const count = tankCounts[faction];
        const arcAngle = angles[faction];

        if (count > 0 && arcAngle > 0.001) {
          const arcMidAngle = currentAngle + arcAngle / 2;
          const dotSpacing = 18;

          for (let i = 0; i < count; i++) {
            const dotOffset = (i - (count - 1) / 2) * dotSpacing;
            const angularOffset = dotOffset / dotRingRadius;
            const dotAngle = arcMidAngle + angularOffset;

            const dotX = centerX + Math.cos(dotAngle) * dotRingRadius;
            const dotY = centerY + Math.sin(dotAngle) * dotRingRadius;

            // Dark outline
            ctx.beginPath();
            ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
            ctx.fillStyle = "#000000";
            ctx.fill();
            // Faction-colored fill
            ctx.beginPath();
            ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
            ctx.fillStyle = colors[faction];
            ctx.fill();

          }
        }

        currentAngle += arcAngle;
      }
    }

    // Restore alpha after all dots
    ctx.globalAlpha = prevAlpha;

    // Draw ownership percentages on top of the ring (always show)
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = '16px "Atari ST 8x16", monospace';

    for (const faction of ["rust", "cobalt", "viridian"]) {
      const pos = labelPositions[faction];
      if (pos && pos.percentage > 0) {
        const label = pos.percentage.toFixed(1) + "%";
        // Draw directly on the ring midpoint
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#000000";
        ctx.strokeText(label, pos.x, pos.y);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, pos.x, pos.y);
      }
    }
    ctx.restore();

    ctx.globalAlpha = 1.0;
  }

  function updateTugOfWarUI(clusterId, state, counts) {
    const totalTics = state.tics.rust + state.tics.cobalt + state.tics.viridian;

    // Set animation targets (ring will animate toward these values)
    setRingTargets(state, clusterId);

    // Update sidebar cluster info
    clusterInfoEl.textContent = `Cluster #${clusterId} (${planet.clusterData[clusterId].tiles.length} hexes) - ${Math.round(totalTics)}/${state.capacity} tics`;

    // Update momentum indicators
    for (const faction of _captureFactions) {
      const momentumEl = document.getElementById(`momentum-${faction}`);
      const m = state.momentum[faction];
      const mRounded = Math.round(m * 10) / 10; // Round to 1 decimal
      momentumEl.textContent =
        mRounded > 0 ? `+${mRounded}/s` : mRounded < 0 ? `${mRounded}/s` : "—";
      momentumEl.className =
        `momentum ${faction}` +
        (mRounded > 0 ? " positive" : mRounded < 0 ? " negative" : "");
    }

    // Update tank counts (sidebar and ring animation state)
    document.getElementById("tanks-rust").textContent = counts.rust;
    document.getElementById("tanks-cobalt").textContent = counts.cobalt;
    document.getElementById("tanks-viridian").textContent = counts.viridian;
    ringAnimState.tankCounts.rust = counts.rust;
    ringAnimState.tankCounts.cobalt = counts.cobalt;
    ringAnimState.tankCounts.viridian = counts.viridian;

    // Update status badges
    const ownerBadge = document.getElementById("owner-badge");
    const contestedBadge = document.getElementById("contested-badge");
    const progressInfo = document.getElementById("progress-info");

    let factionsWithTanksCount = 0;
    for (const f of _captureFactions) {
      if (counts[f] > 0) factionsWithTanksCount++;
    }
    const isContested = factionsWithTanksCount > 1;

    // Update ring animation state for contested pulse overlay
    ringAnimState.isContested = isContested;

    if (state.owner) {
      ownerBadge.classList.remove("hidden");
      ownerBadge.className = `owner-badge ${state.owner}`;
      ownerBadge.textContent = `${state.owner.toUpperCase()} TERRITORY`;
      contestedBadge.classList.toggle("hidden", !isContested);
      progressInfo.classList.add("hidden");
    } else {
      ownerBadge.classList.add("hidden");
      if (isContested) {
        contestedBadge.classList.remove("hidden");
        progressInfo.classList.add("hidden");
      } else {
        contestedBadge.classList.add("hidden");
        let activeFactionCount = 0;
        let leader = null;
        for (const f of _captureFactions) {
          if (state.tics[f] > 0) {
            activeFactionCount++;
            if (!leader || state.tics[f] > state.tics[leader]) leader = f;
          }
        }
        if (activeFactionCount >= 1) {
          progressInfo.classList.remove("hidden");
          const fillProgress = ((totalTics / state.capacity) * 100).toFixed(0);
          progressInfo.innerHTML = `<span style="color:${factionColorMap[leader]}">${leader.toUpperCase()}</span> capturing: ${fillProgress}%`;
        } else {
          progressInfo.textContent = "Unclaimed";
          progressInfo.classList.remove("hidden");
        }
      }
    }

    // Near-flip warning
    const captureStatus = document.getElementById("capture-status");
    if (state.owner) {
      const ownerTics = state.tics[state.owner];
      let nearFlip = false;
      for (const f of _captureFactions) {
        if (f !== state.owner && state.tics[f] > ownerTics * 0.9) {
          nearFlip = true;
          break;
        }
      }
      captureStatus.classList.toggle("near-flip", nearFlip);
    } else {
      captureStatus.classList.remove("near-flip");
    }
  }

  function clearTugOfWarUI() {
    // Clear ring canvas (full viewport)
    const dpr = window.devicePixelRatio || 1;
    territoryRingCtx.clearRect(
      0,
      0,
      territoryRingCanvas.width / dpr,
      territoryRingCanvas.height / dpr,
    );

    // Clear sidebar
    clusterInfoEl.textContent = "Cluster: --";
    for (const faction of ["rust", "cobalt", "viridian"]) {
      document.getElementById(`momentum-${faction}`).textContent = "—";
      document.getElementById(`tanks-${faction}`).textContent = "0";
    }
    document.getElementById("owner-badge").classList.add("hidden");
    document.getElementById("contested-badge").classList.add("hidden");
    document.getElementById("progress-info").textContent = "--";
    document.getElementById("capture-status").classList.remove("near-flip");
  }

  function triggerOwnershipFlip() {
    const statusEl = document.getElementById("capture-status");
    statusEl.classList.add("ownership-flip");
    setTimeout(() => statusEl.classList.remove("ownership-flip"), 600);
  }

  // ========================
  // SPONSOR TIMERS
  // ========================

  function updateSponsorHoldTimers() {
    const sponsorClusters = planet.getAllSponsorClusters();

    for (const [sponsorId, sponsorCluster] of sponsorClusters) {
      const state = planet.clusterCaptureState.get(sponsorCluster.clusterId);
      if (state) {
        const previousOwner = sponsorPreviousOwners.get(sponsorId) || null;
        const currentOwner = state.owner;

        planet.updateSponsorHoldTimer(sponsorId, currentOwner);
        planet.updateOccupancyHistory(
          sponsorCluster.clusterId,
          currentOwner,
          1000,
        );
        planet.updateSponsorClusterVisual(sponsorId, previousOwner);

        sponsorPreviousOwners.set(sponsorId, currentOwner);

        planet.checkSponsorRewardMilestones(sponsorId);
      }
    }
  }

  // Run capture update every second (skip in multiplayer — server handles it)
  if (!isMultiplayer) {
    setInterval(updateCapture, 1000);
  }

  // ========================
  // TERRITORY HOLDING CRYPTO (per-minute)
  // ========================

  function awardHoldingCrypto() {
    if (!cryptoSystem.enabled) return;
    if (tank.isDead) return;

    // Build set of all hexes owned by player's faction (across all clusters)
    const ownedHexes = new Set();
    planet.clusterCaptureState.forEach((state, clusterId) => {
      if (state.owner === playerFaction) {
        const cluster = planet.clusterData.find((c) => c.id === clusterId);
        if (cluster) {
          cluster.tiles.forEach((tileIdx) => ownedHexes.add(tileIdx));
        }
      }
    });

    if (ownedHexes.size === 0) return;

    // Calculate crypto per hex based on adjacent friendly hexes
    // Formula: 1 × 1.05^neighbors (exponential growth)
    let totalCrypto = 0;
    const hexData = [];

    for (const tileIdx of ownedHexes) {
      const neighbors = planet._adjacencyMap.get(tileIdx) || [];
      const friendlyNeighbors = neighbors.filter((n) =>
        ownedHexes.has(n),
      ).length;

      // Exponential adjacency bonus: 1 × 1.05^neighbors
      const hexCrypto =
        1 * Math.pow(cryptoSystem.cryptoValues.holdingExponent, friendlyNeighbors);
      totalCrypto += hexCrypto;

      const tileCenter = planet.tileCenters[tileIdx];
      if (tileCenter) {
        const surfacePos = tileCenter.position
          .clone()
          .normalize()
          .multiplyScalar(planet.radius);
        planet.hexGroup.localToWorld(surfacePos);
        hexData.push({ pos: surfacePos, crypto: hexCrypto });
      }
    }

    if (totalCrypto > 0) {
      const playerWorldPos = new THREE.Vector3();
      tank.group.getWorldPosition(playerWorldPos);
      cryptoSystem.awardHoldingCrypto(totalCrypto, playerWorldPos, hexData);
    }
  }

  // Schedule holding crypto at top of each minute
  function scheduleHoldingCryptoTimer() {
    const now = new Date();
    const msUntilNextMinute =
      (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

    setTimeout(() => {
      awardHoldingCrypto();
      setInterval(awardHoldingCrypto, 60000);
    }, msUntilNextMinute);
  }

  // In multiplayer, server handles holding crypto (server-authoritative)
  if (!isMultiplayer) {
    scheduleHoldingCryptoTimer();
  }

  // ========================
  // FAST TRAVEL CONTROLS
  // ========================

  window.addEventListener("keydown", (e) => {
    if (window._authScreenInstance?.isVisible || window._modalOpen) return;
    const _tag = document.activeElement?.tagName;
    if (_tag === "INPUT" || _tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
    if (e.key === "e" || e.key === "E") {
      const portalIndex = fastTravel.checkPortalEntry();
      const isOrbitalView = gameCamera.mode === "orbital";
      if (portalIndex !== null && !fastTravel.active && !isOrbitalView) {
        cryptoSystem.enabled = false; // Disable crypto during fast travel
        setTerritoryRingVisible(false); // Fade out ring when entering fast travel
        fastTravel.enterFastTravel(portalIndex);
      }
    }
  });

  document.getElementById("abort-travel-btn").addEventListener("click", () => {
    fastTravel.onAbortClick();
  });
  document.getElementById("travel-btn").addEventListener("click", () => {
    fastTravel.onTravelClick();
  });
  document.getElementById("go-back-btn").addEventListener("click", () => {
    fastTravel.onGoBackClick();
  });

  // ========================
  // TERRITORY INTEL POPUP
  // ========================

  const intelPopup = document.getElementById("territory-intel-popup");
  const intelRaycaster = new THREE.Raycaster();
  const intelMouse = new THREE.Vector2();

  function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  function formatTimeAgo(isoString) {
    if (!isoString) return "Unknown";
    const date = new Date(isoString);
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  }

  // Format seconds as compact time string for Y-axis labels
  function formatSecondsCompact(seconds) {
    if (seconds >= 3600) {
      return Math.round(seconds / 3600) + "h";
    } else if (seconds >= 60) {
      return Math.round(seconds / 60) + "m";
    }
    return seconds + "s";
  }

  // Format seconds for legend display
  function formatSecondsLegend(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    }
    return `${secs}s`;
  }

  function renderFactionPresenceGraph(sponsorId) {
    const canvas = document.getElementById("intel-line-graph");
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const padding = { top: 12, right: 8, bottom: 16, left: 32 };

    ctx.clearRect(0, 0, w, h);

    // Get rolling per-interval activity rates (deltas between consecutive samples)
    let data = [];
    if (typeof PresenceTracker !== "undefined" && sponsorId) {
      data = PresenceTracker.getRollingRates(sponsorId);
    }

    const colors = {
      rust: FACTION_COLORS.rust.css,
      cobalt: FACTION_COLORS.cobalt.css,
      viridian: FACTION_COLORS.viridian.css,
    };

    // If no data, show message
    if (!data || data.length === 0) {
      ctx.fillStyle = "#666";
      ctx.font = '12px "Ark Pixel 12px"';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Collecting data...", w / 2, h / 2);
      return { rust: 0, cobalt: 0, viridian: 0 };
    }

    const chartWidth = w - padding.left - padding.right;
    const chartHeight = h - padding.top - padding.bottom;

    // Find max value for scaling (per-interval seconds, max possible is 30)
    let maxValue = 0;
    data.forEach((d) => {
      maxValue = Math.max(maxValue, d.rust, d.cobalt, d.viridian);
    });
    maxValue = Math.max(maxValue, 5); // Minimum scale of 5s to avoid erratic visuals

    // Draw subtle grid lines
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartHeight / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
    }

    // Draw Y-axis labels (rate in seconds per interval)
    ctx.fillStyle = "#666666";
    ctx.font = '12px "Ark Pixel 12px"';
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const value = Math.round((maxValue * (4 - i)) / 4);
      const y = padding.top + (chartHeight / 4) * i;
      ctx.fillText(value + "s", padding.left - 4, y);
    }

    // Draw lines for each faction
    const factions = ["rust", "cobalt", "viridian"];

    factions.forEach((faction) => {
      ctx.strokeStyle = colors[faction];
      ctx.lineWidth = 2;
      ctx.beginPath();

      data.forEach((d, i) => {
        const x =
          padding.left + (i / Math.max(data.length - 1, 1)) * chartWidth;
        const y =
          padding.top + chartHeight - (d[faction] / maxValue) * chartHeight;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();

      // Draw data points as small squares (pixelated look)
      ctx.fillStyle = colors[faction];
      data.forEach((d, i) => {
        const x =
          padding.left + (i / Math.max(data.length - 1, 1)) * chartWidth;
        const y =
          padding.top + chartHeight - (d[faction] / maxValue) * chartHeight;
        ctx.fillRect(x - 2, y - 2, 4, 4);
      });
    });

    // Draw X-axis label
    ctx.fillStyle = "#666666";
    ctx.font = '12px "Ark Pixel 12px"';
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("Last 30 min \u2192", w / 2, h - 12);

    // Return cumulative totals for legend (long-term data preserved in text)
    return PresenceTracker.getTotals(sponsorId);
  }

  function renderGraphLegend(totals) {
    const legend = document.getElementById("intel-graph-legend");
    const factions = [
      { key: "rust", label: "Rust", color: FACTION_COLORS.rust.css },
      { key: "cobalt", label: "Cobalt", color: FACTION_COLORS.cobalt.css },
      {
        key: "viridian",
        label: "Viridian",
        color: FACTION_COLORS.viridian.css,
      },
    ];

    legend.innerHTML = factions
      .filter((f) => totals[f.key] > 0)
      .map(
        (f) => `
                <span class="graph-legend-item">
                    <span class="graph-legend-color" style="background: ${f.color}"></span>
                    <span style="color: ${f.color}">${formatSecondsLegend(totals[f.key])}</span>
                </span>
            `,
      )
      .join("");
  }

  function renderRewardsList(rewards) {
    const list = document.getElementById("intel-rewards-list");

    if (!rewards || rewards.length === 0) {
      list.innerHTML =
        '<li><span class="reward-challenge" style="color: #666;">No challenges configured</span></li>';
      return;
    }

    list.innerHTML = rewards
      .map((reward) => {
        const challenge =
          ACCOMPLISHMENT_LABELS[reward.accomplishment] || reward.accomplishment;
        let valueText = "";
        let valueClass = reward.rewardType;

        switch (reward.rewardType) {
          case "crypto":
            valueText = `+¢${reward.rewardValue}`;
            break;
          case "cosmetic":
            valueText = reward.rewardDetails?.cosmeticId || "Cosmetic";
            break;
          case "coupon":
            valueText = reward.rewardDetails?.description || "Coupon";
            break;
          default:
            valueText = "Reward";
        }

        return `
                <li>
                    <span class="reward-challenge">${challenge}</span>
                    <span class="reward-value ${valueClass}">${valueText}</span>
                </li>
            `;
      })
      .join("");
  }

  function positionIntelPopup(clickX, clickY) {
    const margin = 15;
    const vpWidth = window.innerWidth;
    const vpHeight = window.innerHeight;

    intelPopup.style.visibility = "hidden";
    intelPopup.classList.remove("hidden");
    const popupRect = intelPopup.getBoundingClientRect();

    let left = clickX + margin;
    let top = clickY + margin;

    if (left + popupRect.width > vpWidth - margin) {
      left = clickX - popupRect.width - margin;
    }

    if (top + popupRect.height > vpHeight - margin) {
      top = clickY - popupRect.height - margin;
    }

    left = Math.max(margin, left);
    top = Math.max(margin, top);

    intelPopup.style.left = left + "px";
    intelPopup.style.top = top + "px";
    intelPopup.style.visibility = "visible";
  }

  function resetIntelPopupState() {
    // Restore all sections and stat rows to default visible state
    const statsEl = document.querySelector("#territory-intel-popup .intel-stats");
    if (statsEl) statsEl.classList.remove("hidden");
    document.querySelectorAll("#territory-intel-popup .intel-section")
      .forEach((el) => el.classList.remove("hidden"));
    document.querySelectorAll("#territory-intel-popup .stat-row")
      .forEach((el) => el.classList.remove("hidden"));
  }

  function showTerritoryIntelPopup(clickX, clickY, sponsor, clusterId) {
    resetIntelPopupState();
    const logoEl = document.getElementById("intel-logo");
    if (sponsor.logoImage) {
      logoEl.src = sponsor.logoImage;
      logoEl.classList.remove("hidden");
    } else {
      logoEl.classList.add("hidden");
    }

    document.getElementById("intel-name").textContent =
      sponsor.name || "Unknown Sponsor";
    document.getElementById("intel-tagline").textContent =
      sponsor.tagline || "";

    const urlSection = document.getElementById("intel-url-section");
    const urlEl = document.getElementById("intel-url");
    if (sponsor.websiteUrl) {
      urlEl.href = sponsor.websiteUrl;
      urlEl.textContent = sponsor.websiteUrl.replace(/^https?:\/\//, "");
      urlSection.classList.remove("hidden");
    } else {
      urlSection.classList.add("hidden");
    }

    const cluster = planet.clusterData[clusterId];
    document.getElementById("intel-hex-count").textContent =
      `${cluster?.tiles?.length || 0} hexes`;

    const state = planet.clusterCaptureState.get(clusterId);
    const owner = state?.owner || null;
    const ownerEl = document.getElementById("intel-faction");
    if (owner) {
      ownerEl.textContent = owner.charAt(0).toUpperCase() + owner.slice(1);
      ownerEl.className = "stat-value " + owner;
    } else {
      ownerEl.textContent = "Unclaimed";
      ownerEl.className = "stat-value unclaimed";
    }

    const holdStatus = planet.getSponsorHoldStatus(sponsor.id);
    const durationEl = document.getElementById("intel-duration");
    if (holdStatus.owner && holdStatus.holdDuration > 0) {
      durationEl.textContent = formatDuration(holdStatus.holdDuration);
    } else {
      durationEl.textContent = "--";
    }

    document.getElementById("intel-joined").textContent = formatTimeAgo(
      sponsor.createdAt,
    );

    const pcts = renderFactionPresenceGraph(sponsor.id);
    renderGraphLegend(pcts);

    renderRewardsList(sponsor.rewards);

    positionIntelPopup(clickX, clickY);
  }

  function showSpaceSponsorPopup(clickX, clickY, sponsor, type) {
    resetIntelPopupState();
    const logoEl = document.getElementById("intel-logo");
    if (sponsor.logoImage) {
      logoEl.src = sponsor.logoImage;
      logoEl.classList.remove("hidden");
    } else {
      logoEl.classList.add("hidden");
    }

    document.getElementById("intel-name").textContent =
      sponsor.name || "Unknown Sponsor";
    document.getElementById("intel-tagline").textContent =
      sponsor.tagline || type;

    const urlSection = document.getElementById("intel-url-section");
    const urlEl = document.getElementById("intel-url");
    if (sponsor.websiteUrl) {
      urlEl.href = sponsor.websiteUrl;
      urlEl.textContent = sponsor.websiteUrl.replace(/^https?:\/\//, "");
      urlSection.classList.remove("hidden");
    } else {
      urlSection.classList.add("hidden");
    }

    // Show joined date (hide row if createdAt unavailable)
    const joinedRow = document.getElementById("intel-joined").closest(".stat-row");
    if (sponsor.createdAt) {
      document.getElementById("intel-joined").textContent = formatTimeAgo(
        sponsor.createdAt,
      );
      joinedRow.classList.remove("hidden");
    } else {
      joinedRow.classList.add("hidden");
    }

    // Hide cluster-specific stat rows
    document.getElementById("intel-hex-count").closest(".stat-row").classList.add("hidden");
    document.getElementById("intel-faction").closest(".stat-row").classList.add("hidden");
    document.getElementById("intel-duration").closest(".stat-row").classList.add("hidden");

    // Hide activity and rewards sections
    const sectionEls = document.querySelectorAll("#territory-intel-popup .intel-section");
    sectionEls.forEach((el) => {
      if (el.querySelector("h4")) el.classList.add("hidden");
    });

    positionIntelPopup(clickX, clickY);
  }

  function hideTerritoryIntelPopup() {
    intelPopup.classList.add("hidden");
    resetIntelPopupState();
  }

  // Right-click detection for sponsor clusters
  // Track right-click start position to distinguish click from drag
  let rightClickStart = null;

  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (window._authScreenInstance?.isVisible) return;
    // On Mac, contextmenu fires on mousedown. Store position for mouseup check.
    rightClickStart = { x: e.clientX, y: e.clientY };
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button !== 2) return; // Only right-click
    if (window._authScreenInstance?.isVisible) { rightClickStart = null; return; }
    if (!rightClickStart) return;

    const dx = Math.abs(e.clientX - rightClickStart.x);
    const dy = Math.abs(e.clientY - rightClickStart.y);
    const wasDrag = dx > 5 || dy > 5;

    // Clear the start position
    const clickX = rightClickStart.x;
    const clickY = rightClickStart.y;
    rightClickStart = null;

    // If it was a drag, don't show the popup
    if (wasDrag) {
      return;
    }

    // Block if camera is still considered orbiting
    if (gameCamera?.wasRightClickDragging?.()) {
      return;
    }

    intelMouse.x = (clickX / window.innerWidth) * 2 - 1;
    intelMouse.y = -(clickY / window.innerHeight) * 2 + 1;

    intelRaycaster.setFromCamera(intelMouse, camera);

    // Check billboards and moons FIRST so they block clicks to the planet surface

    // Check sponsored billboards (raycast into billboard groups recursively)
    const bbMeshes = environment.billboards.flatMap((bb) => bb.children);
    const bbHits = intelRaycaster.intersectObjects(bbMeshes);
    if (bbHits.length > 0) {
      const bbGroup = bbHits[0].object.parent;
      const sponsor = bbGroup?.userData?.sponsor;
      if (sponsor) {
        showSpaceSponsorPopup(clickX, clickY, sponsor, "Billboard");
      }
      return; // Block click from reaching planet surface
    }

    // Check sponsored moons (screen-space projection for reliable hit detection)
    let hitMoon = null;
    const _moonProj = new THREE.Vector3();
    for (const moon of environment.moons) {
      if (!moon.visible) continue;
      _moonProj.copy(moon.position).project(camera);
      if (_moonProj.z > 1) continue; // behind camera
      const sx = (_moonProj.x + 1) / 2 * window.innerWidth;
      const sy = (-_moonProj.y + 1) / 2 * window.innerHeight;
      const r = moon.geometry.parameters.radius;
      const d = camera.position.distanceTo(moon.position);
      const projR = (r / d) * window.innerHeight / (2 * Math.tan(camera.fov * Math.PI / 360));
      if (Math.hypot(clickX - sx, clickY - sy) <= projR) {
        hitMoon = moon;
        break;
      }
    }
    if (hitMoon) {
      const sponsor = hitMoon.userData?.sponsor;
      if (sponsor) {
        showSpaceSponsorPopup(clickX, clickY, sponsor, "Moon");
      }
      return; // Block click from reaching planet surface
    }

    // Check hex tiles on planet surface
    const intersects = intelRaycaster.intersectObjects(
      planet.hexGroup.children,
    );

    // Find first hex tile hit (filter out explosions, decals, etc.)
    // Supports both individual tile meshes (userData.tileIndex) and merged cluster meshes (userData.isMergedCluster)
    const hexHit = intersects.find(
      (hit) => hit.object.userData?.tileIndex !== undefined || hit.object.userData?.isMergedCluster,
    );

    if (hexHit) {
      const mesh = hexHit.object;
      const clusterId = mesh.userData?.clusterId;

      if (clusterId !== undefined) {
        const sponsor = planet.getSponsorForCluster(clusterId);

        if (sponsor) {
          showTerritoryIntelPopup(clickX, clickY, sponsor, clusterId);
          return;
        }
      }
    }

    hideTerritoryIntelPopup();
  });

  document.getElementById("intel-close-btn").addEventListener("click", () => {
    hideTerritoryIntelPopup();
  });

  document.addEventListener("click", (e) => {
    if (
      !intelPopup.classList.contains("hidden") &&
      !intelPopup.contains(e.target)
    ) {
      hideTerritoryIntelPopup();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !intelPopup.classList.contains("hidden")) {
      hideTerritoryIntelPopup();
    }
  });

  // ========================
  // UI TOGGLE (H KEY)
  // ========================

  const uiElements = [
    document.getElementById("left-panel-stack"),
    document.getElementById("chat-window"),
    document.getElementById("territory-intel-popup"),
    document.getElementById("territory-ring-container"),
    document.querySelector("#player-tags-container"),
    document.getElementById("crypto-hud-bar"),
    document.getElementById("dashboard-container"),
  ];

  const chatWindowEl = document.getElementById("chat-window");

  // Load HUD visibility state from dashboard (single source of truth)
  function getHUDVisibility() {
    try {
      const saved = localStorage.getItem("adlands_dashboard_state");
      if (saved) {
        const data = JSON.parse(saved);
        return data.visible !== false;
      }
    } catch (e) {
      console.warn("[HUD] Failed to load visibility:", e);
    }
    return true; // Default: HUD is visible
  }

  // Initialize HUD visibility on page load
  const hudIsVisible = getHUDVisibility();

  // Apply initial state to chat (make it match dashboard)
  if (chatWindowEl && !hudIsVisible) {
    chatWindowEl.classList.add("collapsed");
  }

  // Initialize uiVisible to match the HUD state
  let uiVisible = hudIsVisible;
  visualEffects.hudVisible = hudIsVisible;
  proximityChat.hudVisible = hudIsVisible;
  commanderTipSystem.hudVisible = hudIsVisible;
  if (!hudIsVisible) tuskCommentary.setSuppressed(true);

  document.addEventListener("keydown", (e) => {
    if (window._authScreenInstance?.isVisible) return;
    // Ignore H key when typing in chat input
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
      return;
    }
    if (e.key === "h" || e.key === "H") {
      // Toggle everything together - single source of truth
      uiVisible = !uiVisible;

      // Toggle dashboard visibility (this saves state to localStorage)
      if (dashboard) {
        if (uiVisible) {
          dashboard.show();
        } else {
          dashboard.hide();
        }
      }

      // Toggle chat window to match
      if (chatWindowEl) {
        chatWindowEl.classList.toggle("collapsed", !uiVisible);
      }

      // Toggle other UI elements
      const display = uiVisible ? "" : "none";
      uiElements.forEach((el) => {
        if (
          el &&
          el.id !== "dashboard-container" &&
          el.id !== "chat-window" &&
          el.id !== "territory-ring-container"
        ) {
          el.style.display = display;
        }
      });

      // Pause HUD CSS animations when hidden (saves compositing work)
      document.documentElement.style.setProperty(
        "--hud-anim-state",
        uiVisible ? "running" : "paused",
      );

      // Territory ring — toggle via opacity (rendered in post-processing chain)
      if (!uiVisible) {
        ringAnimState.targetOpacity = 0;
        ringAnimState.isDirty = true;
      } else {
        // Restore ring if it should be visible (only when deployed on surface)
        setTerritoryRingVisible(ringAnimState.lastClusterId !== null);
      }

      // Also toggle player tags container if it exists
      if (playerTags && playerTags.container) {
        playerTags.container.style.display = display;
      }

      // Sync HUD state so death sequence, chat bubbles, and tip panel respect it
      visualEffects.hudVisible = uiVisible;
      proximityChat.hudVisible = uiVisible;
      commanderTipSystem.hudVisible = uiVisible;

      // Toggle commander tip budget panel — fade via opacity to match Tusk panel
      const tipPanel = document.getElementById("commander-tip-panel");
      if (tipPanel) {
        tipPanel.style.opacity = uiVisible ? "" : "0";
        tipPanel.style.pointerEvents = uiVisible ? "" : "none";
      }

      // Toggle Tusk commentary panel
      tuskCommentary.setSuppressed(!uiVisible);
    }
  });

  // ========================
  // DEBUG: SELF-DAMAGE (K KEY)
  // ========================

  document.addEventListener("keydown", (e) => {
    if (window._authScreenInstance?.isVisible) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.key === "k" || e.key === "K") {
      if (!tank.isDead) {
        const amount = e.shiftKey ? tank.hp : 20;
        if (window.networkManager && window.networkManager.isMultiplayer) {
          // In multiplayer, let the server handle damage authoritatively
          window.networkManager.sendSelfDamage(amount);
        } else {
          tank.takeDamage(amount, playerFaction);
        }
      }
    }
  });

  // ========================
  // GLOBAL CONTROL OVERLAY (TAB KEY)
  // ========================

  let tabHeld = false;

  // Completely override Tab key - prevent all browser/system behavior
  // Exception: allow normal Tab navigation when focus is in a text field (e.g. territory claim/edit popups)
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab") {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (window._authScreenInstance?.isVisible) return;
        if (!tabHeld) {
          tabHeld = true;
          showGlobalControlOverlay();
        }
      }
    },
    true,
  ); // Use capture phase to intercept before other handlers

  document.addEventListener(
    "keyup",
    (e) => {
      if (e.key === "Tab") {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        tabHeld = false;
        hideGlobalControlOverlay();
      }
    },
    true,
  ); // Use capture phase to intercept before other handlers

  // ========================
  // WINDOW RESIZE
  // ========================

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    bloomCamera.aspect = window.innerWidth / window.innerHeight;
    bloomCamera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);

    const bloomWidth = Math.floor(window.innerWidth / 2);
    const bloomHeight = Math.floor(window.innerHeight / 2);
    bloomComposer.setSize(bloomWidth, bloomHeight);
    bloomPass.resolution.set(bloomWidth, bloomHeight);

    finalComposer.setSize(window.innerWidth, window.innerHeight);
    // Re-bind bloom texture after resize (render targets are recreated)
    bloomBlendPass.uniforms.bloomTexture.value =
      bloomComposer.renderTarget2.texture;
    lensDirtPass.uniforms.bloomTexture.value =
      bloomComposer.renderTarget2.texture;
    lensDirtPass.uniforms.bloomTexelSize.value.set(1.0 / bloomWidth, 1.0 / bloomHeight);
    updateDirtUvScale();
    planet.updateOutlineResolution(window.innerWidth, window.innerHeight);
  });

  // ========================
  // ANIMATION LOOP
  // ========================

  let lastFrameTime = performance.now();
  let frameCount = 0;

  // Loading screen management
  const loadingScreen = document.getElementById("loading-screen");
  const loadingContent = loadingScreen?.querySelector(".loading-content");
  const loadingBarFill = loadingScreen?.querySelector(".loading-bar-fill");
  const loadingText = loadingScreen?.querySelector(".loading-text");
  const loadingPercent = loadingScreen?.querySelector(".loading-percent");
  let loadingProgress = 0;

  // Font visibility handled via CSS (opacity: 1 by default) + font-display: swap.
  // The fonts-ready class is added by an inline script in index.html.
  let warmupFrames = 0;
  const WARMUP_FRAMES_MIN = 30; // Minimum frames before considering ready
  const WARMUP_FRAMES_MAX = 120; // Hard cap (~2s) - force-show on slow hardware
  let stableFrameCount = 0;
  const STABLE_FRAMES_NEEDED = 5; // Need 5 consecutive smooth frames
  const STABLE_FRAME_THRESHOLD = 22; // Each frame must be under 22ms (~45fps)
  let fpsLastTime = performance.now();
  const fpsCounter = document.getElementById("fps-counter");
  const pingCounter = document.getElementById("ping-counter");

  // Preallocated frustum culling objects (avoid GC pressure)
  const sharedFrustum = new THREE.Frustum();
  const sharedProjMatrix = new THREE.Matrix4();
  const moonOriginalMats = new Array(3); // Preallocated for bloom pass moon swap
  const bbChildMats = []; // Preallocated for bloom pass billboard material swap
  const ssChildMats = []; // Preallocated for bloom pass space station material swap
  const _shadowTargetTemp = new THREE.Vector3(); // Reused for orbital shadow target

  function animate() {
    requestAnimationFrame(animate);

    // Skip all updates when tab is hidden (saves GPU/CPU)
    if (document.hidden) {
      lastFrameTime = performance.now();
      return;
    }

    const now = performance.now();
    const deltaTime = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    // Update FPS counter
    frameCount++;
    if (now - fpsLastTime >= 1000) {
      const fps = Math.round((frameCount * 1000) / (now - fpsLastTime));
      fpsCounter.textContent = fps + " FPS";
      fpsCounter.style.color =
        fps >= 50 ? "#00ff00" : fps >= 30 ? "#ffd700" : "#ff0000";
      // Update ping display
      const net = window.networkManager;
      if (net && net.connected) {
        const ms = net.ping;
        pingCounter.textContent = ms + " ms";
        pingCounter.style.color =
          ms <= 80 ? "#00ff00" : ms <= 150 ? "#ffd700" : "#ff0000";
      } else {
        pingCounter.textContent = "-- ms";
        pingCounter.style.color = "#00bfff";
      }
      frameCount = 0;
      fpsLastTime = now;
      // Refresh player counts once per second to catch quiet despawns
      updatePlayerCount();
    }

    // Update day/night cycle (frame-rate independent)
    planetRotation += dayNightSpeed * deltaTime;
    planet.setRotation(planetRotation);
    // Ensure hexGroup matrixWorld is current before terrain collision checks
    // (Three.js v0.128 worldToLocal doesn't auto-update matrices)
    planet.hexGroup.updateMatrixWorld();

    // Disable tank controls in orbital view (unless fast travel is active)
    const isOrbitalView =
      gameCamera.mode === "orbital" || gameCamera.mode === "fastTravel";
    if (!fastTravel.active) {
      tank.setControlsEnabled(!isOrbitalView);
    }

    // Scale shadow frustum with camera distance so terrain shadows stay visible
    const cameraDistance = gameCamera.getEffectiveDistance();
    environment.setShadowMode(cameraDistance);

    // Update all systems
    tank.isSurfaceView = gameCamera.mode === "surface" && !gameCamera.transitioning;
    tank.update(camera, dayNightSpeed, deltaTime);
    tank.updateFade();
    environment.update(camera, deltaTime);
    environment.updateAtmosphere(gameCamera.getEffectiveDistance());
    const shadowTarget = gameCamera.mode === "surface" && !gameCamera.transitioning
      ? tank.getPosition()
      : _shadowTargetTemp.copy(camera.position).normalize().multiplyScalar(CONFIG.sphereRadius);
    environment.updateShadowCamera(shadowTarget);
    gameCamera.update(tank.getPosition(), tank.state.speed, deltaTime);

    // Update frustum for visibility culling (after camera update)
    camera.updateMatrixWorld();
    sharedProjMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    sharedFrustum.setFromProjectionMatrix(sharedProjMatrix);

    // Update terrain visibility culling (hide tiles on far side of planet + frustum cull overlays)
    planet.updateVisibility(camera, sharedFrustum);
    planet.updateVolumetricLights(deltaTime);
    planet.updatePortalPulse(deltaTime);



    // Commander mode LOD options (colored dots instead of boxes)
    const isHumanCommander = commanderSystem.isHumanCommander();
    const lodOptions = {
      isOrbitalView,
      isHumanCommander,
      viewerFaction: playerFaction,
      commanderSystem,
    };

    // Update tank LOD after camera update so distance is current frame's position
    tank.updateLOD(camera, sharedFrustum, lodOptions);

    // Pass LOD options to botTanks for commander dot mode
    botTanks.setLODOptions(lodOptions);

    // LOD dot interaction (hover/right-click) - always active for all players
    tankLODInteraction.setActive(true);

    // Update fast travel system
    fastTravel.update(deltaTime, dayNightSpeed);

    // Check for portal proximity
    if (!fastTravel.active && !isOrbitalView) {
      const nearPortal = fastTravel.checkPortalEntry();
      if (nearPortal !== null) {
        fastTravel.showPortalPrompt();
      } else {
        fastTravel.hidePortalPrompt();
      }
    } else if (isOrbitalView) {
      fastTravel.hidePortalPrompt();
    }

    // Update bot AI (skip in multiplayer — no bots)
    if (!isMultiplayer) {
      botTanks.update(deltaTime, now, dayNightSpeed, camera);
      botTanks.updateHumanPlayerPosition("player", tank.group.position);
      botTanks.updateChat(now);
    }

    // Update cannon charging and projectiles
    cannonSystem.updateCharge(deltaTime, tank, playerFaction);
    cannonSystem.isOrbitalView = isOrbitalView; // Set for LOD explosion decisions
    cannonSystem.update(deltaTime, sharedFrustum);

    // Update visual effects
    treadTracks.update(tank, deltaTime, camera, isOrbitalView, sharedFrustum);
    tankDamageEffects.update(deltaTime, sharedFrustum, camera);
    treadDust.update(deltaTime, camera, isOrbitalView, sharedFrustum);
    dustShockwave.update(deltaTime, sharedFrustum);
    capturePulse.update(deltaTime, sharedFrustum, camera);
    tankCollision.update(deltaTime, sharedFrustum, camera);
    tankHeadlights.update(deltaTime, camera);
    cryptoVisuals.update(deltaTime);

    // Update visual effects (post-processing state)
    visualEffects.update(deltaTime);

    // Update territory overlay animations
    planet.updateOverlayAnimations();
    planet.updateCapturePulseDecays(deltaTime);

    // Update territory ring animation (smooth transitions between clusters)
    updateRingAnimation(deltaTime);
    drawTerritoryRing();

    // Update player tags (skip when HUD hidden)
    if (uiVisible) {
      playerTags.update();
    }
    // Proximity chat always updates — hides its own containers when HUD is off
    proximityChat.update();

    // Update title system (session time + periodic title recalculation)
    titleSystem.updateSessionTime(deltaTime);
    if (frameCount === 0) {
      // Recalculate title once per second (when FPS counter resets)
      titleSystem.updateTitle();
      // Self-correcting title sync — mirrors dashboard's self-healing approach
      const isCmd = window.commanderSystem?.isHumanCommander?.() || false;
      const tag = playerTags.tags?.get("player");
      if (tag) {
        const hasClass = tag.element.classList.contains("commander");
        if (isCmd && !hasClass) {
          const isActing = window.commanderSystem?.isHumanActingCommander?.() || false;
          playerTags.setCommander("player", true, null, isActing);
        } else if (!isCmd && hasClass) {
          playerTags.setCommander("player", false);
        } else if (!isCmd) {
          playerTags.updateTitle("player", titleSystem.getTitle());
        }
      }
    }

    // Update commander system (rankings, bodyguards, drawing, tips)
    commanderSystem.update(now);

    // Update commander drawing (only in orbital view when commander)
    commanderDrawing.setEnabled(
      isOrbitalView && commanderSystem.isHumanCommander(),
    );
    commanderDrawing.update(deltaTime);

    // Multiplayer: update remote tanks (interpolation + LOD) and send input
    if (window._mp && window._mp.onFrameUpdate) {
      window._mp.onFrameUpdate(deltaTime, camera, sharedFrustum, lodOptions);
    }

    // Update ping markers (3D markers in orbital view, arrows always visible)
    pingMarkerSystem.setMarkersVisible(
      isOrbitalView || gameCamera.mode === "fastTravel",
    );
    pingMarkerSystem.update(
      deltaTime,
      playerFaction,
      proximityChat.playerSquad,
    );

    // Render scene with selective bloom (layer-based)
    // Ensure matrices are updated before rendering to prevent bloom flickering
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    bloomCamera.position.copy(camera.position);
    bloomCamera.quaternion.copy(camera.quaternion);
    bloomCamera.updateMatrixWorld();

    // Enable occlusion for sun in bloom pass (planet sphere + moons + billboards)
    // Planet sphere already has occlusion material, just enable layer
    occlusionSphereMesh.layers.enable(BLOOM_LAYER);

    // Moons need temporary material swap + layer enable
    for (let i = 0; i < environment.moons.length; i++) {
      moonOriginalMats[i] = environment.moons[i].material;
      environment.moons[i].material = bloomOcclusionMaterial;
      environment.moons[i].layers.enable(BLOOM_LAYER);
    }

    // Billboards: swap child mesh materials + enable bloom layer
    let bbMatIdx = 0;
    for (let i = 0; i < environment.billboards.length; i++) {
      const bb = environment.billboards[i];
      if (!bb.visible) continue;
      bb.traverse((child) => {
        if (!child.isMesh) return;
        bbChildMats[bbMatIdx++] = { mesh: child, mat: child.material, layer: child.layers.mask };
        child.material = bloomOcclusionMaterial;
        child.layers.enable(BLOOM_LAYER);
      });
    }

    // Space stations: swap child mesh materials + enable bloom layer
    let ssMatIdx = 0;
    for (let i = 0; i < environment.spaceStations.length; i++) {
      const ss = environment.spaceStations[i];
      if (!ss.visible) continue;
      ss.traverse((child) => {
        if (!child.isMesh) return;
        ssChildMats[ssMatIdx++] = { mesh: child, mat: child.material, layer: child.layers.mask };
        child.material = bloomOcclusionMaterial;
        child.layers.enable(BLOOM_LAYER);
      });
    }

    // Pass 1: Render bloom objects with occlusion
    bloomComposer.render();

    // Restore occluder layers, moon materials, billboard materials, and station materials
    occlusionSphereMesh.layers.disable(BLOOM_LAYER);
    for (let i = 0; i < environment.moons.length; i++) {
      environment.moons[i].material = moonOriginalMats[i];
      environment.moons[i].layers.disable(BLOOM_LAYER);
    }
    for (let i = 0; i < bbMatIdx; i++) {
      bbChildMats[i].mesh.material = bbChildMats[i].mat;
      bbChildMats[i].mesh.layers.mask = bbChildMats[i].layer;
    }
    for (let i = 0; i < ssMatIdx; i++) {
      ssChildMats[i].mesh.material = ssChildMats[i].mat;
      ssChildMats[i].mesh.layers.mask = ssChildMats[i].layer;
    }
    // Pass 2: Render full scene with bloom overlay
    finalComposer.render();

    // Loading screen warmup - wait for stable frames before showing game
    if (loadingScreen && !loadingScreen.classList.contains("fade-out")) {
      warmupFrames++;
      const frameMs = deltaTime * 1000;

      // Track frame stability — consecutive smooth frames
      if (frameMs < STABLE_FRAME_THRESHOLD) {
        stableFrameCount++;
      } else {
        stableFrameCount = 0;
      }

      // Progress bar: weighted sum of loading phases (never decreases)
      // When sponsors are loading: warmup 40% + sponsors 40% + stability 20%
      // When no sponsors:          warmup 80% + stability 20%
      const warmupRatio = Math.min(1, warmupFrames / WARMUP_FRAMES_MIN);
      const stabilityRatio = Math.min(1, stableFrameCount / STABLE_FRAMES_NEEDED);
      let newProgress;
      // sponsorLoadActive (singleplayer) or !sponsorTexturesReady (multiplayer waiting for server)
      if (sponsorLoadActive || !sponsorTexturesReady) {
        newProgress = warmupRatio * 40 + sponsorLoadProgress * 40 + stabilityRatio * 20;
      } else {
        newProgress = warmupRatio * 80 + stabilityRatio * 20;
      }
      loadingProgress = Math.max(loadingProgress, Math.min(100, newProgress));

      if (loadingBarFill) {
        loadingBarFill.style.width = loadingProgress + "%";
      }
      if (loadingPercent) {
        loadingPercent.textContent = Math.round(loadingProgress) + "%";
      }

      // Update loading text based on progress
      if (loadingText) {
        if (!sponsorTexturesReady && sponsorLoadProgress < 0.9) {
          loadingText.textContent = "loading sponsors...";
        } else if (!sponsorTexturesReady) {
          loadingText.textContent = "finalizing...";
        } else if (loadingProgress < 30) {
          loadingText.textContent = "initializing...";
        } else if (loadingProgress < 60) {
          loadingText.textContent = "loading terrain...";
        } else if (loadingProgress < 90) {
          loadingText.textContent = "preparing systems...";
        } else {
          loadingText.textContent = "ready";
        }
      }

      // Ready when: sponsor textures loaded AND ((min frames passed AND stable) OR hard cap reached)
      const isReady =
        sponsorTexturesReady &&
        ((warmupFrames >= WARMUP_FRAMES_MIN &&
          stableFrameCount >= STABLE_FRAMES_NEEDED) ||
        warmupFrames >= WARMUP_FRAMES_MAX);

      if (isReady) {
        loadingScreen.classList.add("fade-out");
        // Show auth screen (Firebase) or onboarding screen (offline fallback)
        if (typeof firebase !== "undefined" && typeof firebaseAuth !== "undefined") {
          authScreen.show();
        } else {
          onboardingScreen.show();
        }
        setTimeout(() => {
          loadingScreen.classList.add("hidden");
        }, 500);
      }
    }
  }

  // Save stats and release GPU resources on page unload
  window.addEventListener("beforeunload", () => {
    titleSystem.dispose();
    // Flush profile data to Firestore before page closes
    if (profileManager.loaded) {
      profileManager.saveNow();
    }
    // Release THREE.js GPU resources
    renderer.dispose();
    bloomComposer.renderTarget1?.dispose();
    bloomComposer.renderTarget2?.dispose();
    finalComposer.renderTarget1?.dispose();
    finalComposer.renderTarget2?.dispose();
  });

  // Pre-compile all shaders while loading screen is still visible.
  // Forces Three.js to compile every unique shader program upfront,
  // eliminating the shader compilation cascade that causes frame drops.
  renderer.compile(scene, camera);

  // Trigger one render cycle to also compile post-processing shader passes
  // (ShaderPass programs compile on first .render(), not via renderer.compile())
  bloomComposer.render();
  finalComposer.render();

  // Guest nudge: remind after 10 minutes of play
  setTimeout(() => {
    if (window.authManager?.isGuest && window.dashboard) {
      window.dashboard.showGuestNudge("session", "Enjoying AdLands? Sign in to save your progress");
    }
  }, 10 * 60 * 1000);

  animate();
})();
