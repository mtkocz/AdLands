class SoundManager {
  constructor() {
    this.ctx = null;
    this._unlocked = false;
    this._buffers = new Map();
    this._masterGain = null;
    this._sfxGain = null;
    this._uiGain = null;
    this._musicGain = null;
    this._ambientGain = null;
    this._uiEnabled = true;

    this._manifest = {
      ui: [],
      gameplay: [],
      ambient: [],
    };

    this._setupUnlock();
  }

  _setupUnlock() {
    const unlock = () => {
      if (this._unlocked) return;
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._masterGain = this.ctx.createGain();
      this._masterGain.connect(this.ctx.destination);

      this._sfxGain = this.ctx.createGain();
      this._sfxGain.connect(this._masterGain);

      this._uiGain = this.ctx.createGain();
      this._uiGain.connect(this._masterGain);

      this._musicGain = this.ctx.createGain();
      this._musicGain.connect(this._masterGain);

      this._ambientGain = this.ctx.createGain();
      this._ambientGain.connect(this._masterGain);

      if (this.ctx.state === "suspended") {
        this.ctx.resume();
      }

      this._unlocked = true;
      document.removeEventListener("mousedown", unlock);
      document.removeEventListener("keydown", unlock);
      document.removeEventListener("touchstart", unlock);

      this._loadAll();
    };

    document.addEventListener("mousedown", unlock);
    document.addEventListener("keydown", unlock);
    document.addEventListener("touchstart", unlock);
  }

  /** @param {{ master: number, sfx: number, music: number, uiSounds: boolean }} settings */
  applySettings(settings) {
    if (!this.ctx) return;
    this._masterGain.gain.value = settings.master;
    this._sfxGain.gain.value = settings.sfx;
    this._uiGain.gain.value = settings.sfx;
    this._musicGain.gain.value = settings.music;
    this._ambientGain.gain.value = settings.sfx;
    this._uiEnabled = settings.uiSounds;
  }

  /**
   * Register sounds to load. Call before AudioContext is unlocked.
   * @param {'ui'|'gameplay'|'ambient'} category
   * @param {string[]} names - filenames without extension (e.g. 'click', 'confirm')
   */
  register(category, names) {
    for (const name of names) {
      if (!this._manifest[category].includes(name)) {
        this._manifest[category].push(name);
      }
    }
    if (this._unlocked) {
      this._loadCategory(category);
    }
  }

  _loadAll() {
    for (const category of Object.keys(this._manifest)) {
      this._loadCategory(category);
    }
  }

  _loadCategory(category) {
    for (const name of this._manifest[category]) {
      const key = `${category}/${name}`;
      if (this._buffers.has(key)) continue;
      this._loadSound(key, `assets/sfx/${key}.mp3`);
    }
  }

  async _loadSound(key, url) {
    try {
      const response = await fetch(url);
      if (!response.ok) return;
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
      this._buffers.set(key, audioBuffer);
    } catch (e) {
      // Sound file not found or decode failed — silent fail
    }
  }

  /**
   * Play a sound effect
   * @param {'ui'|'gameplay'|'ambient'} category
   * @param {string} name
   * @param {{ volume?: number, pitch?: number, loop?: boolean }} [opts]
   * @returns {AudioBufferSourceNode|null}
   */
  play(category, name, opts = {}) {
    if (!this.ctx) return null;
    if (category === "ui" && !this._uiEnabled) return null;

    const key = `${category}/${name}`;
    const buffer = this._buffers.get(key);
    if (!buffer) return null;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = opts.loop || false;

    if (opts.pitch) {
      source.playbackRate.value = opts.pitch;
    }

    const gainNode = this.ctx.createGain();
    gainNode.gain.value = opts.volume !== undefined ? opts.volume : 1.0;

    const routeGain = this._getRouteGain(category);
    source.connect(gainNode);
    gainNode.connect(routeGain);

    source.start(0);
    return source;
  }

  _getRouteGain(category) {
    switch (category) {
      case "ui":
        return this._uiGain;
      case "gameplay":
        return this._sfxGain;
      case "ambient":
        return this._ambientGain;
      default:
        return this._sfxGain;
    }
  }

  /** Shared AudioContext for systems that synthesize their own sounds */
  getAudioContext() {
    return this.ctx;
  }
}
