/**
 * AdLands - Onboarding Screen
 * Name & faction selection screen shown after loading, before portal selection.
 * 3 faction orbs orbit slowly around a central name input.
 */

class OnboardingScreen {
  constructor() {
    this.selectedFaction = null;
    this.onConfirm = null; // callback: ({ name, faction }) => {}

    this._createUI();
    this._setupEvents();
  }

  _createUI() {
    this.overlay = document.createElement("div");
    this.overlay.id = "onboarding-screen";
    this.overlay.className = "onboarding-hidden";

    this.overlay.innerHTML = `
      <div class="onboarding-panel">
        <div class="onboarding-title">Deploy As</div>

        <div class="onboarding-orbit">
          <div class="onboarding-name-center">
            <input type="text" id="onboarding-name-input"
                   class="onboarding-input"
                   placeholder="Enter name..."
                   maxlength="20"
                   autocomplete="off"
                   spellcheck="false">
          </div>
          <div class="onboarding-orbit-ring">
            <div class="faction-orb-anchor" style="--orb-angle: 0deg">
              <button class="faction-orb" data-faction="rust" style="--faction-color: var(--rust)">
                <span class="faction-orb-label">Rust</span>
              </button>
            </div>
            <div class="faction-orb-anchor" style="--orb-angle: 120deg">
              <button class="faction-orb" data-faction="cobalt" style="--faction-color: var(--cobalt)">
                <span class="faction-orb-label">Cobalt</span>
              </button>
            </div>
            <div class="faction-orb-anchor" style="--orb-angle: 240deg">
              <button class="faction-orb" data-faction="viridian" style="--faction-color: var(--viridian)">
                <span class="faction-orb-label">Viridian</span>
              </button>
            </div>
          </div>
        </div>

        <button class="onboarding-confirm" id="onboarding-confirm" disabled>
          Deploy
        </button>
      </div>
    `;

    document.body.appendChild(this.overlay);

    this.nameInput = this.overlay.querySelector("#onboarding-name-input");
    this.confirmBtn = this.overlay.querySelector("#onboarding-confirm");
    this.orbs = this.overlay.querySelectorAll(".faction-orb");
  }

  _setupEvents() {
    // Faction orb clicks
    this.orbs.forEach((orb) => {
      orb.addEventListener("click", (e) => {
        e.stopPropagation();
        const faction = orb.dataset.faction;
        this._selectFaction(faction);
      });
    });

    // Name input validation
    this.nameInput.addEventListener("input", () => {
      this._updateConfirmState();
    });

    // Enter key to confirm
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.confirmBtn.disabled) {
        this._confirm();
      }
    });

    // Confirm button
    this.confirmBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._confirm();
    });

    // Prevent game input while onboarding is active
    this.overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
    });
    this.overlay.addEventListener("keyup", (e) => {
      e.stopPropagation();
    });
  }

  _selectFaction(faction) {
    this.selectedFaction = faction;

    // Update orb visuals
    this.orbs.forEach((orb) => {
      if (orb.dataset.faction === faction) {
        orb.classList.add("selected");
      } else {
        orb.classList.remove("selected");
      }
    });

    // Add class to orbit container so unselected orbs dim
    const orbit = this.overlay.querySelector(".onboarding-orbit");
    orbit.classList.add("has-selection");

    this._updateConfirmState();
  }

  _updateConfirmState() {
    const name = this.nameInput.value.trim();
    const valid = name.length > 0 && this.selectedFaction !== null;
    this.confirmBtn.disabled = !valid;
  }

  _confirm() {
    if (this.confirmBtn.disabled) return;

    const name = this.nameInput.value.trim();
    if (!name || !this.selectedFaction) return;

    // Disable to prevent double-submit
    this.confirmBtn.disabled = true;
    this.confirmBtn.textContent = "Deploying...";

    if (this.onConfirm) {
      this.onConfirm({ name, faction: this.selectedFaction });
    }
  }

  show() {
    this.overlay.classList.remove("onboarding-hidden");
    // Focus name input after a brief delay (let transition start)
    setTimeout(() => {
      this.nameInput.focus();
    }, 100);
  }

  hide(callback) {
    this.overlay.classList.add("onboarding-fade-out");
    setTimeout(() => {
      this.overlay.classList.add("onboarding-hidden");
      this.overlay.classList.remove("onboarding-fade-out");
      if (callback) callback();
    }, 400);
  }
}
