/**
 * AdLands - Commander Skin
 * Applies gold trim visual effects to commander tanks
 * Gold accent trim on hull edges, turret ring, barrel, and tracks
 */

class CommanderSkin {
    constructor() {
        // Gold material configuration
        this.config = {
            trimColor: 0xFFD700,        // Gold
            trimEmissive: 0xFFAA00,     // Strong warm glow
            trimEmissiveIntensity: 0.5, // Prominent glow
            trimMetalness: 1.0,         // Full metallic
            trimRoughness: 0.2          // Very shiny
        };

        // Shared trim material (created once, reused)
        this.trimMaterial = this._createTrimMaterial();

        // Shared geometries (created once, reused to avoid lag on apply/remove)
        this._sharedGeom = this._createSharedGeometries();

        // Track tanks with trim applied: tankRef -> THREE.Group
        this.activeTanks = new Map();

    }

    /**
     * Create shared geometries for trim pieces (avoids allocation on apply)
     */
    _createSharedGeometries() {
        const trimThickness = 0.12;
        const trimHeight = 0.18;
        const stripThickness = 0.08;
        const stripHeight = 0.72;

        return {
            // Hull trim
            frontBackTrim: new THREE.BoxGeometry(2.8, trimHeight, trimThickness),
            sideTrim: new THREE.BoxGeometry(trimThickness, trimHeight, 5.3),
            // Turret ring
            turretRing: new THREE.TorusGeometry(0.9, 0.1, 8, 16),
            // Barrel trim
            barrelTipRing: new THREE.TorusGeometry(0.22, 0.06, 8, 12),
            barrelMidStripe: new THREE.TorusGeometry(0.2, 0.05, 8, 12),
            // Track trim
            trackStrip: new THREE.BoxGeometry(stripThickness, stripHeight, 5.4)
        };
    }

    /**
     * Create the gold trim material
     */
    _createTrimMaterial() {
        return new THREE.MeshStandardMaterial({
            color: this.config.trimColor,
            emissive: this.config.trimEmissive,
            emissiveIntensity: this.config.trimEmissiveIntensity,
            metalness: this.config.trimMetalness,
            roughness: this.config.trimRoughness,
            flatShading: true
        });
    }

    /**
     * Apply gold trim to a tank
     * @param {Object} tank - Tank object (player Tank or bot from BotTanks)
     */
    applyTrim(tank) {
        if (!tank) return;

        // Parent to bodyGroup so trim leans with the hull (falls back to group)
        const tankGroup = tank.bodyGroup || tank.group;
        if (!tankGroup) {
            console.warn('[CommanderSkin] Tank has no bodyGroup or group');
            return;
        }

        // Check if already applied
        if (this.activeTanks.has(tank)) {
            return;
        }

        // Create trim group
        const trimGroup = new THREE.Group();
        trimGroup.name = 'commanderTrim';

        // Hull edge trim (4 edges)
        this._createHullTrim(trimGroup);

        // Turret ring
        this._createTurretRing(trimGroup);

        // Barrel tip and stripe
        this._createBarrelTrim(trimGroup, tank);

        // Track outer edges
        this._createTrackTrim(trimGroup);

        // Add trim group to tank
        tankGroup.add(trimGroup);
        this.activeTanks.set(tank, trimGroup);

    }

    /**
     * Remove gold trim from a tank
     * @param {Object} tank - Tank object
     */
    removeTrim(tank) {
        if (!tank) return;

        const trimGroup = this.activeTanks.get(tank);
        if (!trimGroup) {
            return;
        }

        const tankGroup = tank.bodyGroup || tank.group;
        if (tankGroup) {
            tankGroup.remove(trimGroup);
        }

        // Remove barrel trim from turret group if present
        if (trimGroup.userData.barrelTrimGroup && trimGroup.userData.turretGroup) {
            trimGroup.userData.turretGroup.remove(trimGroup.userData.barrelTrimGroup);
        }

        // Note: Don't dispose geometries - they're shared and reused

        this.activeTanks.delete(tank);
    }

    /**
     * Create hull edge trim (prominent strips along hull edges)
     * Hull is 2.5 x 0.8 x 5 at y=0.4
     */
    _createHullTrim(trimGroup) {
        const geom = this._sharedGeom;

        // Front edge (along X at Z = -2.5)
        const frontTrim = new THREE.Mesh(geom.frontBackTrim, this.trimMaterial);
        frontTrim.position.set(0, 0.88, -2.58);
        trimGroup.add(frontTrim);

        // Back edge (along X at Z = 2.5)
        const backTrim = new THREE.Mesh(geom.frontBackTrim, this.trimMaterial);
        backTrim.position.set(0, 0.88, 2.58);
        trimGroup.add(backTrim);

        // Left edge (along Z at X = -1.25)
        const leftTrim = new THREE.Mesh(geom.sideTrim, this.trimMaterial);
        leftTrim.position.set(-1.32, 0.88, 0);
        trimGroup.add(leftTrim);

        // Right edge (along Z at X = 1.25)
        const rightTrim = new THREE.Mesh(geom.sideTrim, this.trimMaterial);
        rightTrim.position.set(1.32, 0.88, 0);
        trimGroup.add(rightTrim);
    }

    /**
     * Create turret ring (torus around turret base)
     * Turret group is at y=0.8, turret base is at y=0.3 relative to that
     */
    _createTurretRing(trimGroup) {
        // Create a prominent ring around the turret base
        const ring = new THREE.Mesh(this._sharedGeom.turretRing, this.trimMaterial);
        ring.rotation.x = Math.PI / 2; // Lay flat
        ring.position.set(0, 0.84, 0); // Just above hull, at turret base level
        ring.castShadow = false; // Decorative element - no shadows
        ring.receiveShadow = false;
        trimGroup.add(ring);
    }

    /**
     * Create barrel trim (tip ring and mid-stripe)
     * Barrel is cylinder at y=0.4 relative to turret group
     * Need to add to turret group so it rotates with turret
     */
    _createBarrelTrim(trimGroup, tank) {
        // We need to add barrel trim to the turret group so it rotates
        const turretGroup = tank.turretGroup;
        if (!turretGroup) {
            console.warn('[CommanderSkin] Tank has no turretGroup for barrel trim');
            return;
        }

        // Create a sub-group for barrel trim (so we can track and remove it)
        const barrelTrimGroup = new THREE.Group();
        barrelTrimGroup.name = 'barrelTrim';

        const geom = this._sharedGeom;

        // Barrel tip ring (larger, more prominent)
        const tipRing = new THREE.Mesh(geom.barrelTipRing, this.trimMaterial);
        tipRing.rotation.x = Math.PI / 2;
        tipRing.position.set(0, 0.4, -3.38); // At muzzle end
        tipRing.castShadow = false; // Decorative element - no shadows
        tipRing.receiveShadow = false;
        barrelTrimGroup.add(tipRing);

        // Mid-barrel stripe (more visible)
        const midStripe = new THREE.Mesh(geom.barrelMidStripe, this.trimMaterial);
        midStripe.rotation.x = Math.PI / 2;
        midStripe.position.set(0, 0.4, -1.5); // Mid-barrel
        midStripe.castShadow = false; // Decorative element - no shadows
        midStripe.receiveShadow = false;
        barrelTrimGroup.add(midStripe);

        turretGroup.add(barrelTrimGroup);

        // Store reference to barrel trim for removal
        trimGroup.userData.barrelTrimGroup = barrelTrimGroup;
        trimGroup.userData.turretGroup = turretGroup;
    }

    /**
     * Create track outer edge trim
     * Tracks are 0.6 x 0.6 x 5.2 at y=0.3, x = ±1.3
     */
    _createTrackTrim(trimGroup) {
        const geom = this._sharedGeom;

        // Left track outer edge (thicker, taller)
        const leftStrip = new THREE.Mesh(geom.trackStrip, this.trimMaterial);
        leftStrip.position.set(-1.68, 0.35, 0);
        trimGroup.add(leftStrip);

        // Right track outer edge (thicker, taller)
        const rightStrip = new THREE.Mesh(geom.trackStrip, this.trimMaterial);
        rightStrip.position.set(1.68, 0.35, 0);
        trimGroup.add(rightStrip);
    }

    /**
     * Check if a tank has trim applied
     */
    hasTrim(tank) {
        return this.activeTanks.has(tank);
    }

    /**
     * Get count of tanks with trim
     */
    getActiveCount() {
        return this.activeTanks.size;
    }

    /**
     * Dispose all trims (cleanup)
     */
    dispose() {
        this.activeTanks.forEach((trimGroup, tank) => {
            this.removeTrim(tank);
        });

        if (this.trimMaterial) {
            this.trimMaterial.dispose();
        }

        // Dispose shared geometries
        if (this._sharedGeom) {
            for (const geom of Object.values(this._sharedGeom)) {
                if (geom && geom.dispose) {
                    geom.dispose();
                }
            }
        }
    }
}
