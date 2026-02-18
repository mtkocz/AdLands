/**
 * AdLands - Sponsor Form Module
 * Handles sponsor information form inputs and image uploads
 */

class SponsorForm {
    constructor(options = {}) {
        // Form elements
        this.formElement = document.getElementById('sponsor-form');
        this.nameInput = document.getElementById('sponsor-name');
        this.taglineInput = document.getElementById('sponsor-tagline');
        this.websiteInput = document.getElementById('sponsor-website');
        this.logoInput = document.getElementById('logo-input');
        this.patternInput = document.getElementById('pattern-input');
        this.logoPreview = document.getElementById('logo-preview');
        this.patternPreview = document.getElementById('pattern-preview');

        // Territory-specific info fields (per-territory for player groups)
        this.territoryInfoFields = document.getElementById('territory-info-fields');
        this.territoryNameInput = document.getElementById('territory-name');
        this.territoryTaglineInput = document.getElementById('territory-tagline');
        this.territoryWebsiteInput = document.getElementById('territory-website');

        // Notes field (player territory groups only)
        this.notesFieldGroup = document.getElementById('notes-field-group');
        this.notesInput = document.getElementById('sponsor-notes');

        // Pattern adjustment elements
        this.patternAdjustGroup = document.getElementById('pattern-adjust-group');
        this.patternScaleSlider = document.getElementById('pattern-scale');
        this.patternScaleValue = document.getElementById('pattern-scale-value');
        this.patternPreviewContainer = document.getElementById('pattern-preview-container');
        this.patternPreviewLarge = document.getElementById('pattern-preview-large');
        this.resetPatternBtn = document.getElementById('reset-pattern-btn');

        // Input levels elements
        this.patternInputBlackSlider = document.getElementById('pattern-input-black');
        this.patternInputBlackValue = document.getElementById('pattern-input-black-value');
        this.patternInputGammaSlider = document.getElementById('pattern-input-gamma');
        this.patternInputGammaValue = document.getElementById('pattern-input-gamma-value');
        this.patternInputWhiteSlider = document.getElementById('pattern-input-white');
        this.patternInputWhiteValue = document.getElementById('pattern-input-white-value');

        // Output levels elements
        this.patternOutputBlackSlider = document.getElementById('pattern-output-black');
        this.patternOutputBlackValue = document.getElementById('pattern-output-black-value');
        this.patternOutputWhiteSlider = document.getElementById('pattern-output-white');
        this.patternOutputWhiteValue = document.getElementById('pattern-output-white-value');

        // Saturation element
        this.patternSaturationSlider = document.getElementById('pattern-saturation');
        this.patternSaturationValue = document.getElementById('pattern-saturation-value');

        // Image data (base64)
        this.logoImageData = null;
        this.patternImageData = null;

        // Pattern adjustment values
        this.patternScale = 1.0;
        this.patternOffsetX = 0;  // -1 to 1 (percentage of image width)
        this.patternOffsetY = 0;  // -1 to 1 (percentage of image height)

        // Input levels values (Photoshop-style)
        this.patternInputBlack = 0;      // 0 to 255 (input black point)
        this.patternInputGamma = 1.0;    // 0.1 to 3.0 (gamma/midtone)
        this.patternInputWhite = 255;    // 0 to 255 (input white point)

        // Output levels values
        this.patternOutputBlack = 0;     // 0 to 255 (output black point)
        this.patternOutputWhite = 255;   // 0 to 255 (output white point)

        // Saturation value
        this.patternSaturation = 1.0;    // 0 to 2 (1.0 = normal)

        // Drag state
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.dragStartOffsetX = 0;
        this.dragStartOffsetY = 0;

        // Current editing sponsor ID (null for new)
        this.editingSponsorId = null;

        // Callbacks
        this.onFormChange = options.onFormChange || null;
        // Separate callback for adjustment-only changes (sliders) — avoids full texture reload
        this.onAdjustmentChange = options.onAdjustmentChange || null;

        // Throttle timer for slider-driven changes
        this._adjustThrottleTimer = null;
        this._adjustThrottleDelay = 30; // ~33fps max for slider updates

        this._setupEventListeners();
    }

    _setupEventListeners() {
        // File input change handlers
        this.logoInput.addEventListener('change', (e) => {
            this._handleFileUpload(e.target.files[0], 'logo');
        });

        this.patternInput.addEventListener('change', (e) => {
            this._handleFileUpload(e.target.files[0], 'pattern');
        });

        // Form input changes
        [this.nameInput, this.taglineInput, this.websiteInput].forEach(input => {
            input.addEventListener('input', () => {
                if (this.onFormChange) {
                    this.onFormChange(this.getFormData());
                }
            });
        });

        // Pattern scale slider
        this.patternScaleSlider.addEventListener('input', (e) => {
            this.patternScale = parseFloat(e.target.value);
            this.patternScaleValue.textContent = this.patternScale.toFixed(2) + 'x';
            this._updatePatternPreviewTransform();
            this._fireAdjustmentChange();
        });

        // Pattern position drag
        this.patternPreviewContainer.addEventListener('mousedown', (e) => {
            if (!this.patternImageData) return;
            this.isDragging = true;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            this.dragStartOffsetX = this.patternOffsetX;
            this.dragStartOffsetY = this.patternOffsetY;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!this.isDragging) return;

            const containerRect = this.patternPreviewContainer.getBoundingClientRect();
            const dx = (e.clientX - this.dragStartX) / containerRect.width;
            const dy = (e.clientY - this.dragStartY) / containerRect.height;

            this.patternOffsetX = Math.max(-1, Math.min(1, this.dragStartOffsetX + dx));
            this.patternOffsetY = Math.max(-1, Math.min(1, this.dragStartOffsetY + dy));

            this._updatePatternPreviewTransform();
            // Update hex sphere in real-time during drag
            this._fireAdjustmentChange();
        });

        document.addEventListener('mouseup', () => {
            if (this.isDragging) {
                this.isDragging = false;
                // Final adjustment update (flush any pending throttled change)
                this._fireAdjustmentChange();
            }
        });

        // Reset pattern button
        this.resetPatternBtn.addEventListener('click', () => {
            this.patternScale = 1.0;
            this.patternOffsetX = 0;
            this.patternOffsetY = 0;
            this.patternScaleSlider.value = 1.0;
            this.patternScaleValue.textContent = '1.00x';
            // Reset input levels
            this.patternInputBlack = 0;
            this.patternInputGamma = 1.0;
            this.patternInputWhite = 255;
            this.patternInputBlackSlider.value = 0;
            this.patternInputBlackValue.textContent = '0';
            this.patternInputGammaSlider.value = 1.0;
            this.patternInputGammaValue.textContent = '1.00';
            this.patternInputWhiteSlider.value = 255;
            this.patternInputWhiteValue.textContent = '255';
            // Reset output levels
            this.patternOutputBlack = 0;
            this.patternOutputWhite = 255;
            this.patternOutputBlackSlider.value = 0;
            this.patternOutputBlackValue.textContent = '0';
            this.patternOutputWhiteSlider.value = 255;
            this.patternOutputWhiteValue.textContent = '255';
            // Reset saturation
            this.patternSaturation = 1.0;
            this.patternSaturationSlider.value = 1.0;
            this.patternSaturationValue.textContent = '1.00';
            this._updatePatternPreviewTransform();
            this._updatePatternPreviewColors();
            this._fireAdjustmentChange();
        });

        // Input levels sliders
        this.patternInputBlackSlider.addEventListener('input', (e) => {
            this.patternInputBlack = parseInt(e.target.value);
            if (this.patternInputBlack >= this.patternInputWhite) {
                this.patternInputBlack = this.patternInputWhite - 1;
                this.patternInputBlackSlider.value = this.patternInputBlack;
            }
            this.patternInputBlackValue.textContent = this.patternInputBlack;
            this._updatePatternPreviewColors();
            this._fireAdjustmentChange();
        });

        this.patternInputGammaSlider.addEventListener('input', (e) => {
            this.patternInputGamma = parseFloat(e.target.value);
            this.patternInputGammaValue.textContent = this.patternInputGamma.toFixed(2);
            this._updatePatternPreviewColors();
            this._fireAdjustmentChange();
        });

        this.patternInputWhiteSlider.addEventListener('input', (e) => {
            this.patternInputWhite = parseInt(e.target.value);
            if (this.patternInputWhite <= this.patternInputBlack) {
                this.patternInputWhite = this.patternInputBlack + 1;
                this.patternInputWhiteSlider.value = this.patternInputWhite;
            }
            this.patternInputWhiteValue.textContent = this.patternInputWhite;
            this._updatePatternPreviewColors();
            this._fireAdjustmentChange();
        });

        // Output levels sliders
        this.patternOutputBlackSlider.addEventListener('input', (e) => {
            this.patternOutputBlack = parseInt(e.target.value);
            if (this.patternOutputBlack >= this.patternOutputWhite) {
                this.patternOutputBlack = this.patternOutputWhite - 1;
                this.patternOutputBlackSlider.value = this.patternOutputBlack;
            }
            this.patternOutputBlackValue.textContent = this.patternOutputBlack;
            this._updatePatternPreviewColors();
            this._fireAdjustmentChange();
        });

        this.patternOutputWhiteSlider.addEventListener('input', (e) => {
            this.patternOutputWhite = parseInt(e.target.value);
            if (this.patternOutputWhite <= this.patternOutputBlack) {
                this.patternOutputWhite = this.patternOutputBlack + 1;
                this.patternOutputWhiteSlider.value = this.patternOutputWhite;
            }
            this.patternOutputWhiteValue.textContent = this.patternOutputWhite;
            this._updatePatternPreviewColors();
            this._fireAdjustmentChange();
        });

        // Saturation slider
        this.patternSaturationSlider.addEventListener('input', (e) => {
            this.patternSaturation = parseFloat(e.target.value);
            this.patternSaturationValue.textContent = this.patternSaturation.toFixed(2);
            this._updatePatternPreviewColors();
            this._fireAdjustmentChange();
        });
    }

    /**
     * Throttled callback for adjustment-only slider changes.
     * Uses onAdjustmentChange (lightweight — updates uniforms only)
     * instead of onFormChange (heavyweight — reloads texture from base64).
     */
    _fireAdjustmentChange() {
        if (this._adjustThrottleTimer) return;
        this._adjustThrottleTimer = setTimeout(() => {
            this._adjustThrottleTimer = null;
            if (this.onAdjustmentChange) {
                this.onAdjustmentChange(this.getFormData().patternAdjustment);
            } else if (this.onFormChange) {
                this.onFormChange(this.getFormData());
            }
        }, this._adjustThrottleDelay);
    }

    _updatePatternPreviewColors() {
        if (!this.patternPreviewLarge.src) return;

        // Approximate Photoshop levels using CSS filters
        // Input levels: remap input range [inputBlack, inputWhite] to [0, 255]
        // Then apply gamma correction
        // Output levels: remap [0, 255] to [outputBlack, outputWhite]

        // Input range normalization (approximated with contrast + brightness)
        const inputRange = Math.max(1, this.patternInputWhite - this.patternInputBlack);
        const inputContrast = 255 / inputRange;
        const inputBrightness = -this.patternInputBlack / 255 * inputContrast;

        // Gamma (inverse for CSS - lower gamma = brighter midtones)
        // Note: CSS doesn't have native gamma, would need SVG filter for true gamma

        // Output levels (approximated with contrast + brightness)
        const outputRange = this.patternOutputWhite - this.patternOutputBlack;
        const outputContrast = outputRange / 255;
        const outputBrightness = this.patternOutputBlack / 255;

        // Combined filter: input levels -> gamma -> output levels
        // CSS filters apply in order, but we need to approximate the combined effect
        const finalContrast = inputContrast * outputContrast;
        const finalBrightness = (inputBrightness * outputContrast) + outputBrightness;

        // Use CSS filter approximation (gamma via custom SVG filter would be ideal, but this works for preview)
        // brightness() in CSS is additive, contrast() is multiplicative around 0.5
        // saturate() adjusts color saturation (0 = grayscale, 1 = normal, 2 = double saturation)
        this.patternPreviewLarge.style.filter =
            `saturate(${this.patternSaturation}) contrast(${finalContrast}) brightness(${finalBrightness + 0.5})`;
    }

    _handleFileUpload(file, type) {
        if (!file) return;

        // Validate file type
        if (!file.type.startsWith('image/')) {
            alert('Please select an image file');
            return;
        }

        // Validate file size (max 500KB)
        if (file.size > 500 * 1024) {
            alert('Image file is too large. Maximum size is 500KB.');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result;

            if (type === 'logo') {
                this.logoImageData = dataUrl;
                this._updatePreview(this.logoPreview, dataUrl);
            } else if (type === 'pattern') {
                this.patternImageData = dataUrl;
                this._updatePreview(this.patternPreview, dataUrl);
                this._showPatternAdjustment(dataUrl);
                // Reset adjustment values when new image is loaded
                this.patternScale = 1.0;
                this.patternOffsetX = 0;
                this.patternOffsetY = 0;
                this.patternScaleSlider.value = 1.0;
                this.patternScaleValue.textContent = '1.00x';
            }

            if (this.onFormChange) {
                this.onFormChange(this.getFormData());
            }
        };

        reader.onerror = () => {
            alert('Error reading file');
        };

        reader.readAsDataURL(file);
    }

    _updatePreview(previewElement, dataUrl) {
        if (dataUrl) {
            previewElement.innerHTML = `<img src="${dataUrl}" alt="Preview">`;
        } else {
            previewElement.innerHTML = '<span class="image-preview-placeholder">No image</span>';
        }
    }

    _showPatternAdjustment(dataUrl) {
        if (dataUrl) {
            this.patternAdjustGroup.classList.add('visible');
            // Wait for image to load before calculating transform dimensions
            this.patternPreviewLarge.onload = () => {
                this._updatePatternPreviewTransform();
                this._updatePatternPreviewColors();
            };
            this.patternPreviewLarge.src = dataUrl;
        } else {
            this.patternAdjustGroup.classList.remove('visible');
            this.patternPreviewLarge.src = '';
        }
    }

    _updatePatternPreviewTransform() {
        if (!this.patternPreviewLarge.src) return;

        const container = this.patternPreviewContainer;
        const img = this.patternPreviewLarge;

        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;

        // Get natural image dimensions to preserve aspect ratio
        const naturalWidth = img.naturalWidth || 256;
        const naturalHeight = img.naturalHeight || 256;
        const aspectRatio = naturalWidth / naturalHeight;

        // Calculate base size that fits in container while preserving aspect ratio
        let baseWidth, baseHeight;
        if (containerWidth / containerHeight > aspectRatio) {
            // Container is wider than image aspect ratio
            baseHeight = containerHeight;
            baseWidth = baseHeight * aspectRatio;
        } else {
            // Container is taller than image aspect ratio
            baseWidth = containerWidth;
            baseHeight = baseWidth / aspectRatio;
        }

        // Apply scale
        const imgWidth = baseWidth * this.patternScale;
        const imgHeight = baseHeight * this.patternScale;

        // Calculate position (center + offset)
        const centerX = (containerWidth - imgWidth) / 2;
        const centerY = (containerHeight - imgHeight) / 2;
        const offsetX = this.patternOffsetX * containerWidth * 0.5;
        const offsetY = this.patternOffsetY * containerHeight * 0.5;

        img.style.width = imgWidth + 'px';
        img.style.height = imgHeight + 'px';
        img.style.left = (centerX + offsetX) + 'px';
        img.style.top = (centerY + offsetY) + 'px';
    }

    // ========================
    // PUBLIC METHODS
    // ========================

    /**
     * Get current form data as an object
     * @returns {Object}
     */
    getFormData() {
        return {
            name: this.nameInput.value.trim(),
            tagline: this.taglineInput.value.trim(),
            websiteUrl: this.websiteInput.value.trim(),
            logoImage: this.logoImageData,
            patternImage: this.patternImageData,
            patternAdjustment: {
                scale: this.patternScale,
                offsetX: this.patternOffsetX,
                offsetY: this.patternOffsetY,
                // Input levels (Photoshop-style)
                inputBlack: this.patternInputBlack,
                inputGamma: this.patternInputGamma,
                inputWhite: this.patternInputWhite,
                // Output levels
                outputBlack: this.patternOutputBlack,
                outputWhite: this.patternOutputWhite,
                // Saturation
                saturation: this.patternSaturation
            }
        };
    }

    /**
     * Get only the shared sponsor-level fields (no pattern/adjustment data)
     * @returns {Object}
     */
    getSharedFormData() {
        return {
            name: this.nameInput.value.trim(),
            tagline: this.taglineInput.value.trim(),
            websiteUrl: this.websiteInput.value.trim(),
            logoImage: this.logoImageData,
        };
    }

    /**
     * Get territory-specific info data (for player territory groups)
     * @returns {{ title: string, tagline: string, websiteUrl: string }}
     */
    getTerritoryInfoData() {
        return {
            title: this.territoryNameInput.value.trim(),
            tagline: this.territoryTaglineInput.value.trim(),
            websiteUrl: this.territoryWebsiteInput.value.trim(),
        };
    }

    /**
     * Populate the territory-specific info fields
     * @param {Object} sponsor
     */
    loadTerritoryInfo(sponsor) {
        this.territoryNameInput.value = sponsor.pendingTitle || sponsor.title || "";
        this.territoryTaglineInput.value = sponsor.pendingTagline || sponsor.tagline || "";
        this.territoryWebsiteInput.value = sponsor.pendingWebsiteUrl || sponsor.websiteUrl || "";
    }

    /** @returns {string} */
    getNotes() {
        return this.notesInput.value.trim();
    }

    /** @param {string} value */
    setNotes(value) {
        this.notesInput.value = value || "";
    }

    /**
     * Validate the form
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validate() {
        const errors = [];
        const data = this.getFormData();

        if (!data.name || data.name.length === 0) {
            errors.push('Sponsor name is required');
        }

        if (data.websiteUrl && data.websiteUrl.length > 0) {
            try {
                new URL(data.websiteUrl);
            } catch (e) {
                errors.push('Invalid website URL format');
            }
        }

        return { valid: errors.length === 0, errors };
    }

    /**
     * Populate the form with existing sponsor data
     * @param {Object} sponsor
     */
    loadSponsor(sponsor) {
        this.editingSponsorId = sponsor.id;
        this.nameInput.value = sponsor.name || '';
        this.taglineInput.value = sponsor.tagline || '';
        this.websiteInput.value = sponsor.websiteUrl || '';

        this.logoImageData = sponsor.logoImage || null;
        this.patternImageData = sponsor.patternImage || null;

        // Load pattern adjustment values
        if (sponsor.patternAdjustment) {
            this.patternScale = sponsor.patternAdjustment.scale || 1.0;
            this.patternOffsetX = sponsor.patternAdjustment.offsetX || 0;
            this.patternOffsetY = sponsor.patternAdjustment.offsetY || 0;
            // Input levels
            this.patternInputBlack = sponsor.patternAdjustment.inputBlack ?? 0;
            this.patternInputGamma = sponsor.patternAdjustment.inputGamma ?? 1.0;
            this.patternInputWhite = sponsor.patternAdjustment.inputWhite ?? 255;
            // Output levels
            this.patternOutputBlack = sponsor.patternAdjustment.outputBlack ?? 0;
            this.patternOutputWhite = sponsor.patternAdjustment.outputWhite ?? 255;
            // Saturation
            this.patternSaturation = sponsor.patternAdjustment.saturation ?? 1.0;
        } else {
            this.patternScale = 1.0;
            this.patternOffsetX = 0;
            this.patternOffsetY = 0;
            this.patternInputBlack = 0;
            this.patternInputGamma = 1.0;
            this.patternInputWhite = 255;
            this.patternOutputBlack = 0;
            this.patternOutputWhite = 255;
            this.patternSaturation = 1.0;
        }

        // Update sliders
        this.patternScaleSlider.value = this.patternScale;
        this.patternScaleValue.textContent = this.patternScale.toFixed(2) + 'x';
        // Input levels
        this.patternInputBlackSlider.value = this.patternInputBlack;
        this.patternInputBlackValue.textContent = this.patternInputBlack;
        this.patternInputGammaSlider.value = this.patternInputGamma;
        this.patternInputGammaValue.textContent = this.patternInputGamma.toFixed(2);
        this.patternInputWhiteSlider.value = this.patternInputWhite;
        this.patternInputWhiteValue.textContent = this.patternInputWhite;
        // Output levels
        this.patternOutputBlackSlider.value = this.patternOutputBlack;
        this.patternOutputBlackValue.textContent = this.patternOutputBlack;
        this.patternOutputWhiteSlider.value = this.patternOutputWhite;
        this.patternOutputWhiteValue.textContent = this.patternOutputWhite;
        // Saturation
        this.patternSaturationSlider.value = this.patternSaturation;
        this.patternSaturationValue.textContent = this.patternSaturation.toFixed(2);

        this._updatePreview(this.logoPreview, this.logoImageData);
        this._updatePreview(this.patternPreview, this.patternImageData);
        this._showPatternAdjustment(this.patternImageData);

        if (this.onFormChange) {
            this.onFormChange(this.getFormData());
        }
    }

    /**
     * Clear the form
     */
    clear() {
        this.editingSponsorId = null;
        this.nameInput.value = '';
        this.taglineInput.value = '';
        this.websiteInput.value = '';
        this.logoInput.value = '';
        this.patternInput.value = '';
        this.logoImageData = null;
        this.patternImageData = null;

        // Reset territory-specific fields
        this.territoryNameInput.value = '';
        this.territoryTaglineInput.value = '';
        this.territoryWebsiteInput.value = '';
        this.notesInput.value = '';
        this.territoryInfoFields.style.display = 'none';
        this.notesFieldGroup.style.display = 'none';

        // Reset pattern adjustment
        this.patternScale = 1.0;
        this.patternOffsetX = 0;
        this.patternOffsetY = 0;
        this.patternScaleSlider.value = 1.0;
        this.patternScaleValue.textContent = '1.00x';

        // Reset input levels
        this.patternInputBlack = 0;
        this.patternInputGamma = 1.0;
        this.patternInputWhite = 255;
        this.patternInputBlackSlider.value = 0;
        this.patternInputBlackValue.textContent = '0';
        this.patternInputGammaSlider.value = 1.0;
        this.patternInputGammaValue.textContent = '1.00';
        this.patternInputWhiteSlider.value = 255;
        this.patternInputWhiteValue.textContent = '255';
        // Reset output levels
        this.patternOutputBlack = 0;
        this.patternOutputWhite = 255;
        this.patternOutputBlackSlider.value = 0;
        this.patternOutputBlackValue.textContent = '0';
        this.patternOutputWhiteSlider.value = 255;
        this.patternOutputWhiteValue.textContent = '255';
        // Reset saturation
        this.patternSaturation = 1.0;
        this.patternSaturationSlider.value = 1.0;
        this.patternSaturationValue.textContent = '1.00';

        this._updatePreview(this.logoPreview, null);
        this._updatePreview(this.patternPreview, null);
        this._showPatternAdjustment(null);

        if (this.onFormChange) {
            this.onFormChange(this.getFormData());
        }
    }

    /**
     * Get the ID of the sponsor being edited (or null for new)
     * @returns {string|null}
     */
    getEditingSponsorId() {
        return this.editingSponsorId;
    }

    /**
     * Check if currently editing an existing sponsor
     * @returns {boolean}
     */
    isEditing() {
        return this.editingSponsorId !== null;
    }

    /**
     * Focus on the name input
     */
    focus() {
        this.nameInput.focus();
    }
}
