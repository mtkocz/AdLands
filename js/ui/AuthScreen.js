/**
 * AdLands - AuthScreen
 * Single-screen authentication and profile selection.
 *
 * Stages:
 *   1. Deploy    — Name + faction + avatar + auth buttons (new users),
 *                  or "Create Profile" button (already signed in)
 *   2. Email     — Email/password sub-form
 *   3. Profiles  — Select from profile slots (returning users)
 */

class AuthScreen {
  constructor(authManager) {
    /** @type {AuthManager} */
    this.auth = authManager;

    /** @type {string} Current stage: 'deploy' | 'profiles' | 'email' */
    this.stage = "deploy";

    /** @type {Function|null} Callback: ({ name, faction, profileIndex, profileData }) => {} */
    this.onConfirm = null;

    /** @type {Array} Profile summaries loaded from Firestore */
    this._profiles = [null, null, null];

    /** @type {number} Selected profile index */
    this._selectedIndex = -1;

    /** @type {string|null} Selected faction for new profile */
    this._selectedFaction = null;

    /** @type {string|null} Uploaded profile picture as base64 data URL */
    this._uploadedImage = null;

    /** @type {boolean} Whether the user is currently authenticated */
    this._isAuthenticated = false;

    /** @type {boolean} Whether the deploy form is in edit mode */
    this._isEditMode = false;

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
        <button class="auth-close-btn hidden" id="auth-close-btn" title="Return to game">\u2715</button>

        <!-- Stage: Deploy (combined auth + profile creation) -->
        <div class="auth-stage" id="auth-stage-deploy">
          <div class="auth-title" id="auth-deploy-title">AdLands</div>
          <div class="auth-subtitle" id="auth-deploy-subtitle">A Limited Liability Company</div>

          <!-- Avatar upload -->
          <div class="auth-avatar-section">
            <div class="auth-avatar-preview empty" id="auth-avatar-preview"></div>
            <button class="auth-btn auth-btn-secondary auth-avatar-upload-btn" id="auth-avatar-upload-btn">
              Upload Picture
            </button>
            <input type="file" id="auth-avatar-file" accept="image/*" style="display:none">
          </div>

          <!-- Name input -->
          <input type="text" id="auth-profile-name"
                 class="auth-input"
                 placeholder="Enter name..."
                 maxlength="20"
                 autocomplete="off"
                 spellcheck="false">

          <!-- Faction picker -->
          <div id="auth-faction-section">
            <div class="auth-faction-prompt">Choose Faction (permanent)</div>
            <div class="auth-factions">
              <button class="faction-btn" data-faction="rust">Rust</button>
              <button class="faction-btn" data-faction="cobalt">Cobalt</button>
              <button class="faction-btn" data-faction="viridian">Viridian</button>
            </div>
          </div>

          <!-- Auth buttons (shown when NOT signed in) -->
          <div id="auth-deploy-providers">
            <div class="auth-divider"><span>Deploy with</span></div>
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
          </div>

          <!-- Create button (shown when ALREADY signed in) -->
          <div id="auth-deploy-create" class="hidden">
            <button class="auth-btn auth-btn-primary" id="auth-create-confirm" disabled>
              Create Profile
            </button>
            <button class="auth-btn auth-btn-back" id="auth-create-back">
              Cancel
            </button>
          </div>

          <div class="auth-error hidden" id="auth-error"></div>
        </div>

        <!-- Stage: Email Form -->
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

        <!-- Stage: Profile Selection -->
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

    // Close button (return to game)
    this.overlay.querySelector("#auth-close-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      this.hide();
    });

    // Auth provider buttons (in deploy stage)
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
      this._showStage("deploy");
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
      this.auth.signOut().then(() => {
        this._isAuthenticated = false;
        this._showDeployScreen();
      });
    });

    // Link account (for guests)
    this.overlay.querySelector("#auth-link-account").addEventListener("click", (e) => {
      e.stopPropagation();
      this._handleLinkAccount();
    });

    // Profile creation / edit (in deploy stage)
    const createConfirm = this.overlay.querySelector("#auth-create-confirm");
    const createBack = this.overlay.querySelector("#auth-create-back");
    const nameInput = this.overlay.querySelector("#auth-profile-name");

    this.overlay.querySelectorAll(".auth-factions .faction-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._selectFaction(btn.dataset.faction);
      });
    });

    // Avatar upload
    const avatarUploadBtn = this.overlay.querySelector("#auth-avatar-upload-btn");
    const avatarFileInput = this.overlay.querySelector("#auth-avatar-file");
    avatarUploadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      avatarFileInput.click();
    });
    avatarFileInput.addEventListener("change", (e) => {
      e.stopPropagation();
      if (avatarFileInput.files && avatarFileInput.files[0]) {
        this._handleAvatarUpload(avatarFileInput.files[0]);
      }
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
      if (this._isEditMode) {
        this._showStage("profiles");
      } else {
        const hasProfiles = this._profiles.some((p) => p !== null);
        if (hasProfiles) {
          this._showStage("profiles");
        } else {
          // New user with no profiles — sign out and go back to unauthenticated deploy
          this.auth.signOut().then(() => {
            this._isAuthenticated = false;
            this._showDeployScreen();
          });
        }
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
  // VISIBILITY
  // ========================

  async show(canDismiss = false) {
    this.overlay.classList.remove("auth-hidden");

    // Show/hide close button based on whether user can return to game
    const closeBtn = this.overlay.querySelector("#auth-close-btn");
    closeBtn.classList.toggle("hidden", !canDismiss);

    // Wait for Firebase to resolve initial auth state before deciding stage
    await this.auth.waitForReady();

    if (this.auth.isSignedIn) {
      this._isAuthenticated = true;

      try {
        const uid = this.auth.uid;
        const accountDoc = await firebaseDb.collection("accounts").doc(uid).get();

        if (accountDoc.exists) {
          const data = accountDoc.data();
          this._profiles = this._sanitizeProfiles(data.profiles);

          // Update last login (fire and forget)
          firebaseDb.collection("accounts").doc(uid).update({
            lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
            linkedProviders: this.auth.linkedProviders,
            isAnonymous: this.auth.isGuest,
          });

          const hasProfiles = this._profiles.some((p) => p !== null);
          if (hasProfiles) {
            this._renderProfileSlots();
            this._showStage("profiles");
            const linkBtn = this.overlay.querySelector("#auth-link-account");
            linkBtn.style.display = this.auth.isGuest ? "block" : "none";
            return;
          }
        }

        // No profiles or no account doc — show deploy in authenticated mode
        this._showDeployScreen(this._findNextEmptySlot());
      } catch (err) {
        console.error("[AuthScreen] Failed to check profiles:", err);
        this._showDeployScreen(this._findNextEmptySlot());
      }
    } else {
      this._isAuthenticated = false;
      this._showDeployScreen();
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
  // DEPLOY SCREEN
  // ========================

  /**
   * Set up and show the deploy screen.
   * Resets form, toggles auth buttons vs create button, disables used factions.
   * @param {number} [slotIndex] - Profile slot to create into
   */
  _showDeployScreen(slotIndex) {
    this._selectedIndex = slotIndex !== undefined ? slotIndex : this._findNextEmptySlot();
    this._selectedFaction = null;
    this._uploadedImage = null;
    this._isEditMode = false;

    // Toggle auth buttons vs create button
    const providersDiv = this.overlay.querySelector("#auth-deploy-providers");
    const createDiv = this.overlay.querySelector("#auth-deploy-create");

    if (this._isAuthenticated) {
      providersDiv.classList.add("hidden");
      createDiv.classList.remove("hidden");
      // Set button text
      const confirmBtn = this.overlay.querySelector("#auth-create-confirm");
      confirmBtn.textContent = "Create Profile";
      confirmBtn.disabled = true;
    } else {
      providersDiv.classList.remove("hidden");
      createDiv.classList.add("hidden");
    }

    // Set title
    const title = this.overlay.querySelector("#auth-deploy-title");
    const subtitle = this.overlay.querySelector("#auth-deploy-subtitle");
    if (this._isAuthenticated) {
      title.textContent = "Create Profile";
      subtitle.textContent = "";
    } else {
      title.textContent = "AdLands";
      subtitle.textContent = "A Limited Liability Company";
    }

    // Show faction section
    this.overlay.querySelector("#auth-faction-section").style.display = "";

    // Reset form
    const nameInput = this.overlay.querySelector("#auth-profile-name");
    nameInput.value = "";
    this.overlay.querySelectorAll(".auth-factions .faction-btn").forEach((btn) => {
      btn.classList.remove("selected");
    });

    // Reset avatar preview
    this._resetAvatarPreview();
    this.overlay.querySelector("#auth-avatar-file").value = "";

    // Pre-fill name from auth if available
    if (this.auth.displayName) {
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

    // Reset auth buttons to default text
    const googleBtn = this.overlay.querySelector('[data-provider="google"]');
    const guestBtn = this.overlay.querySelector('[data-provider="guest"]');
    if (googleBtn) googleBtn.innerHTML = '<span class="auth-btn-icon">G</span> Continue with Google';
    if (guestBtn) guestBtn.textContent = "Play as Guest";

    this._showStage("deploy");
    this._updateCreateState();
    setTimeout(() => nameInput.focus(), 100);
  }

  // ========================
  // POST-AUTH ROUTING
  // ========================

  /**
   * Shared logic after any auth method succeeds.
   * Checks Firestore for existing profiles and routes accordingly.
   */
  async _postAuthRouting() {
    const uid = this.auth.uid;
    if (!uid) return;

    this._isAuthenticated = true;

    try {
      const accountRef = firebaseDb.collection("accounts").doc(uid);
      const accountDoc = await accountRef.get();

      if (!accountDoc.exists) {
        // New user — create account document
        const maxSlots = this.auth.isGuest ? 1 : 3;
        const profilesArray = Array(maxSlots).fill(null);
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
          profiles: profilesArray,
          settings: {},
        });
        this._profiles = profilesArray;

        // New user — try to auto-create from deploy form data
        await this._validateAndCreateFromDeploy();
      } else {
        // Existing user — update last login
        accountRef.update({
          lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
          linkedProviders: this.auth.linkedProviders,
          isAnonymous: this.auth.isGuest,
        });

        const data = accountDoc.data();
        this._profiles = this._sanitizeProfiles(data.profiles);

        const hasProfiles = this._profiles.some((p) => p !== null);
        if (hasProfiles) {
          // Returning user — show profile selector
          this._setButtonsDisabled(false);
          this._renderProfileSlots();
          this._showStage("profiles");
          const linkBtn = this.overlay.querySelector("#auth-link-account");
          linkBtn.style.display = this.auth.isGuest ? "block" : "none";
        } else {
          // Existing account but no profiles — try to auto-create
          await this._validateAndCreateFromDeploy();
        }
      }
    } catch (err) {
      console.error("[AuthScreen] Post-auth routing failed:", err);
      this._setButtonsDisabled(false);
      this._showDeployScreen(this._findNextEmptySlot());
      this._showError("auth-error", "Failed to load account. Please try again.");
    }
  }

  /**
   * Validate deploy form and auto-create profile if valid.
   * If form is incomplete, switch deploy to authenticated mode with error hint.
   */
  async _validateAndCreateFromDeploy() {
    const name = this.overlay.querySelector("#auth-profile-name").value.trim();
    const faction = this._selectedFaction;

    if (!name || !faction) {
      // Incomplete form — switch to authenticated deploy mode with error
      this._setButtonsDisabled(false);
      this._switchDeployToAuthMode();

      // Pre-fill name from auth if form is empty
      if (!name && this.auth.displayName) {
        this.overlay.querySelector("#auth-profile-name").value = this.auth.displayName.substring(0, 20);
      }

      this._updateCreateState();
      // Ensure deploy stage is visible (may have been on email stage)
      this._showStage("deploy");
      this._showError("auth-error", "Enter a name and choose a faction to deploy.");
      return;
    }

    // Validate name
    if (!/^[a-zA-Z0-9 _-]+$/.test(name)) {
      this._setButtonsDisabled(false);
      this._switchDeployToAuthMode();
      this._updateCreateState();
      this._showStage("deploy");
      this._showError("auth-error", "Name can only contain letters, numbers, spaces, hyphens, underscores.");
      return;
    }

    const index = this._selectedIndex >= 0 ? this._selectedIndex : this._findNextEmptySlot();
    this._selectedIndex = index;
    const uid = this.auth.uid;

    try {
      await this._saveNewProfile(name, faction, index, uid);
    } catch (err) {
      console.error("[AuthScreen] Auto-create failed:", err);
      this._setButtonsDisabled(false);
      this._switchDeployToAuthMode();
      this._showStage("deploy");
      this._showError("auth-error", "Failed to create profile. Please try again.");
    }
  }

  /**
   * Toggle deploy stage to show Create Profile button instead of auth buttons.
   */
  _switchDeployToAuthMode() {
    const title = this.overlay.querySelector("#auth-deploy-title");
    const subtitle = this.overlay.querySelector("#auth-deploy-subtitle");
    title.textContent = "Create Profile";
    subtitle.textContent = "";

    this.overlay.querySelector("#auth-deploy-providers").classList.add("hidden");
    const createDiv = this.overlay.querySelector("#auth-deploy-create");
    createDiv.classList.remove("hidden");

    const confirmBtn = this.overlay.querySelector("#auth-create-confirm");
    confirmBtn.textContent = "Create Profile";
  }

  /**
   * Find the first empty profile slot.
   * @returns {number}
   */
  _findNextEmptySlot() {
    const idx = this._profiles.findIndex((p) => p === null);
    return idx >= 0 ? idx : 0;
  }

  // ========================
  // AUTH HANDLERS
  // ========================

  async _handleProviderClick(provider) {
    const btn = this.overlay.querySelector(`[data-provider="${provider}"]`);
    const originalHTML = btn ? btn.innerHTML : "";

    if (provider === "email") {
      // Navigate to email sub-form (deploy form data persists in DOM)
      this._showStage("email");
      return;
    }

    if (btn) {
      btn.textContent = provider === "guest" ? "Loading..." : "Signing in...";
    }
    this._setButtonsDisabled(true);

    try {
      switch (provider) {
        case "google":
          await this.auth.signInWithGoogle();
          break;
        case "guest":
          await this.auth.signInAsGuest();
          break;
      }

      // Auth succeeded — route based on Firestore state
      await this._postAuthRouting();
    } catch (err) {
      this._setButtonsDisabled(false);
      if (btn) btn.innerHTML = originalHTML;
      if (err.code === "auth/popup-closed-by-user") return;
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

    const signinBtn = this.overlay.querySelector("#auth-email-signin");
    signinBtn.textContent = "Signing in...";
    this._setButtonsDisabled(true);
    try {
      await this.auth.signInWithEmail(email, password);
      this._isAuthenticated = true;
      await this._postAuthRouting();
    } catch (err) {
      signinBtn.textContent = "Sign In";
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
      this._isAuthenticated = true;
      await this._postAuthRouting();
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

      // Reload profiles (guest → regular user changes slot count)
      const uid = this.auth.uid;
      if (uid) {
        const accountDoc = await firebaseDb.collection("accounts").doc(uid).get();
        if (accountDoc.exists) {
          const data = accountDoc.data();
          this._profiles = this._sanitizeProfiles(data.profiles);
          this._renderProfileSlots();
        }
      }

      // Hide link button since no longer a guest
      const linkBtn = this.overlay.querySelector("#auth-link-account");
      linkBtn.style.display = "none";
    } catch (err) {
      if (err.code === "auth/popup-closed-by-user") return;
      console.error("[AuthScreen] Link error:", err);
    }
  }

  // ========================
  // PROFILE MANAGEMENT
  // ========================

  _renderProfileSlots() {
    const container = this.overlay.querySelector("#auth-profile-slots");
    container.innerHTML = "";

    // Guests get 1 profile slot, authenticated users get 3
    const maxSlots = this.auth.isGuest ? 1 : 3;

    for (let i = 0; i < maxSlots; i++) {
      const profile = this._profiles[i];
      const slot = document.createElement("div");
      slot.className = "auth-profile-slot" + (profile ? ` has-profile faction-${profile.faction}` : " empty");
      slot.dataset.index = i;

      if (profile) {
        const avatarStyle = profile.profilePicture
          ? `background-image: url(${profile.profilePicture})`
          : "";
        const avatarClass = profile.profilePicture ? "profile-slot-avatar" : "profile-slot-avatar empty";
        slot.innerHTML = `
          <div class="${avatarClass}" style="${avatarStyle}"></div>
          <div class="profile-slot-info">
            <div class="profile-slot-name">${this._escapeHtml(profile.name)}</div>
            <div class="profile-slot-details">
              <span class="profile-slot-faction">${profile.faction}</span>
              <span class="profile-slot-level">Lv ${profile.level || 1}</span>
            </div>
          </div>
          <div class="profile-slot-actions">
            <button class="profile-slot-play" data-index="${i}">Play</button>
            <button class="profile-slot-edit" data-index="${i}" title="Edit profile">\u270E</button>
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
        slot.querySelector(".profile-slot-edit").addEventListener("click", (e) => {
          e.stopPropagation();
          this._startEditProfile(i);
        });
        slot.querySelector(".profile-slot-delete").addEventListener("click", (e) => {
          e.stopPropagation();
          this._deleteProfile(i);
        });
      } else {
        slot.addEventListener("click", (e) => {
          e.stopPropagation();
          this._showDeployScreen(i);
        });
      }
    }
  }

  async _selectProfile(index) {
    const uid = this.auth.uid;
    if (!uid) return;

    // Show loading on the Play button immediately
    const playBtn = this.overlay.querySelector(`.profile-slot-play[data-index="${index}"]`);
    if (playBtn) playBtn.textContent = "Loading...";
    this._setButtonsDisabled(true);

    try {
      // Load full profile data from Firestore
      const profileRef = firebaseDb
        .collection("accounts").doc(uid)
        .collection("profiles").doc(String(index));
      const profileDoc = await profileRef.get();

      if (!profileDoc.exists) {
        if (playBtn) playBtn.textContent = "Play";
        this._setButtonsDisabled(false);
        return;
      }

      // Update active profile index (fire and forget — non-blocking)
      firebaseDb.collection("accounts").doc(uid).update({
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
      if (playBtn) playBtn.textContent = "Play";
      this._setButtonsDisabled(false);
    }
  }

  _startEditProfile(index) {
    const profile = this._profiles[index];
    if (!profile) return;

    this._selectedIndex = index;
    this._selectedFaction = profile.faction;
    this._uploadedImage = profile.profilePicture || null;
    this._isEditMode = true;
    this._isAuthenticated = true;

    // Set title
    const title = this.overlay.querySelector("#auth-deploy-title");
    const subtitle = this.overlay.querySelector("#auth-deploy-subtitle");
    title.textContent = "Edit Profile";
    subtitle.textContent = "";

    // Show create section, hide auth providers
    this.overlay.querySelector("#auth-deploy-providers").classList.add("hidden");
    this.overlay.querySelector("#auth-deploy-create").classList.remove("hidden");

    // Update button text
    const confirmBtn = this.overlay.querySelector("#auth-create-confirm");
    confirmBtn.textContent = "Save";
    confirmBtn.disabled = false;

    // Pre-fill name
    this.overlay.querySelector("#auth-profile-name").value = profile.name || "";

    // Pre-fill avatar preview
    this.overlay.querySelector("#auth-avatar-file").value = "";
    const preview = this.overlay.querySelector("#auth-avatar-preview");
    if (profile.profilePicture) {
      preview.style.backgroundImage = `url(${profile.profilePicture})`;
      preview.classList.remove("empty");
      const uploadBtn = this.overlay.querySelector("#auth-avatar-upload-btn");
      if (uploadBtn) uploadBtn.textContent = "Change Picture";
    } else {
      this._resetAvatarPreview();
    }

    // Hide faction section (faction is permanent)
    this.overlay.querySelector("#auth-faction-section").style.display = "none";

    this._showStage("deploy");
    setTimeout(() => {
      this.overlay.querySelector("#auth-profile-name").focus();
    }, 100);
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

  // ========================
  // PROFILE SAVE
  // ========================

  async _handleCreateProfile() {
    const nameInput = this.overlay.querySelector("#auth-profile-name");
    const name = nameInput.value.trim();
    const faction = this._selectedFaction;
    const index = this._selectedIndex;
    const uid = this.auth.uid;

    if (!name || !faction || !uid || index < 0 || index > 2) return;

    // Validate name
    if (!/^[a-zA-Z0-9 _-]+$/.test(name)) {
      this._showError("auth-error", "Name can only contain letters, numbers, spaces, hyphens, underscores.");
      return;
    }

    this._setButtonsDisabled(true);
    const confirmBtn = this.overlay.querySelector("#auth-create-confirm");
    confirmBtn.textContent = this._isEditMode ? "Saving..." : "Creating...";

    try {
      if (this._isEditMode) {
        await this._saveEditedProfile(name, index, uid);
      } else {
        await this._saveNewProfile(name, faction, index, uid);
      }
    } catch (err) {
      console.error(`[AuthScreen] Failed to ${this._isEditMode ? "edit" : "create"} profile:`, err);
      confirmBtn.textContent = this._isEditMode ? "Save" : "Create Profile";
      this._setButtonsDisabled(false);
    }
  }

  async _saveNewProfile(name, faction, index, uid) {
    const now = firebase.firestore.FieldValue.serverTimestamp();

    const profileData = {
      name: name,
      faction: faction,
      profilePicture: this._uploadedImage || null,
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

    // Write profile + update account summary in parallel
    const profileSummary = { name, faction, level: 1, profilePicture: this._uploadedImage || null };
    const profilesUpdate = [...this._profiles];
    profilesUpdate[index] = profileSummary;

    await Promise.all([
      firebaseDb
        .collection("accounts").doc(uid)
        .collection("profiles").doc(String(index))
        .set(profileData),
      firebaseDb.collection("accounts").doc(uid).update({
        profiles: profilesUpdate,
        activeProfileIndex: index,
      }),
    ]);

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
  }

  async _saveEditedProfile(name, index, uid) {
    const profilePicture = this._uploadedImage || null;

    // Update only name and profilePicture in the profile doc
    const profileRef = firebaseDb
      .collection("accounts").doc(uid)
      .collection("profiles").doc(String(index));

    // Update account summary
    const profilesUpdate = [...this._profiles];
    profilesUpdate[index] = {
      ...profilesUpdate[index],
      name,
      profilePicture,
    };

    await Promise.all([
      profileRef.update({ name, profilePicture }),
      firebaseDb.collection("accounts").doc(uid).update({
        profiles: profilesUpdate,
      }),
    ]);

    this._profiles = profilesUpdate;
    this._renderProfileSlots();
    this._showStage("profiles");
  }

  // ========================
  // HELPERS
  // ========================

  _resetAvatarPreview() {
    const preview = this.overlay.querySelector("#auth-avatar-preview");
    preview.style.backgroundImage = "";
    preview.classList.add("empty");
    const uploadBtn = this.overlay.querySelector("#auth-avatar-upload-btn");
    if (uploadBtn) uploadBtn.textContent = "Upload Picture";
  }

  /**
   * Handle image file upload. Resizes to 64x64 on a canvas and stores as base64.
   * @param {File} file
   */
  _handleAvatarUpload(file) {
    if (!file || !file.type.startsWith("image/")) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Resize to 64x64 on canvas
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext("2d");

        // Cover-fit: crop to square center, then draw at 64x64
        const size = Math.min(img.width, img.height);
        const sx = (img.width - size) / 2;
        const sy = (img.height - size) / 2;
        ctx.drawImage(img, sx, sy, size, size, 0, 0, 64, 64);

        const dataUrl = canvas.toDataURL("image/png");
        this._uploadedImage = dataUrl;

        // Show preview
        const preview = this.overlay.querySelector("#auth-avatar-preview");
        preview.style.backgroundImage = `url(${dataUrl})`;
        preview.classList.remove("empty");

        // Update upload button text
        const uploadBtn = this.overlay.querySelector("#auth-avatar-upload-btn");
        if (uploadBtn) uploadBtn.textContent = "Change Picture";

        this._updateCreateState();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
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
    const valid = this._isEditMode
      ? name.length > 0
      : name.length > 0 && this._selectedFaction !== null;
    this.overlay.querySelector("#auth-create-confirm").disabled = !valid;
  }

  /**
   * Sanitize profiles array from Firestore.
   * Entries without valid name+faction are treated as empty slots.
   */
  _sanitizeProfiles(profiles) {
    if (!Array.isArray(profiles)) {
      return this.auth.isGuest ? [null] : [null, null, null];
    }
    const maxSlots = this.auth.isGuest ? 1 : 3;
    return Array.from({ length: maxSlots }, (_, i) => {
      const p = profiles[i];
      if (p && typeof p.name === "string" && p.name.length > 0 && p.faction) {
        return p;
      }
      return null;
    });
  }

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
