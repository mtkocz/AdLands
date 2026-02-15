/**
 * AdLands - AuthScreen
 * Multi-stage authentication and profile selection screen.
 * Replaces the previous OnboardingScreen.
 *
 * Stages:
 *   1. Auth       — Sign-in buttons (Google, Apple, GitHub, Twitter, Email, Phone, Guest)
 *   2. Profiles   — Select from up to 3 profile slots or create new
 *   3. Create     — Name + faction picker for new profile
 *   4. Deploy     — Fade out, hand off to portal selection
 */

class AuthScreen {
  constructor(authManager) {
    /** @type {AuthManager} */
    this.auth = authManager;

    /** @type {string} Current stage: 'auth' | 'profiles' | 'create' | 'email-form' */
    this.stage = "auth";

    /** @type {Function|null} Callback: ({ name, faction, profileIndex, profileData }) => {} */
    this.onConfirm = null;

    /** @type {Array} Profile summaries loaded from Firestore */
    this._profiles = [null, null, null];

    /** @type {number} Selected profile index */
    this._selectedIndex = -1;

    /** @type {string|null} Selected faction for new profile */
    this._selectedFaction = null;

    /** @type {string|null} Selected avatar color for new profile */
    this._selectedColor = null;

    /** @type {boolean} Whether the create screen was opened from guest flow */
    this._isGuestCreate = false;

    /** Preset avatar colors */
    this.avatarColors = [
      "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71",
      "#1abc9c", "#3498db", "#9b59b6", "#e84393",
      "#fd79a8", "#00cec9", "#6c5ce7", "#fdcb6e",
    ];

    this._createUI();
    this._setupEvents();
  }

  // ========================
  // UI CREATION
  // ========================

  _createUI() {
    this.overlay = document.createElement("div");
    this.overlay.id = "auth-screen";
    this.overlay.className = "auth-hidden";

    this.overlay.innerHTML = `
      <div class="auth-panel">
        <!-- Stage 1: Auth -->
        <div class="auth-stage" id="auth-stage-auth">
          <div class="auth-title">AdLands</div>
          <div class="auth-subtitle">A Limited Liability Company</div>

          <div class="auth-providers">
            <button class="auth-btn auth-btn-google" data-provider="google">
              <span class="auth-btn-icon">G</span>
              Continue with Google
            </button>
            <button class="auth-btn auth-btn-email" data-provider="email">
              <span class="auth-btn-icon">\u2709</span>
              Continue with Email
            </button>
          </div>

          <div class="auth-divider"><span>or</span></div>

          <button class="auth-btn auth-btn-guest" data-provider="guest">
            Play as Guest
          </button>

          <div class="auth-error hidden" id="auth-error"></div>
        </div>

        <!-- Stage 1b: Email Form -->
        <div class="auth-stage hidden" id="auth-stage-email">
          <div class="auth-title">Email Sign In</div>

          <input type="email" id="auth-email-input"
                 class="auth-input"
                 placeholder="Email address"
                 autocomplete="email">

          <input type="password" id="auth-password-input"
                 class="auth-input"
                 placeholder="Password"
                 autocomplete="current-password">

          <button class="auth-btn auth-btn-primary" id="auth-email-signin">
            Sign In
          </button>
          <button class="auth-btn auth-btn-secondary" id="auth-email-create">
            Create Account
          </button>
          <button class="auth-btn auth-btn-link" id="auth-email-reset">
            Forgot password?
          </button>
          <button class="auth-btn auth-btn-back" id="auth-email-back">
            Back
          </button>

          <div class="auth-error hidden" id="auth-email-error"></div>
        </div>

        <!-- Stage 2: Profile Selection -->
        <div class="auth-stage hidden" id="auth-stage-profiles">
          <div class="auth-title">Select Profile</div>
          <div class="auth-profile-slots" id="auth-profile-slots"></div>
          <button class="auth-btn auth-btn-signout" id="auth-signout">
            Sign Out
          </button>
          <button class="auth-btn auth-btn-link" id="auth-link-account" style="display:none">
            Link Account (save your progress)
          </button>
        </div>

        <!-- Stage 3: Profile Creation -->
        <div class="auth-stage hidden" id="auth-stage-create">
          <div class="auth-title" id="auth-create-title">Create Profile</div>

          <div class="auth-avatar-section">
            <div class="auth-avatar-preview" id="auth-avatar-preview"></div>
            <div class="auth-avatar-grid" id="auth-avatar-grid"></div>
          </div>

          <input type="text" id="auth-profile-name"
                 class="auth-input"
                 placeholder="Enter name..."
                 maxlength="20"
                 autocomplete="off"
                 spellcheck="false">

          <div class="auth-faction-prompt">Choose Faction (permanent)</div>
          <div class="auth-factions">
            <button class="faction-btn" data-faction="rust">Rust</button>
            <button class="faction-btn" data-faction="cobalt">Cobalt</button>
            <button class="faction-btn" data-faction="viridian">Viridian</button>
          </div>

          <button class="auth-btn auth-btn-primary" id="auth-create-confirm" disabled>
            Create Profile
          </button>
          <button class="auth-btn auth-btn-back" id="auth-create-back">
            Cancel
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);
  }

  // ========================
  // EVENT SETUP
  // ========================

  _setupEvents() {
    // Prevent game input while auth screen is active
    this.overlay.addEventListener("keydown", (e) => e.stopPropagation());
    this.overlay.addEventListener("keyup", (e) => e.stopPropagation());

    // Auth provider buttons
    this.overlay.querySelectorAll("[data-provider]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._handleProviderClick(btn.dataset.provider);
      });
    });

    // Email form
    const emailSignin = this.overlay.querySelector("#auth-email-signin");
    const emailCreate = this.overlay.querySelector("#auth-email-create");
    const emailReset = this.overlay.querySelector("#auth-email-reset");
    const emailBack = this.overlay.querySelector("#auth-email-back");

    emailSignin.addEventListener("click", (e) => {
      e.stopPropagation();
      this._handleEmailSignIn();
    });
    emailCreate.addEventListener("click", (e) => {
      e.stopPropagation();
      this._handleEmailCreate();
    });
    emailReset.addEventListener("click", (e) => {
      e.stopPropagation();
      this._handleEmailReset();
    });
    emailBack.addEventListener("click", (e) => {
      e.stopPropagation();
      this._showStage("auth");
    });

    // Enter key in password field
    this.overlay.querySelector("#auth-password-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.stopPropagation();
        this._handleEmailSignIn();
      }
    });

    // Sign out
    this.overlay.querySelector("#auth-signout").addEventListener("click", (e) => {
      e.stopPropagation();
      this.auth.signOut().then(() => this._showStage("auth"));
    });

    // Link account (for guests)
    this.overlay.querySelector("#auth-link-account").addEventListener("click", (e) => {
      e.stopPropagation();
      this._handleLinkAccount();
    });

    // Profile creation
    const createConfirm = this.overlay.querySelector("#auth-create-confirm");
    const createBack = this.overlay.querySelector("#auth-create-back");
    const nameInput = this.overlay.querySelector("#auth-profile-name");

    this.overlay.querySelectorAll(".auth-factions .faction-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._selectFaction(btn.dataset.faction);
      });
    });

    nameInput.addEventListener("input", () => this._updateCreateState());
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !createConfirm.disabled) {
        e.stopPropagation();
        this._handleCreateProfile();
      }
    });

    createConfirm.addEventListener("click", (e) => {
      e.stopPropagation();
      this._handleCreateProfile();
    });

    createBack.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._isGuestCreate) {
        // Guest cancel: sign out and go back to auth screen
        this.auth.signOut().then(() => this._showStage("auth"));
      } else {
        this._showStage("profiles");
      }
    });
  }

  // ========================
  // STAGE MANAGEMENT
  // ========================

  _showStage(stage) {
    this.stage = stage;
    const stages = this.overlay.querySelectorAll(".auth-stage");
    stages.forEach((el) => el.classList.add("hidden"));

    const target = this.overlay.querySelector(`#auth-stage-${stage}`);
    if (target) target.classList.remove("hidden");

    // Clear errors
    this.overlay.querySelectorAll(".auth-error").forEach((el) => {
      el.classList.add("hidden");
      el.textContent = "";
    });
  }

  _showError(errorId, message) {
    const el = this.overlay.querySelector(`#${errorId}`);
    if (el) {
      el.textContent = message;
      el.classList.remove("hidden");
    }
  }

  // ========================
  // AUTH HANDLERS
  // ========================

  async _handleProviderClick(provider) {
    // Disable all buttons while authenticating
    this._setButtonsDisabled(true);

    try {
      switch (provider) {
        case "google":
          await this.auth.signInWithGoogle();
          break;
        case "email":
          this._setButtonsDisabled(false);
          this._showStage("email");
          return;
        case "guest":
          await this.auth.signInAsGuest();
          break;
      }

      // Auth succeeded — guests skip to create screen, others go to profile selection
      if (provider === "guest") {
        await this._loadAndShowGuestCreate();
      } else {
        await this._loadAndShowProfiles();
      }
    } catch (err) {
      this._setButtonsDisabled(false);
      if (err.code === "auth/popup-closed-by-user") return; // User cancelled
      if (err.code === "auth/cancelled-popup-request") return;
      console.error("[AuthScreen] Sign-in error:", err);
      this._showError("auth-error", this._friendlyError(err));
    }
  }

  async _handleEmailSignIn() {
    const email = this.overlay.querySelector("#auth-email-input").value.trim();
    const password = this.overlay.querySelector("#auth-password-input").value;

    if (!email || !password) {
      this._showError("auth-email-error", "Please enter email and password.");
      return;
    }

    this._setButtonsDisabled(true);
    try {
      await this.auth.signInWithEmail(email, password);
      await this._loadAndShowProfiles();
    } catch (err) {
      this._setButtonsDisabled(false);
      this._showError("auth-email-error", this._friendlyError(err));
    }
  }

  async _handleEmailCreate() {
    const email = this.overlay.querySelector("#auth-email-input").value.trim();
    const password = this.overlay.querySelector("#auth-password-input").value;

    if (!email || !password) {
      this._showError("auth-email-error", "Please enter email and password.");
      return;
    }
    if (password.length < 6) {
      this._showError("auth-email-error", "Password must be at least 6 characters.");
      return;
    }

    this._setButtonsDisabled(true);
    try {
      await this.auth.createAccountWithEmail(email, password);
      await this._loadAndShowProfiles();
    } catch (err) {
      this._setButtonsDisabled(false);
      this._showError("auth-email-error", this._friendlyError(err));
    }
  }

  async _handleEmailReset() {
    const email = this.overlay.querySelector("#auth-email-input").value.trim();
    if (!email) {
      this._showError("auth-email-error", "Enter your email address first.");
      return;
    }
    try {
      await this.auth.sendPasswordReset(email);
      this._showError("auth-email-error", "Password reset email sent. Check your inbox.");
    } catch (err) {
      this._showError("auth-email-error", this._friendlyError(err));
    }
  }

  async _handleLinkAccount() {
    try {
      await this.auth.linkWithGoogle();
      // Refresh profile view (link button should hide)
      await this._loadAndShowProfiles();
    } catch (err) {
      if (err.code === "auth/popup-closed-by-user") return;
      console.error("[AuthScreen] Link error:", err);
    }
  }

  // ========================
  // PROFILE MANAGEMENT
  // ========================

  async _loadAndShowProfiles() {
    this._setButtonsDisabled(false);
    const uid = this.auth.uid;
    if (!uid) return;

    try {
      // Load or create account document
      const accountRef = firebaseDb.collection("accounts").doc(uid);
      const accountDoc = await accountRef.get();

      if (!accountDoc.exists) {
        // First-time user — create account document
        await accountRef.set({
          email: this.auth.email || null,
          displayName: this.auth.displayName || null,
          photoURL: this.auth.photoURL || null,
          linkedProviders: this.auth.linkedProviders,
          isAnonymous: this.auth.isGuest,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
          activeProfileIndex: 0,
          cosmeticsPurchased: [],
          profiles: [null, null, null],
          settings: {},
        });
        this._profiles = [null, null, null];
      } else {
        // Update last login
        accountRef.update({
          lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
          linkedProviders: this.auth.linkedProviders,
          isAnonymous: this.auth.isGuest,
        });
        const data = accountDoc.data();
        this._profiles = this._sanitizeProfiles(data.profiles);
      }

      this._renderProfileSlots();
      this._showStage("profiles");

      // Show "Link Account" button for guest users
      const linkBtn = this.overlay.querySelector("#auth-link-account");
      linkBtn.style.display = this.auth.isGuest ? "block" : "none";
    } catch (err) {
      console.error("[AuthScreen] Failed to load profiles:", err);
      this._showError("auth-error", "Failed to load profiles. Please try again.");
      this._showStage("auth");
    }
  }

  _renderProfileSlots() {
    const container = this.overlay.querySelector("#auth-profile-slots");
    container.innerHTML = "";

    for (let i = 0; i < 3; i++) {
      const profile = this._profiles[i];
      const slot = document.createElement("div");
      slot.className = "auth-profile-slot" + (profile ? ` has-profile faction-${profile.faction}` : " empty");
      slot.dataset.index = i;

      if (profile) {
        const avatarStyle = profile.profilePicture
          ? `background: ${profile.profilePicture}`
          : `background: var(--bg-highlight)`;
        slot.innerHTML = `
          <div class="profile-slot-avatar" style="${avatarStyle}"></div>
          <div class="profile-slot-info">
            <div class="profile-slot-name">${this._escapeHtml(profile.name)}</div>
            <div class="profile-slot-details">
              <span class="profile-slot-faction">${profile.faction}</span>
              <span class="profile-slot-level">Lv ${profile.level || 1}</span>
            </div>
          </div>
          <div class="profile-slot-actions">
            <button class="profile-slot-play" data-index="${i}">Play</button>
            <button class="profile-slot-delete" data-index="${i}" title="Delete profile">\u2715</button>
          </div>
        `;
      } else {
        slot.innerHTML = `
          <div class="profile-slot-empty">
            <span class="profile-slot-plus">+</span>
            <span>Create Profile</span>
          </div>
        `;
      }

      container.appendChild(slot);

      // Events
      if (profile) {
        slot.querySelector(".profile-slot-play").addEventListener("click", (e) => {
          e.stopPropagation();
          this._selectProfile(i);
        });
        slot.querySelector(".profile-slot-delete").addEventListener("click", (e) => {
          e.stopPropagation();
          this._deleteProfile(i);
        });
      } else {
        slot.addEventListener("click", (e) => {
          e.stopPropagation();
          this._startCreateProfile(i);
        });
      }
    }
  }

  async _selectProfile(index) {
    const uid = this.auth.uid;
    if (!uid) return;

    this._setButtonsDisabled(true);

    try {
      // Load full profile data from Firestore
      const profileRef = firebaseDb
        .collection("accounts").doc(uid)
        .collection("profiles").doc(String(index));
      const profileDoc = await profileRef.get();

      if (!profileDoc.exists) {
        this._setButtonsDisabled(false);
        return;
      }

      // Update active profile index on account
      await firebaseDb.collection("accounts").doc(uid).update({
        activeProfileIndex: index,
      });

      const profileData = profileDoc.data();
      this._selectedIndex = index;

      // Hand off to game
      if (this.onConfirm) {
        this.onConfirm({
          name: profileData.name,
          faction: profileData.faction,
          profileIndex: index,
          profileData: profileData,
        });
      }
    } catch (err) {
      console.error("[AuthScreen] Failed to load profile:", err);
      this._setButtonsDisabled(false);
    }
  }

  /**
   * Guest flow: skip profile selector, go straight to create screen.
   * Creates account doc if needed, then shows "Deploy As" form.
   */
  async _loadAndShowGuestCreate() {
    this._setButtonsDisabled(false);
    const uid = this.auth.uid;
    if (!uid) return;

    try {
      const accountRef = firebaseDb.collection("accounts").doc(uid);
      const accountDoc = await accountRef.get();

      if (!accountDoc.exists) {
        await accountRef.set({
          email: null,
          displayName: null,
          photoURL: null,
          linkedProviders: [],
          isAnonymous: true,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
          activeProfileIndex: 0,
          cosmeticsPurchased: [],
          profiles: [null, null, null],
          settings: {},
        });
        this._profiles = [null, null, null];
      } else {
        accountRef.update({
          lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
          isAnonymous: true,
        });
        this._profiles = this._sanitizeProfiles(accountDoc.data().profiles);
      }

      // Go straight to create form for slot 0
      this._startCreateProfile(0, true);
    } catch (err) {
      console.error("[AuthScreen] Guest create error:", err);
      this._showError("auth-error", "Failed to start. Please try again.");
      this._showStage("auth");
    }
  }

  _startCreateProfile(index, isGuest = false) {
    this._selectedIndex = index;
    this._selectedFaction = null;
    this._selectedColor = null;
    this._isGuestCreate = isGuest;

    // Set title and button text based on guest vs. regular
    const title = this.overlay.querySelector("#auth-create-title");
    const confirmBtn = this.overlay.querySelector("#auth-create-confirm");

    if (isGuest) {
      title.textContent = "Deploy As";
      confirmBtn.textContent = "Deploy";
    } else {
      title.textContent = "Create Profile";
      confirmBtn.textContent = "Create Profile";
    }

    // Reset create form
    this.overlay.querySelector("#auth-profile-name").value = "";
    this.overlay.querySelectorAll(".auth-factions .faction-btn").forEach((btn) => {
      btn.classList.remove("selected");
    });
    confirmBtn.disabled = true;

    // Build avatar color grid
    this._buildAvatarGrid();

    // Pre-fill name from auth if available
    if (this.auth.displayName) {
      const nameInput = this.overlay.querySelector("#auth-profile-name");
      nameInput.value = this.auth.displayName.substring(0, 20);
    }

    // Disable factions that are already used by other profiles
    const usedFactions = this._profiles
      .filter((p) => p !== null)
      .map((p) => p.faction);
    this.overlay.querySelectorAll(".auth-factions .faction-btn").forEach((btn) => {
      const faction = btn.dataset.faction;
      const used = usedFactions.includes(faction);
      btn.disabled = used;
      btn.classList.toggle("faction-used", used);
    });

    this._showStage("create");
    setTimeout(() => {
      this.overlay.querySelector("#auth-profile-name").focus();
    }, 100);
  }

  _buildAvatarGrid() {
    const grid = this.overlay.querySelector("#auth-avatar-grid");
    const preview = this.overlay.querySelector("#auth-avatar-preview");
    grid.innerHTML = "";
    preview.style.background = "";
    preview.classList.add("empty");

    this.avatarColors.forEach((color) => {
      const swatch = document.createElement("button");
      swatch.className = "auth-avatar-swatch";
      swatch.style.background = color;
      swatch.dataset.color = color;
      swatch.addEventListener("click", (e) => {
        e.stopPropagation();
        this._selectAvatarColor(color);
      });
      grid.appendChild(swatch);
    });
  }

  _selectAvatarColor(color) {
    this._selectedColor = color;
    const preview = this.overlay.querySelector("#auth-avatar-preview");
    preview.style.background = color;
    preview.classList.remove("empty");

    // Update swatch selection
    this.overlay.querySelectorAll(".auth-avatar-swatch").forEach((s) => {
      s.classList.toggle("selected", s.dataset.color === color);
    });

    this._updateCreateState();
  }

  _selectFaction(faction) {
    this._selectedFaction = faction;
    this.overlay.querySelectorAll(".auth-factions .faction-btn").forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.faction === faction);
    });
    this._updateCreateState();
  }

  _updateCreateState() {
    const name = this.overlay.querySelector("#auth-profile-name").value.trim();
    const valid = name.length > 0 && this._selectedFaction !== null && this._selectedColor !== null;
    this.overlay.querySelector("#auth-create-confirm").disabled = !valid;
  }

  async _handleCreateProfile() {
    const nameInput = this.overlay.querySelector("#auth-profile-name");
    const name = nameInput.value.trim();
    const faction = this._selectedFaction;
    const index = this._selectedIndex;
    const uid = this.auth.uid;

    if (!name || !faction || !uid || index < 0 || index > 2) return;

    // Validate name (same rules as OnboardingScreen)
    if (!/^[a-zA-Z0-9 _-]+$/.test(name)) {
      this._showError("auth-error", "Name can only contain letters, numbers, spaces, hyphens, underscores.");
      return;
    }

    this._setButtonsDisabled(true);
    const confirmBtn = this.overlay.querySelector("#auth-create-confirm");
    confirmBtn.textContent = "Creating...";

    try {
      const now = firebase.firestore.FieldValue.serverTimestamp();

      // Create profile document
      const profileData = {
        name: name,
        faction: faction,
        profilePicture: this._selectedColor || null,
        createdAt: now,
        lastPlayedAt: now,

        // Progression
        level: 1,
        totalCrypto: 0,
        sessionCrypto: 0,

        // Stats
        kills: 0,
        deaths: 0,
        damageDealt: 0,
        maxKillstreak: 0,
        hexesCaptured: 0,
        clustersCaptured: 0,
        ticsContributed: 0,
        timeDefending: 0,

        // Loadout
        loadout: {},

        // Tank upgrades
        tankUpgrades: { armor: 0, speed: 0, fireRate: 0, damage: 0 },

        // Badges
        unlockedBadges: [],
        badgeProgress: {},

        // Titles
        titleStats: { currentTitle: "Contractor" },

        // Cosmetics
        equippedCosmetics: {
          tankSkin: null,
          turretSkin: null,
          trackTrail: null,
          deathEffect: null,
          nameplate: null,
        },
      };

      // Write profile to subcollection
      await firebaseDb
        .collection("accounts").doc(uid)
        .collection("profiles").doc(String(index))
        .set(profileData);

      // Update denormalized profile summary on account
      const profileSummary = { name, faction, level: 1, profilePicture: this._selectedColor || null };
      const profilesUpdate = [...this._profiles];
      profilesUpdate[index] = profileSummary;

      await firebaseDb.collection("accounts").doc(uid).update({
        profiles: profilesUpdate,
        activeProfileIndex: index,
      });

      this._profiles = profilesUpdate;

      // Hand off to game
      if (this.onConfirm) {
        this.onConfirm({
          name: profileData.name,
          faction: profileData.faction,
          profileIndex: index,
          profileData: profileData,
        });
      }
    } catch (err) {
      console.error("[AuthScreen] Failed to create profile:", err);
      confirmBtn.textContent = "Create Profile";
      this._setButtonsDisabled(false);
    }
  }

  async _deleteProfile(index) {
    const profile = this._profiles[index];
    if (!profile) return;

    // Confirmation
    const name = profile.name || "Unnamed";
    const faction = profile.faction || "unknown";
    const confirmed = window.confirm(
      `Delete profile "${name}" (${faction})? This cannot be undone.`,
    );
    if (!confirmed) return;

    const uid = this.auth.uid;
    if (!uid) return;

    try {
      // Delete profile document
      await firebaseDb
        .collection("accounts").doc(uid)
        .collection("profiles").doc(String(index))
        .delete();

      // Update account
      const profilesUpdate = [...this._profiles];
      profilesUpdate[index] = null;
      await firebaseDb.collection("accounts").doc(uid).update({
        profiles: profilesUpdate,
      });

      this._profiles = profilesUpdate;
      this._renderProfileSlots();
    } catch (err) {
      console.error("[AuthScreen] Failed to delete profile:", err);
    }
  }

  /**
   * Sanitize profiles array from Firestore.
   * Entries without valid name+faction are treated as empty slots.
   */
  _sanitizeProfiles(profiles) {
    if (!Array.isArray(profiles)) return [null, null, null];
    return [0, 1, 2].map((i) => {
      const p = profiles[i];
      if (p && typeof p.name === "string" && p.name.length > 0 && p.faction) {
        return p;
      }
      return null;
    });
  }

  // ========================
  // VISIBILITY
  // ========================

  show() {
    this.overlay.classList.remove("auth-hidden");
    // If already signed in, go straight to profiles
    if (this.auth.isSignedIn) {
      this._loadAndShowProfiles();
    } else {
      this._showStage("auth");
    }
  }

  hide(callback) {
    this.overlay.classList.add("auth-fade-out");
    setTimeout(() => {
      this.overlay.classList.add("auth-hidden");
      this.overlay.classList.remove("auth-fade-out");
      if (callback) callback();
    }, 400);
  }

  // ========================
  // HELPERS
  // ========================

  _setButtonsDisabled(disabled) {
    this.overlay.querySelectorAll("button").forEach((btn) => {
      btn.disabled = disabled;
    });
  }

  _escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  _friendlyError(err) {
    const map = {
      "auth/email-already-in-use": "An account with this email already exists.",
      "auth/invalid-email": "Please enter a valid email address.",
      "auth/user-not-found": "No account found with this email.",
      "auth/wrong-password": "Incorrect password.",
      "auth/weak-password": "Password must be at least 6 characters.",
      "auth/too-many-requests": "Too many attempts. Please try again later.",
      "auth/network-request-failed": "Network error. Check your connection.",
      "auth/account-exists-with-different-credential":
        "An account already exists with a different sign-in method.",
    };
    return map[err.code] || err.message || "An error occurred. Please try again.";
  }
}
