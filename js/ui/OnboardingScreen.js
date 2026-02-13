/**
 * AdLands - Onboarding Screen
 * Name & faction selection screen shown after loading, before portal selection.
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

        <input type="text" id="onboarding-name-input"
               class="onboarding-input"
               placeholder="Enter name..."
               maxlength="20"
               autocomplete="off"
               spellcheck="false">

        <div class="onboarding-faction-prompt">Choose Faction</div>
        <div class="onboarding-factions">
          <button class="faction-btn" data-faction="rust">Rust</button>
          <button class="faction-btn" data-faction="cobalt">Cobalt</button>
          <button class="faction-btn" data-faction="viridian">Viridian</button>
        </div>

        <button class="onboarding-confirm" id="onboarding-confirm" disabled>
          Deploy
        </button>
      </div>
    `;

    document.body.appendChild(this.overlay);

    this.nameInput = this.overlay.querySelector("#onboarding-name-input");
    this.confirmBtn = this.overlay.querySelector("#onboarding-confirm");
    this.factionBtns = this.overlay.querySelectorAll(".faction-btn");
  }

  _setupEvents() {
    // Faction button clicks
    this.factionBtns.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._selectFaction(btn.dataset.faction);
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

    this.factionBtns.forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.faction === faction);
    });

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
