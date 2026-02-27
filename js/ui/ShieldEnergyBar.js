/**
 * ShieldEnergyBar — HUD element showing shield energy drain/recharge.
 * Appears near bottom-center when shield is active or energy < 100%.
 */
class ShieldEnergyBar {
  constructor() {
    this._container = document.createElement('div');
    this._container.id = 'shield-energy-bar';
    this._container.style.cssText = [
      'position:fixed',
      'bottom:60px',
      'left:50%',
      'transform:translateX(-50%)',
      'width:120px',
      'height:6px',
      'background:rgba(0,0,0,0.6)',
      'border:1px solid var(--accent-cyan, #0ff)',
      'opacity:0',
      'transition:opacity 0.2s',
      'pointer-events:none',
      'z-index:100',
      'image-rendering:pixelated',
    ].join(';');

    this._fill = document.createElement('div');
    this._fill.style.cssText = [
      'width:100%',
      'height:100%',
      'background:var(--accent-cyan, #0ff)',
      'transition:width 0.08s linear',
    ].join(';');

    this._container.appendChild(this._fill);
    document.body.appendChild(this._container);
  }

  update(energy, active) {
    this._fill.style.width = (energy * 100) + '%';
    this._container.style.opacity = (active || energy < 0.99) ? '1' : '0';
    // Red when low
    this._fill.style.background = energy > 0.2
      ? 'var(--accent-cyan, #0ff)'
      : 'var(--danger, #f44)';
  }

  dispose() {
    if (this._container.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
  }
}
