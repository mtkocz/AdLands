/**
 * AdLands - Reward Configuration Module
 * Handles dynamic reward rows with accomplishment/reward type configuration
 */

class RewardConfig {
    constructor(options = {}) {
        this.containerElement = document.getElementById('rewards-list');
        this.addButton = document.getElementById('add-reward-btn');

        // Reward data
        this.rewards = [];
        this.rewardCounter = 0;

        // Accomplishment types
        this.accomplishmentTypes = [
            { value: 'capture', label: 'Capture' },
            { value: 'hold_1m', label: 'Hold 1 Minute' },
            { value: 'hold_5m', label: 'Hold 5 Minutes' },
            { value: 'hold_10m', label: 'Hold 10 Minutes' },
            { value: 'hold_1h', label: 'Hold 1 Hour' },
            { value: 'hold_6h', label: 'Hold 6 Hours' },
            { value: 'hold_12h', label: 'Hold 12 Hours' },
            { value: 'hold_24h', label: 'Hold 24 Hours' }
        ];

        // Reward types
        this.rewardTypes = [
            { value: 'crypto', label: 'Crypto (¢)' },
            { value: 'cosmetic', label: 'Cosmetic Item' },
            { value: 'coupon', label: 'Coupon Code' }
        ];

        // Placeholder cosmetics
        this.cosmeticOptions = [
            { value: 'skin_chrome', label: 'Tank Skin - Chrome' },
            { value: 'skin_gold', label: 'Tank Skin - Gold' },
            { value: 'skin_camo', label: 'Tank Skin - Camo' },
            { value: 'decal_pack_a', label: 'Decal Pack A' },
            { value: 'decal_pack_b', label: 'Decal Pack B' },
            { value: 'trail_fire', label: 'Trail Effect - Fire' },
            { value: 'trail_ice', label: 'Trail Effect - Ice' },
            { value: 'trail_lightning', label: 'Trail Effect - Lightning' }
        ];

        // Callbacks
        this.onRewardsChange = options.onRewardsChange || null;

        this._setupEventListeners();
    }

    _setupEventListeners() {
        this.addButton.addEventListener('click', () => {
            this.addReward();
        });
    }

    _createRewardRow(rewardData = null) {
        const rowId = `reward-row-${this.rewardCounter++}`;
        const row = document.createElement('div');
        row.className = 'reward-row';
        row.id = rowId;

        // Accomplishment select
        const accomplishmentSelect = document.createElement('select');
        accomplishmentSelect.className = 'accomplishment-select';
        accomplishmentSelect.innerHTML = this.accomplishmentTypes
            .map(t => `<option value="${t.value}"${rewardData?.accomplishment === t.value ? ' selected' : ''}>${t.label}</option>`)
            .join('');

        // Reward type select
        const rewardTypeSelect = document.createElement('select');
        rewardTypeSelect.className = 'reward-type-select';
        rewardTypeSelect.innerHTML = this.rewardTypes
            .map(t => `<option value="${t.value}"${rewardData?.rewardType === t.value ? ' selected' : ''}>${t.label}</option>`)
            .join('');

        // Value container (changes based on reward type)
        const valueContainer = document.createElement('div');
        valueContainer.className = 'reward-value-group';

        // Remove button
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-reward-btn';
        removeBtn.type = 'button';
        removeBtn.innerHTML = '&times;';
        removeBtn.title = 'Remove reward';

        // Append elements
        row.appendChild(accomplishmentSelect);
        row.appendChild(rewardTypeSelect);
        row.appendChild(valueContainer);
        row.appendChild(removeBtn);

        // Event listeners
        rewardTypeSelect.addEventListener('change', () => {
            this._updateValueInput(valueContainer, rewardTypeSelect.value, rewardData);
            this._emitChange();
        });

        accomplishmentSelect.addEventListener('change', () => {
            this._emitChange();
        });

        removeBtn.addEventListener('click', () => {
            row.remove();
            this._emitChange();
        });

        // Initialize value input
        this._updateValueInput(valueContainer, rewardTypeSelect.value, rewardData);

        return row;
    }

    _updateValueInput(container, rewardType, existingData = null) {
        container.innerHTML = '';

        switch (rewardType) {
            case 'crypto':
                const cryptoInput = document.createElement('input');
                cryptoInput.type = 'number';
                cryptoInput.className = 'crypto-value';
                cryptoInput.min = 1;
                cryptoInput.max = 10000;
                cryptoInput.placeholder = 'Crypto amount';
                cryptoInput.value = existingData?.rewardValue || 100;
                cryptoInput.addEventListener('input', () => this._emitChange());
                container.appendChild(cryptoInput);
                break;

            case 'cosmetic':
                const cosmeticSelect = document.createElement('select');
                cosmeticSelect.className = 'cosmetic-select';
                cosmeticSelect.innerHTML = this.cosmeticOptions
                    .map(c => `<option value="${c.value}"${existingData?.rewardDetails?.cosmeticId === c.value ? ' selected' : ''}>${c.label}</option>`)
                    .join('');
                cosmeticSelect.addEventListener('change', () => this._emitChange());
                container.appendChild(cosmeticSelect);
                break;

            case 'coupon':
                const codeInput = document.createElement('input');
                codeInput.type = 'text';
                codeInput.className = 'coupon-code';
                codeInput.placeholder = 'Coupon code';
                codeInput.value = existingData?.rewardDetails?.code || '';
                codeInput.addEventListener('input', () => this._emitChange());

                const descInput = document.createElement('input');
                descInput.type = 'text';
                descInput.className = 'coupon-description';
                descInput.placeholder = 'Description (e.g., 20% off)';
                descInput.value = existingData?.rewardDetails?.description || '';
                descInput.addEventListener('input', () => this._emitChange());

                container.appendChild(codeInput);
                container.appendChild(descInput);
                break;
        }
    }

    _parseRewardRow(row) {
        const accomplishment = row.querySelector('.accomplishment-select').value;
        const rewardType = row.querySelector('.reward-type-select').value;
        let rewardValue = null;
        let rewardDetails = null;

        switch (rewardType) {
            case 'crypto':
                const cryptoInput = row.querySelector('.crypto-value');
                rewardValue = parseInt(cryptoInput?.value) || 0;
                break;

            case 'cosmetic':
                const cosmeticSelect = row.querySelector('.cosmetic-select');
                rewardValue = 1;
                rewardDetails = {
                    cosmeticId: cosmeticSelect?.value || ''
                };
                break;

            case 'coupon':
                const codeInput = row.querySelector('.coupon-code');
                const descInput = row.querySelector('.coupon-description');
                rewardValue = 1;
                rewardDetails = {
                    code: codeInput?.value || '',
                    description: descInput?.value || ''
                };
                break;
        }

        return {
            accomplishment,
            rewardType,
            rewardValue,
            rewardDetails
        };
    }

    _emitChange() {
        if (this.onRewardsChange) {
            this.onRewardsChange(this.getRewards());
        }
    }

    // ========================
    // PUBLIC METHODS
    // ========================

    /**
     * Add a new reward row
     * @param {Object} rewardData - Optional existing reward data
     */
    addReward(rewardData = null) {
        const row = this._createRewardRow(rewardData);
        this.containerElement.appendChild(row);
        this._emitChange();
    }

    /**
     * Get all configured rewards
     * @returns {Array}
     */
    getRewards() {
        const rows = this.containerElement.querySelectorAll('.reward-row');
        const rewards = [];

        rows.forEach(row => {
            rewards.push(this._parseRewardRow(row));
        });

        return rewards;
    }

    /**
     * Validate all rewards
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validate() {
        const rewards = this.getRewards();
        const errors = [];
        const accomplishments = new Set();

        rewards.forEach((reward, index) => {
            const num = index + 1;

            // Check for duplicate accomplishments
            if (accomplishments.has(reward.accomplishment)) {
                const label = this.accomplishmentTypes.find(t => t.value === reward.accomplishment)?.label;
                errors.push(`Reward ${num}: Duplicate accomplishment "${label}"`);
            }
            accomplishments.add(reward.accomplishment);

            // Validate based on type
            if (reward.rewardType === 'crypto') {
                if (!reward.rewardValue || reward.rewardValue < 1) {
                    errors.push(`Reward ${num}: Crypto value must be at least 1`);
                }
                if (reward.rewardValue > 10000) {
                    errors.push(`Reward ${num}: Crypto value cannot exceed 10,000`);
                }
            }

            if (reward.rewardType === 'coupon') {
                if (!reward.rewardDetails?.code || reward.rewardDetails.code.trim().length === 0) {
                    errors.push(`Reward ${num}: Coupon code is required`);
                }
            }
        });

        return { valid: errors.length === 0, errors };
    }

    /**
     * Load rewards from an array
     * @param {Array} rewards
     */
    loadRewards(rewards) {
        this.clear();
        if (rewards && Array.isArray(rewards)) {
            rewards.forEach(reward => {
                this.addReward(reward);
            });
        }
    }

    /**
     * Clear all reward rows
     */
    clear() {
        this.containerElement.innerHTML = '';
        this._emitChange();
    }

    /**
     * Get the count of configured rewards
     * @returns {number}
     */
    getRewardCount() {
        return this.containerElement.querySelectorAll('.reward-row').length;
    }
}
