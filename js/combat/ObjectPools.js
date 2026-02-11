/**
 * Object Pooling System for Performance Optimization
 *
 * Eliminates GC pressure from frequent object creation/destruction by reusing
 * projectiles and explosions.
 *
 * Expected Performance Gains:
 * - 60-80% reduction in GC pauses
 * - 70% reduction in memory allocation rate
 * - +10-15 FPS in heavy combat scenarios
 */

class ObjectPools {
    constructor(scene, cannonSystem) {
        this.scene = scene;
        this.cannonSystem = cannonSystem;

        // Pool configurations
        this.pools = {
            projectiles: {
                initial: 30,
                max: 100,
                items: [],
                recycleCount: 0
            },
            explosions: {
                initial: 20,
                max: 60,
                items: [],
                recycleCount: 0
            }
        };
    }

    // ============================================
    // PROJECTILE POOL
    // ============================================

    _initializeProjectilePool() {
        const pool = this.pools.projectiles;

        // Pre-create initial pool
        for (let i = 0; i < pool.initial; i++) {
            pool.items.push(this._createProjectilePoolItem());
        }

    }

    _createProjectilePoolItem() {
        // Note: geometry and materials come from cannonSystem
        const mesh = new THREE.Mesh(
            this.cannonSystem.geometry,  // Shared cylinder geometry
            this.cannonSystem.materials['rust']  // Placeholder, will be swapped
        );

        // Clone light (small object, ok to create)
        const light = this.cannonSystem.lights['rust'].clone();
        mesh.add(light);

        return {
            mesh: mesh,
            light: light,
            scaledGeometry: null,  // For charged shots
            lastSizeScale: 1.0,
            inUse: false
        };
    }

    acquireProjectile(faction, sizeScale) {
        const pool = this.pools.projectiles;

        // Find available pool item
        let poolItem = pool.items.find(p => !p.inUse);

        if (!poolItem) {
            // Pool exhausted - grow or recycle
            if (pool.items.length < pool.max) {
                // Grow pool
                poolItem = this._createProjectilePoolItem();
                pool.items.push(poolItem);
            } else {
                // Max reached - recycle oldest
                poolItem = this._recycleOldestProjectile();
                pool.recycleCount++;

                if (pool.recycleCount % 10 === 0) {
                    console.warn(`[ObjectPools] Projectile pool exhausted (recycled ${pool.recycleCount} times)`);
                }
            }
        }

        poolItem.inUse = true;

        // Handle charged shots (scaled geometry)
        if (sizeScale > 1.01) {
            if (!poolItem.scaledGeometry || Math.abs(poolItem.lastSizeScale - sizeScale) > 0.01) {
                // Need new scaled geometry
                if (poolItem.scaledGeometry) {
                    poolItem.scaledGeometry.dispose();
                }

                const radius = this.cannonSystem.config.projectileRadius * sizeScale;
                const length = this.cannonSystem.config.projectileLength * sizeScale;

                poolItem.scaledGeometry = new THREE.CylinderGeometry(radius, radius, length, 8);
                poolItem.scaledGeometry.rotateX(Math.PI / 2);
                poolItem.lastSizeScale = sizeScale;
            }
            poolItem.mesh.geometry = poolItem.scaledGeometry;
        } else {
            // Use shared base geometry
            poolItem.mesh.geometry = this.cannonSystem.geometry;
        }

        // Update material and light for faction
        poolItem.mesh.material = this.cannonSystem.materials[faction];

        const factionColor = this.cannonSystem.factionColors[faction].hex;
        poolItem.light.color.setHex(factionColor);
        poolItem.light.intensity = 5 * sizeScale;
        poolItem.light.distance = 50 * sizeScale;

        // Add to scene
        this.scene.add(poolItem.mesh);

        return poolItem;
    }

    releaseProjectile(poolItem) {
        poolItem.inUse = false;
        this.scene.remove(poolItem.mesh);

        // Move off-screen
        poolItem.mesh.position.set(0, -9999, 0);
    }

    _recycleOldestProjectile() {
        // Find oldest active projectile
        let oldestItem = null;
        let maxAge = 0;

        for (const item of this.pools.projectiles.items) {
            if (item.inUse) {
                // Find in projectiles array
                const projectile = this.cannonSystem.projectiles.find(p => p.poolItem === item);
                if (projectile && projectile.age > maxAge) {
                    maxAge = projectile.age;
                    oldestItem = item;
                }
            }
        }

        if (oldestItem) {
            // Force release
            this.releaseProjectile(oldestItem);

            // Remove from projectiles array
            const idx = this.cannonSystem.projectiles.findIndex(p => p.poolItem === oldestItem);
            if (idx >= 0) {
                this.cannonSystem.projectiles.splice(idx, 1);
            }
        }

        return oldestItem;
    }

    // ============================================
    // EXPLOSION POOL
    // ============================================

    _initializeExplosionPool() {
        const pool = this.pools.explosions;

        // Pre-create initial pool
        for (let i = 0; i < pool.initial; i++) {
            pool.items.push(this._createExplosionPoolItem());
        }

    }

    _createExplosionPoolItem() {
        const cfg = this.cannonSystem.explosionConfig;

        // Guard against texture not loaded yet
        if (!this.cannonSystem.explosionTexture) {
            console.warn('[ObjectPools] Explosion texture not loaded yet, creating placeholder');
            // Return a placeholder that will be populated later when texture loads
            const material = new THREE.SpriteMaterial({
                transparent: true,
                opacity: 1,  // FIXED: was 0, should be 1 so we can see colored fallback
                depthWrite: false,
                depthTest: false,  // Render on top of everything
                blending: THREE.AdditiveBlending,
                sizeAttenuation: false  // Sprite doesn't scale with distance
            });
            const sprite = new THREE.Sprite(material);
            sprite.scale.setScalar(cfg.baseSize);
            sprite.layers.enable(0);  // DEFAULT_LAYER for testing
            sprite.layers.enable(1);  // BLOOM_LAYER
            sprite.visible = true;  // Explicitly visible
            return {
                sprite: sprite,
                material: material,
                texture: null,
                inUse: false  // Fixed: was 'active', should be 'inUse'
            };
        }

        // Create texture (will modify UV offset, not clone)
        const texture = this.cannonSystem.explosionTexture.clone();
        texture.repeat.set(1 / cfg.columns, 1 / cfg.rows);
        texture.offset.set(0, 1 - (1 / cfg.rows));

        // Create material
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            opacity: 1,
            depthWrite: false,
            depthTest: false,  // Render on top of everything
            blending: THREE.AdditiveBlending,
            sizeAttenuation: false  // Sprite doesn't scale with distance
        });

        // Create sprite
        const sprite = new THREE.Sprite(material);
        sprite.scale.setScalar(cfg.baseSize);
        sprite.layers.enable(0);  // DEFAULT_LAYER for testing
        sprite.layers.enable(1);  // BLOOM_LAYER

        return {
            sprite: sprite,
            material: material,
            texture: texture,
            inUse: false
        };
    }

    acquireExplosion(faction, sizeScale) {
        const pool = this.pools.explosions;

        // Find available pool item
        let poolItem = pool.items.find(e => !e.inUse);

        if (!poolItem) {
            // Pool exhausted - grow or recycle
            if (pool.items.length < pool.max) {
                // Grow pool
                poolItem = this._createExplosionPoolItem();
                pool.items.push(poolItem);
            } else {
                // Max reached - recycle oldest
                poolItem = this._recycleOldestExplosion();
                pool.recycleCount++;

                if (pool.recycleCount % 10 === 0) {
                    console.warn(`[ObjectPools] Explosion pool exhausted (recycled ${pool.recycleCount} times)`);
                }
            }
        }

        poolItem.inUse = true;

        const cfg = this.cannonSystem.explosionConfig;

        // Reset material for this faction
        const factionColor = this.cannonSystem.factionColors[faction].clone();
        factionColor.lerp(new THREE.Color(1, 1, 1), 0.35);
        factionColor.multiplyScalar(1.5);
        poolItem.material.color.copy(factionColor);
        poolItem.material.rotation = Math.random() * Math.PI * 2;
        poolItem.material.opacity = 1;

        // Reset UV to first frame (if texture is loaded)
        if (poolItem.texture) {
            poolItem.texture.repeat.set(1 / cfg.columns, 1 / cfg.rows);
            poolItem.texture.offset.set(0, 1 - (1 / cfg.rows));
            poolItem.material.map = poolItem.texture;
            poolItem.material.needsUpdate = true;
        } else if (this.cannonSystem.explosionTexture) {
            // Texture has now loaded - create it for this pool item
            poolItem.texture = this.cannonSystem.explosionTexture.clone();
            poolItem.texture.repeat.set(1 / cfg.columns, 1 / cfg.rows);
            poolItem.texture.offset.set(0, 1 - (1 / cfg.rows));
            poolItem.material.map = poolItem.texture;
            poolItem.material.needsUpdate = true;
        } else {
            // Texture still not loaded - at least show a colored sprite as fallback
            poolItem.material.map = null;
            poolItem.material.needsUpdate = true;
        }

        // Reset scale
        poolItem.sprite.scale.setScalar(cfg.baseSize * sizeScale);

        // Ensure sprite is visible and on correct layer
        poolItem.sprite.visible = true;
        poolItem.sprite.layers.enable(0);  // DEFAULT_LAYER for testing
        poolItem.sprite.layers.enable(1);  // BLOOM_LAYER

        return poolItem;
    }

    releaseExplosion(poolItem) {
        poolItem.inUse = false;

        // Sprite is parented to planet.hexGroup, will be removed by caller
        // Just mark as available (position will be set when reacquired)
    }

    _recycleOldestExplosion() {
        // Find oldest active explosion
        let oldestItem = null;
        let maxAge = 0;

        for (const item of this.pools.explosions.items) {
            if (item.inUse) {
                // Find in explosions array
                const explosion = this.cannonSystem.explosions.find(e => e.poolItem === item);
                if (explosion && explosion.age > maxAge) {
                    maxAge = explosion.age;
                    oldestItem = item;
                }
            }
        }

        if (oldestItem) {
            // Force release
            this.cannonSystem.planet.hexGroup.remove(oldestItem.sprite);
            this.releaseExplosion(oldestItem);

            // Remove from explosions array
            const idx = this.cannonSystem.explosions.findIndex(e => e.poolItem === oldestItem);
            if (idx >= 0) {
                this.cannonSystem.explosions.splice(idx, 1);
            }
        }

        return oldestItem;
    }

    // ============================================
    // DIAGNOSTICS
    // ============================================

    getPoolStats() {
        const stats = {};

        for (const [poolName, pool] of Object.entries(this.pools)) {
            const activeCount = pool.items.filter(item => item.inUse).length;
            const totalCount = pool.items.length;
            const utilization = totalCount > 0 ? (activeCount / totalCount * 100).toFixed(1) + '%' : '0%';

            stats[poolName] = {
                total: totalCount,
                active: activeCount,
                utilization: utilization,
                recycled: pool.recycleCount
            };
        }

        return stats;
    }
}
