/**
 * AdLands - AuthManager
 * Client-side Firebase Auth state management.
 * Handles sign-in/sign-out for all providers, token refresh for long sessions,
 * and exposes auth state to the rest of the game.
 */

class AuthManager {
  constructor() {
    /** @type {firebase.User|null} */
    this.user = null;

    /** @type {string|null} Current Firebase ID token */
    this.idToken = null;

    /** @type {boolean} Whether auth state has been resolved (initial check done) */
    this.ready = false;

    /** @type {Function|null} Called when auth state changes: (user) => {} */
    this.onAuthStateChanged = null;

    // Token refresh interval (45 min — tokens expire at 60 min)
    this._refreshInterval = null;
    this._REFRESH_MS = 45 * 60 * 1000;

    // Listen for Firebase auth state changes
    firebaseAuth.onAuthStateChanged((user) => {
      this.user = user;
      this.ready = true;

      if (user) {
        this._startTokenRefresh();
        // Get initial token
        user.getIdToken().then((token) => {
          this.idToken = token;
          if (this.onAuthStateChanged) this.onAuthStateChanged(user);
        });
      } else {
        this._stopTokenRefresh();
        this.idToken = null;
        if (this.onAuthStateChanged) this.onAuthStateChanged(null);
      }
    });
  }

  // ========================
  // SIGN-IN METHODS
  // ========================

  /**
   * Sign in with email and password.
   * @param {string} email
   * @param {string} password
   * @returns {Promise<firebase.auth.UserCredential>}
   */
  async signInWithEmail(email, password) {
    return firebaseAuth.signInWithEmailAndPassword(email, password);
  }

  /**
   * Create a new account with email and password.
   * @param {string} email
   * @param {string} password
   * @returns {Promise<firebase.auth.UserCredential>}
   */
  async createAccountWithEmail(email, password) {
    return firebaseAuth.createUserWithEmailAndPassword(email, password);
  }

  /**
   * Send a password reset email.
   * @param {string} email
   */
  async sendPasswordReset(email) {
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error("Failed to send reset email.");
  }

  /**
   * Sign in with Google popup.
   * @returns {Promise<firebase.auth.UserCredential>}
   */
  async signInWithGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    return firebaseAuth.signInWithPopup(provider);
  }

  /**
   * Sign in with Apple popup.
   * @returns {Promise<firebase.auth.UserCredential>}
   */
  async signInWithApple() {
    const provider = new firebase.auth.OAuthProvider("apple.com");
    return firebaseAuth.signInWithPopup(provider);
  }

  /**
   * Sign in with GitHub popup.
   * @returns {Promise<firebase.auth.UserCredential>}
   */
  async signInWithGitHub() {
    const provider = new firebase.auth.GithubAuthProvider();
    return firebaseAuth.signInWithPopup(provider);
  }

  /**
   * Sign in with Twitter/X popup.
   * @returns {Promise<firebase.auth.UserCredential>}
   */
  async signInWithTwitter() {
    const provider = new firebase.auth.TwitterAuthProvider();
    return firebaseAuth.signInWithPopup(provider);
  }

  /**
   * Sign in with phone number (requires RecaptchaVerifier).
   * @param {string} phoneNumber - E.164 format, e.g. "+1234567890"
   * @param {firebase.auth.RecaptchaVerifier} recaptchaVerifier
   * @returns {Promise<firebase.auth.ConfirmationResult>}
   */
  async signInWithPhone(phoneNumber, recaptchaVerifier) {
    return firebaseAuth.signInWithPhoneNumber(phoneNumber, recaptchaVerifier);
  }

  /**
   * Sign in anonymously (Guest mode).
   * @returns {Promise<firebase.auth.UserCredential>}
   */
  async signInAsGuest() {
    return firebaseAuth.signInAnonymously();
  }

  /**
   * Link an anonymous account with a permanent provider credential.
   * Preserves all existing data under the same UID.
   * @param {firebase.auth.AuthCredential} credential
   * @returns {Promise<firebase.auth.UserCredential>}
   */
  async linkWithCredential(credential) {
    if (!this.user) throw new Error("No user signed in");
    return this.user.linkWithCredential(credential);
  }

  /**
   * Link current anonymous user with Google.
   * @returns {Promise<firebase.auth.UserCredential>}
   */
  async linkWithGoogle() {
    if (!this.user) throw new Error("No user signed in");
    const provider = new firebase.auth.GoogleAuthProvider();
    return this.user.linkWithPopup(provider);
  }

  // ========================
  // SIGN OUT
  // ========================

  async signOut() {
    this._stopTokenRefresh();
    return firebaseAuth.signOut();
  }

  // ========================
  // TOKEN MANAGEMENT
  // ========================

  /**
   * Get a fresh ID token (force refresh if needed).
   * @param {boolean} forceRefresh
   * @returns {Promise<string|null>}
   */
  async getToken(forceRefresh = false) {
    if (!this.user) return null;
    try {
      this.idToken = await this.user.getIdToken(forceRefresh);
      return this.idToken;
    } catch (err) {
      console.warn("[AuthManager] Failed to get token:", err.message);
      return null;
    }
  }

  _startTokenRefresh() {
    this._stopTokenRefresh();
    this._refreshInterval = setInterval(() => {
      this.getToken(true).then((token) => {
        if (token && window.networkManager && window.networkManager.connected) {
          window.networkManager.sendRefreshToken(token);
        }
      });
    }, this._REFRESH_MS);
  }

  _stopTokenRefresh() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
  }

  // ========================
  // HELPERS
  // ========================

  /** @returns {boolean} Whether the user is signed in */
  get isSignedIn() {
    return this.user !== null;
  }

  /** @returns {boolean} Whether the user is anonymous (Guest) */
  get isGuest() {
    return this.user?.isAnonymous === true;
  }

  /** @returns {string|null} Firebase UID */
  get uid() {
    return this.user?.uid || null;
  }

  /** @returns {string|null} Display name from auth provider */
  get displayName() {
    return this.user?.displayName || null;
  }

  /** @returns {string|null} Email from auth provider */
  get email() {
    return this.user?.email || null;
  }

  /** @returns {string|null} Photo URL from auth provider */
  get photoURL() {
    return this.user?.photoURL || null;
  }

  /** @returns {string[]} List of linked provider IDs */
  get linkedProviders() {
    if (!this.user) return [];
    return this.user.providerData.map((p) => p.providerId);
  }

  /**
   * Wait for initial auth state to be resolved.
   * @returns {Promise<firebase.User|null>}
   */
  waitForReady() {
    if (this.ready) return Promise.resolve(this.user);
    return new Promise((resolve) => {
      const unsub = firebaseAuth.onAuthStateChanged((user) => {
        unsub();
        resolve(user);
      });
    });
  }
}
