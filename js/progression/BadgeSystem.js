/**
 * AdLands - Badge System (Achievements)
 * Hidden achievements that unlock as surprises when earned
 * Persistent localStorage storage for badge progress and unlocks
 */

class BadgeSystem {
    constructor() {
        // Badge definitions - conditions hidden from player until unlocked
        this.badges = {
            // ===== COMBAT BADGES =====
            first_blood: {
                id: 'first_blood',
                name: 'First Blood',
                description: 'Get your first kill',
                icon: '\u2694',  // Crossed swords
                rarity: 'common',
                category: 'combat',
                condition: (stats) => stats.kills >= 1
            },
            centurion: {
                id: 'centurion',
                name: 'Centurion',
                description: 'Kill 100 tanks',
                icon: '\uD83D\uDDE1',  // Dagger
                rarity: 'uncommon',
                category: 'combat',
                condition: (stats) => stats.kills >= 100
            },
            thousand_souls: {
                id: 'thousand_souls',
                name: 'Thousand Souls',
                description: 'Kill 1,000 tanks',
                icon: '\uD83D\uDC80',  // Skull
                rarity: 'rare',
                category: 'combat',
                condition: (stats) => stats.kills >= 1000
            },
            genocide: {
                id: 'genocide',
                name: 'Genocide',
                description: 'Kill 10,000 tanks',
                icon: '\u2620',  // Skull and crossbones
                rarity: 'epic',
                category: 'combat',
                condition: (stats) => stats.kills >= 10000
            },
            untouchable: {
                id: 'untouchable',
                name: 'Untouchable',
                description: '20 kill streak',
                icon: '\uD83D\uDD25',  // Fire
                rarity: 'epic',
                category: 'combat',
                condition: (stats) => stats.maxKillstreak >= 20
            },
            glass_cannon: {
                id: 'glass_cannon',
                name: 'Glass Cannon',
                description: '10 kills without taking damage',
                icon: '\uD83D\uDCA5',  // Collision
                rarity: 'rare',
                category: 'combat',
                condition: (stats) => stats.killsWithoutDamage >= 10
            },
            revenge: {
                id: 'revenge',
                name: 'Revenge',
                description: 'Kill someone within 10 seconds of them killing you',
                icon: '\u21A9',  // Return arrow
                rarity: 'common',
                category: 'combat',
                condition: (stats) => stats.revengeKills >= 1
            },

            // ===== SURVIVAL BADGES =====
            survivor: {
                id: 'survivor',
                name: 'Survivor',
                description: 'Stay alive for 30 minutes',
                icon: '\uD83D\uDC9A',  // Green heart
                rarity: 'common',
                category: 'survival',
                condition: (stats) => stats.longestLife >= 1800
            },
            cockroach: {
                id: 'cockroach',
                name: 'Cockroach',
                description: 'Stay alive for 1 hour',
                icon: '\uD83E\uDEB3',  // Cockroach
                rarity: 'uncommon',
                category: 'survival',
                condition: (stats) => stats.longestLife >= 3600
            },
            immortal: {
                id: 'immortal',
                name: 'Immortal',
                description: 'Stay alive for 2 hours',
                icon: '\u2728',  // Sparkles
                rarity: 'rare',
                category: 'survival',
                condition: (stats) => stats.longestLife >= 7200
            },
            close_call: {
                id: 'close_call',
                name: 'Close Call',
                description: 'Survive with 1 HP',
                icon: '\u2764',  // Heart
                rarity: 'uncommon',
                category: 'survival',
                condition: (stats) => stats.closeCallSurvives >= 1
            },
            phoenix: {
                id: 'phoenix',
                name: 'Phoenix',
                description: 'Get 5 kills after dropping below 10% HP',
                icon: '\uD83E\uDD85',  // Eagle (phoenix-like)
                rarity: 'rare',
                category: 'survival',
                condition: (stats) => stats.lowHPKills >= 5
            },

            // ===== TERRITORY BADGES =====
            landlord: {
                id: 'landlord',
                name: 'Landlord',
                description: 'Capture 100 hexes',
                icon: '\uD83C\uDFE0',  // House
                rarity: 'common',
                category: 'territory',
                condition: (stats) => stats.hexesCaptured >= 100
            },
            real_estate_mogul: {
                id: 'real_estate_mogul',
                name: 'Real Estate Mogul',
                description: 'Capture 1,000 hexes',
                icon: '\uD83C\uDFD9',  // Cityscape
                rarity: 'uncommon',
                category: 'territory',
                condition: (stats) => stats.hexesCaptured >= 1000
            },
            planet_owner: {
                id: 'planet_owner',
                name: 'Planet Owner',
                description: 'Capture 10,000 hexes',
                icon: '\uD83C\uDF0D',  // Globe
                rarity: 'epic',
                category: 'territory',
                condition: (stats) => stats.hexesCaptured >= 10000
            },
            hostile_takeover: {
                id: 'hostile_takeover',
                name: 'Hostile Takeover',
                description: 'Capture 10 clusters',
                icon: '\uD83D\uDCC8',  // Chart increasing
                rarity: 'uncommon',
                category: 'territory',
                condition: (stats) => stats.clustersCaptured >= 10
            },
            corporate_raider: {
                id: 'corporate_raider',
                name: 'Corporate Raider',
                description: 'Capture 100 clusters',
                icon: '\uD83E\uDD88',  // Shark
                rarity: 'rare',
                category: 'territory',
                condition: (stats) => stats.clustersCaptured >= 100
            },
            reconquista: {
                id: 'reconquista',
                name: 'Reconquista',
                description: 'Recapture a hex within 60 seconds of losing it',
                icon: '\u21BB',  // Clockwise arrow
                rarity: 'common',
                category: 'territory',
                condition: (stats) => stats.reconquests >= 1
            },

            // ===== SOCIAL BADGES =====
            squad_up: {
                id: 'squad_up',
                name: 'Squad Up',
                description: 'Join your first squad',
                icon: '\uD83D\uDC6B',  // People holding hands
                rarity: 'common',
                category: 'social',
                condition: (stats) => stats.squadsJoined >= 1
            },
            social_butterfly: {
                id: 'social_butterfly',
                name: 'Social Butterfly',
                description: 'Add 10 friends',
                icon: '\uD83E\uDD8B',  // Butterfly
                rarity: 'common',
                category: 'social',
                condition: (stats) => stats.friendsAdded >= 10
            },
            networker: {
                id: 'networker',
                name: 'Networker',
                description: 'Add 50 friends',
                icon: '\uD83C\uDF10',  // Globe with meridians
                rarity: 'uncommon',
                category: 'social',
                condition: (stats) => stats.friendsAdded >= 50
            },
            diplomat: {
                id: 'diplomat',
                name: 'Diplomat',
                description: 'Send 1,000 chat messages',
                icon: '\uD83D\uDCAC',  // Speech bubble
                rarity: 'uncommon',
                category: 'social',
                condition: (stats) => stats.messagesSent >= 1000
            },
            introvert: {
                id: 'introvert',
                name: 'Introvert',
                description: 'Play 10 hours without sending a message',
                icon: '\uD83E\uDD10',  // Zipper mouth
                rarity: 'rare',
                category: 'social',
                condition: (stats) => stats.silentPlaytime >= 36000
            },

            // ===== FACTION BADGES =====
            loyal: {
                id: 'loyal',
                name: 'Loyal',
                description: 'Play 100 hours for one faction',
                icon: '\u2665',  // Heart suit
                rarity: 'uncommon',
                category: 'faction',
                condition: (stats) => stats.maxFactionPlaytime >= 360000
            },
            diehard: {
                id: 'diehard',
                name: 'Diehard',
                description: 'Play 500 hours for one faction',
                icon: '\uD83D\uDCAA',  // Flexed bicep
                rarity: 'rare',
                category: 'faction',
                condition: (stats) => stats.maxFactionPlaytime >= 1800000
            },
            lifer: {
                id: 'lifer',
                name: 'Lifer',
                description: 'Play 1,000 hours for one faction',
                icon: '\uD83C\uDF96',  // Military medal
                rarity: 'epic',
                category: 'faction',
                condition: (stats) => stats.maxFactionPlaytime >= 3600000
            },
            turncoat: {
                id: 'turncoat',
                name: 'Turncoat',
                description: 'Switch factions',
                icon: '\uD83E\uDE9E',  // Mirror
                rarity: 'common',
                category: 'faction',
                condition: (stats) => stats.factionSwitches >= 1
            },
            triple_agent: {
                id: 'triple_agent',
                name: 'Triple Agent',
                description: 'Play all three factions',
                icon: '\uD83C\uDFAD',  // Masks
                rarity: 'uncommon',
                category: 'faction',
                condition: (stats) => stats.factionsPlayed >= 3
            },

            // ===== META BADGES =====
            night_owl: {
                id: 'night_owl',
                name: 'Night Owl',
                description: 'Play between 2am-5am',
                icon: '\uD83E\uDD89',  // Owl
                rarity: 'uncommon',
                category: 'meta',
                condition: (stats) => stats.nightOwlSessions >= 1
            },
            early_bird: {
                id: 'early_bird',
                name: 'Early Bird',
                description: 'Play between 5am-7am',
                icon: '\uD83D\uDC26',  // Bird
                rarity: 'uncommon',
                category: 'meta',
                condition: (stats) => stats.earlyBirdSessions >= 1
            },
            marathon: {
                id: 'marathon',
                name: 'Marathon',
                description: 'Play 8 hours in one session',
                icon: '\uD83C\uDFC3',  // Runner
                rarity: 'rare',
                category: 'meta',
                condition: (stats) => stats.longestSession >= 28800
            },
            dedicated: {
                id: 'dedicated',
                name: 'Dedicated',
                description: 'Log in 30 days in a row',
                icon: '\uD83D\uDCC5',  // Calendar
                rarity: 'rare',
                category: 'meta',
                condition: (stats) => stats.loginStreak >= 30
            },
            veteran: {
                id: 'veteran',
                name: 'Veteran',
                description: 'Play for 1,000 hours total',
                icon: '\uD83C\uDF1F',  // Glowing star
                rarity: 'epic',
                category: 'meta',
                condition: (stats) => stats.totalPlaytime >= 3600000
            },
            no_life: {
                id: 'no_life',
                name: 'No Life',
                description: 'Play for 5,000 hours total',
                icon: '\uD83D\uDC7B',  // Ghost
                rarity: 'legendary',
                category: 'meta',
                condition: (stats) => stats.totalPlaytime >= 18000000
            },
            photographer: {
                id: 'photographer',
                name: 'Photographer',
                description: 'Take 100 screenshots',
                icon: '\uD83D\uDCF8',  // Camera with flash
                rarity: 'uncommon',
                category: 'meta',
                condition: (stats) => stats.screenshotsTaken >= 100
            },
            influencer: {
                id: 'influencer',
                name: 'Influencer',
                description: 'Share 50 times to social media',
                icon: '\uD83D\uDCE3',  // Megaphone
                rarity: 'rare',
                category: 'meta',
                condition: (stats) => stats.socialShares >= 50
            },
            listener: {
                id: 'listener',
                name: 'Listener',
                description: 'Set Tusk commentary to "Off"',
                icon: '\uD83D\uDD07',  // Speaker off
                rarity: 'common',
                category: 'meta',
                condition: (stats) => stats.tuskMuted >= 1
            },
            masochist: {
                id: 'masochist',
                name: 'Masochist',
                description: 'Set Tusk commentary back to "Full" after turning it off',
                icon: '\uD83D\uDD0A',  // Speaker loud
                rarity: 'uncommon',
                category: 'meta',
                condition: (stats) => stats.tuskReEnabled >= 1
            },
            broke: {
                id: 'broke',
                name: 'Broke',
                description: 'Die 100 times in one session',
                icon: '\uD83D\uDCB8',  // Money with wings
                rarity: 'uncommon',
                category: 'meta',
                condition: (stats) => stats.sessionDeaths >= 100
            },
            pacifist: {
                id: 'pacifist',
                name: 'Pacifist',
                description: 'Play 1 hour without killing anyone',
                icon: '\u262E',  // Peace symbol
                rarity: 'rare',
                category: 'meta',
                condition: (stats) => stats.pacifistTime >= 3600
            },

            // ===== SECRET BADGES =====
            tusks_favorite: {
                id: 'tusks_favorite',
                name: "Tusk's Favorite",
                description: 'Get called out by Tusk 50 times',
                icon: '\u2B50',  // Star
                rarity: 'rare',
                category: 'secret',
                condition: (stats) => stats.tuskCallouts >= 50
            },
            tusks_enemy: {
                id: 'tusks_enemy',
                name: "Tusk's Enemy",
                description: 'Get roasted by Tusk 100 times',
                icon: '\uD83E\uDD21',  // Clown face
                rarity: 'epic',
                category: 'secret',
                condition: (stats) => stats.tuskRoasts >= 100
            },

            // ===== COMMANDER BADGES =====
            field_promotion: {
                id: 'field_promotion',
                name: 'Field Promotion',
                description: 'Become commander for the first time',
                icon: '\u2605',  // Star
                rarity: 'uncommon',
                category: 'commander',
                condition: (stats) => stats.timesCommander >= 1
            },
            golden_hour: {
                id: 'golden_hour',
                name: 'Golden Hour',
                description: 'Hold commander role for 1 hour',
                icon: '\u23F0',  // Alarm clock
                rarity: 'rare',
                category: 'commander',
                condition: (stats) => stats.commanderTime >= 3600
            },
            golden_age: {
                id: 'golden_age',
                name: 'Golden Age',
                description: 'Hold commander role for 24 hours total',
                icon: '\uD83C\uDFC6',  // Trophy
                rarity: 'epic',
                category: 'commander',
                condition: (stats) => stats.commanderTime >= 86400
            },
            gilded: {
                id: 'gilded',
                name: 'Gilded',
                description: 'Be commander 10 separate times',
                icon: '\uD83D\uDC51',  // Crown
                rarity: 'rare',
                category: 'commander',
                condition: (stats) => stats.timesCommander >= 10
            },
            generous_leader: {
                id: 'generous_leader',
                name: 'Generous Leader',
                description: 'Tip ¢50,000 total as commander',
                icon: '\uD83D\uDCB0',  // Money bag
                rarity: 'rare',
                category: 'commander',
                condition: (stats) => stats.cryptoTipped >= 50000
            },
            tactician: {
                id: 'tactician',
                name: 'Tactician',
                description: 'Draw 100 tactical markings as commander',
                icon: '\u270F',  // Pencil
                rarity: 'uncommon',
                category: 'commander',
                condition: (stats) => stats.tacticalDrawings >= 100
            },
            untouchable_commander: {
                id: 'untouchable_commander',
                name: 'Untouchable Commander',
                description: 'Survive 30 minutes as commander without dying',
                icon: '\uD83D\uDEE1',  // Shield
                rarity: 'epic',
                category: 'commander',
                condition: (stats) => stats.commanderSurvivalTime >= 1800
            },
            target_practice: {
                id: 'target_practice',
                name: 'Target Practice',
                description: 'Kill an enemy commander',
                icon: '\uD83C\uDFAF',  // Target
                rarity: 'uncommon',
                category: 'commander',
                condition: (stats) => stats.commanderKills >= 1
            },
            regicide: {
                id: 'regicide',
                name: 'Regicide',
                description: 'Kill an enemy commander while you are commander',
                icon: '\u2694\uFE0F',  // Crossed swords
                rarity: 'epic',
                category: 'commander',
                condition: (stats) => stats.regicideKills >= 1
            }
        };

        // Rarity colors
        this.rarityColors = {
            common: '#aaaaaa',     // Gray
            uncommon: '#22c55e',   // Green
            rare: '#3b82f6',       // Blue
            epic: '#a855f7',       // Purple
            legendary: '#00ffff'   // Cyan (game accent)
        };

        // Tusk unlock messages
        this.unlockMessages = {
            first_blood: "Achievement unlocked: First Blood. @{player} has drawn first blood. HR has noted this.",
            centurion: "Achievement unlocked: Centurion. @{player} has killed 100 contractors. HR has been notified.",
            thousand_souls: "Achievement unlocked: Thousand Souls. @{player} has 1,000 kills. That's... concerning.",
            genocide: "Achievement unlocked: Genocide. @{player} has 10,000 kills. We should probably talk.",
            untouchable: "Achievement unlocked: Untouchable. @{player} went on a 20 kill streak. Someone nerf this person.",
            survivor: "Achievement unlocked: Survivor. @{player} survived 30 minutes. Patience is a virtue. Or hiding.",
            immortal: "Achievement unlocked: Immortal. @{player} survived 2 hours. Impressive. Or boring. Jury's out.",
            pacifist: "Achievement unlocked: Pacifist. @{player} played an hour without killing anyone. Wrong game, maybe?",
            no_life: "Achievement unlocked: No Life. @{player} has 5,000 hours. We should talk.",
            turncoat: "Achievement unlocked: Turncoat. @{player} switched factions. Loyalty is overrated anyway.",
            listener: "Achievement unlocked: Listener. @{player} muted me. I'm not offended. Really.",
            masochist: "Achievement unlocked: Masochist. @{player} turned me back on. I knew you'd miss me.",
            broke: "Achievement unlocked: Broke. @{player} died 100 times in one session. Inspirational.",
            marathon: "Achievement unlocked: Marathon. @{player} played 8 hours straight. Touch grass maybe?",
            tusks_favorite: "Achievement unlocked: Tusk's Favorite. @{player} has earned 50 callouts. You're welcome.",
            tusks_enemy: "Achievement unlocked: Tusk's Enemy. @{player} has been roasted 100 times. Thick skin required.",
            // Commander badges
            field_promotion: "Achievement unlocked: Field Promotion. @{player} has become Commander. The gold trim suits you.",
            golden_hour: "Achievement unlocked: Golden Hour. @{player} held Commander for 1 hour. Leadership material.",
            golden_age: "Achievement unlocked: Golden Age. @{player} has 24 hours as Commander. A true leader.",
            gilded: "Achievement unlocked: Gilded. @{player} has been Commander 10 times. Frequent flyer miles.",
            generous_leader: "Achievement unlocked: Generous Leader. @{player} tipped ¢50k. Fiscal responsibility who?",
            tactician: "Achievement unlocked: Tactician. @{player} drew 100 tactical markings. Picasso with a death ray.",
            untouchable_commander: "Achievement unlocked: Untouchable Commander. @{player} survived 30 minutes as Commander. Bodyguards earned their pay.",
            target_practice: "Achievement unlocked: Target Practice. @{player} killed an enemy Commander. That's a scalp.",
            regicide: "Achievement unlocked: Regicide. @{player} killed a Commander while being Commander. Brutal."
        };

        // Player data
        this.unlockedBadges = [];  // Array of { id, unlockedAt }
        this.progress = {};       // Hidden progress tracking

        // Callbacks
        this.onBadgeUnlock = null;  // Callback when badge is unlocked

        // Load from localStorage
        this._loadData();

        // Start session tracking
        this._startSessionTracking();

    }

    // ========================
    // PERSISTENCE
    // ========================

    _loadData() {
        try {
            const saved = localStorage.getItem('adlands_badges');
            if (saved) {
                const data = JSON.parse(saved);
                this.unlockedBadges = data.unlockedBadges || [];
                this.progress = data.progress || this._getDefaultProgress();
            } else {
                this.progress = this._getDefaultProgress();
            }
        } catch (e) {
            console.warn('[BadgeSystem] Failed to load data:', e);
            this.progress = this._getDefaultProgress();
        }
    }

    _saveData() {
        try {
            const data = {
                unlockedBadges: this.unlockedBadges,
                progress: this.progress
            };
            localStorage.setItem('adlands_badges', JSON.stringify(data));
        } catch (e) {
            console.warn('[BadgeSystem] Failed to save data:', e);
        }
        // Also sync to Firestore via ProfileManager (debounced)
        if (window.profileManager && window.profileManager.loaded) {
            window.profileManager.saveProfile();
        }
    }

    _getDefaultProgress() {
        return {
            // Combat
            kills: 0,
            maxKillstreak: 0,
            killsWithoutDamage: 0,
            revengeKills: 0,

            // Survival
            longestLife: 0,
            closeCallSurvives: 0,
            lowHPKills: 0,

            // Territory
            hexesCaptured: 0,
            clustersCaptured: 0,
            reconquests: 0,

            // Social
            squadsJoined: 0,
            friendsAdded: 0,
            messagesSent: 0,
            silentPlaytime: 0,

            // Faction
            maxFactionPlaytime: 0,
            factionSwitches: 0,
            factionsPlayed: 1,
            factionHistory: [],

            // Meta
            nightOwlSessions: 0,
            earlyBirdSessions: 0,
            longestSession: 0,
            loginStreak: 0,
            lastLoginDate: null,
            totalPlaytime: 0,
            screenshotsTaken: 0,
            socialShares: 0,
            tuskMuted: 0,
            tuskReEnabled: 0,
            sessionDeaths: 0,
            pacifistTime: 0,

            // Secret
            tuskCallouts: 0,
            tuskRoasts: 0,

            // Commander
            timesCommander: 0,
            commanderTime: 0,           // Total seconds as commander
            cryptoTipped: 0,
            tacticalDrawings: 0,
            commanderSurvivalTime: 0,   // Longest survival as commander
            commanderKills: 0,          // Enemy commanders killed
            regicideKills: 0,           // Commanders killed while being commander
            currentCommanderStart: null,
            currentCommanderSurvival: 0,

            // Session tracking
            currentSessionStart: null,
            currentSessionDeaths: 0,
            currentSessionKills: 0,
            lastKillTime: 0,
            lastDeathTime: 0,
            lastKillerIds: [],
            currentLifeStart: null,
            damageTakenThisLife: 0
        };
    }

    // ========================
    // SESSION TRACKING
    // ========================

    _startSessionTracking() {
        // Record session start
        this.progress.currentSessionStart = Date.now();
        this.progress.currentSessionDeaths = 0;
        this.progress.currentSessionKills = 0;
        this.progress.currentLifeStart = Date.now();
        this.progress.damageTakenThisLife = 0;

        // Check time of day for night owl / early bird
        const hour = new Date().getHours();
        if (hour >= 2 && hour < 5) {
            this.progress.nightOwlSessions++;
            this._checkBadgeUnlock('night_owl');
        } else if (hour >= 5 && hour < 7) {
            this.progress.earlyBirdSessions++;
            this._checkBadgeUnlock('early_bird');
        }

        // Check login streak
        this._updateLoginStreak();

        this._saveData();

        // Start session timer
        this._sessionInterval = setInterval(() => {
            this._updateSessionTime();
        }, 60000); // Update every minute
    }

    _updateLoginStreak() {
        const today = new Date().toDateString();
        const lastLogin = this.progress.lastLoginDate;

        if (lastLogin) {
            const lastDate = new Date(lastLogin);
            const daysDiff = Math.floor((new Date(today) - lastDate) / (1000 * 60 * 60 * 24));

            if (daysDiff === 1) {
                // Consecutive day
                this.progress.loginStreak++;
            } else if (daysDiff > 1) {
                // Streak broken
                this.progress.loginStreak = 1;
            }
            // Same day - no change
        } else {
            this.progress.loginStreak = 1;
        }

        this.progress.lastLoginDate = today;
        this._checkBadgeUnlock('dedicated');
    }

    _updateSessionTime() {
        if (!this.progress.currentSessionStart) return;

        const sessionLength = Math.floor((Date.now() - this.progress.currentSessionStart) / 1000);
        this.progress.totalPlaytime += 60; // Add 1 minute

        if (sessionLength > this.progress.longestSession) {
            this.progress.longestSession = sessionLength;
            this._checkBadgeUnlock('marathon');
        }

        this._checkBadgeUnlock('veteran');
        this._checkBadgeUnlock('no_life');

        this._saveData();
    }

    // ========================
    // EVENT TRACKING
    // ========================

    /**
     * Track a kill event
     */
    trackKill(victimId) {
        this.progress.kills++;
        this.progress.currentSessionKills++;
        this.progress.lastKillTime = Date.now();

        // Check if this is a revenge kill
        if (this.progress.lastKillerIds.includes(victimId)) {
            const timeSinceDeath = Date.now() - this.progress.lastDeathTime;
            if (timeSinceDeath <= 10000) { // Within 10 seconds
                this.progress.revengeKills++;
                this._checkBadgeUnlock('revenge');
            }
        }

        // Check kills without damage
        if (this.progress.damageTakenThisLife === 0) {
            this.progress.killsWithoutDamage++;
            this._checkBadgeUnlock('glass_cannon');
        }

        // Reset pacifist timer
        this.progress.pacifistTime = 0;

        this._checkBadgeUnlock('first_blood');
        this._checkBadgeUnlock('centurion');
        this._checkBadgeUnlock('thousand_souls');
        this._checkBadgeUnlock('genocide');

        this._saveData();
    }

    /**
     * Track a kill streak
     */
    trackKillstreak(streak) {
        if (streak > this.progress.maxKillstreak) {
            this.progress.maxKillstreak = streak;
            this._checkBadgeUnlock('untouchable');
            this._saveData();
        }
    }

    /**
     * Track a death event
     */
    trackDeath(killerId) {
        this.progress.sessionDeaths++;
        this.progress.currentSessionDeaths++;
        this.progress.lastDeathTime = Date.now();

        // Track last killers for revenge
        this.progress.lastKillerIds.unshift(killerId);
        if (this.progress.lastKillerIds.length > 5) {
            this.progress.lastKillerIds.pop();
        }

        // Calculate life duration
        if (this.progress.currentLifeStart) {
            const lifeLength = Math.floor((Date.now() - this.progress.currentLifeStart) / 1000);
            if (lifeLength > this.progress.longestLife) {
                this.progress.longestLife = lifeLength;
                this._checkBadgeUnlock('survivor');
                this._checkBadgeUnlock('cockroach');
                this._checkBadgeUnlock('immortal');
            }
        }

        // Check pacifist (if no kills this life)
        if (this.progress.currentLifeStart) {
            const lifeLength = Math.floor((Date.now() - this.progress.currentLifeStart) / 1000);
            // This badge requires 1 hour of play without killing
            // We'll track separately in the update loop
        }

        // Reset for new life
        this.progress.currentLifeStart = Date.now();
        this.progress.damageTakenThisLife = 0;
        this.progress.killsWithoutDamage = 0;

        this._checkBadgeUnlock('broke');

        this._saveData();
    }

    /**
     * Track damage taken
     */
    trackDamageTaken(amount, currentHP, maxHP) {
        this.progress.damageTakenThisLife += amount;

        // Check close call (survived at 1 HP)
        if (currentHP === 1) {
            this.progress.closeCallSurvives++;
            this._checkBadgeUnlock('close_call');
            this._saveData();
        }
    }

    /**
     * Track a kill at low HP
     */
    trackLowHPKill(hpPercent) {
        if (hpPercent <= 0.1) {
            this.progress.lowHPKills++;
            this._checkBadgeUnlock('phoenix');
            this._saveData();
        }
    }

    /**
     * Track hex capture
     */
    trackHexCapture() {
        this.progress.hexesCaptured++;
        this._checkBadgeUnlock('landlord');
        this._checkBadgeUnlock('real_estate_mogul');
        this._checkBadgeUnlock('planet_owner');
        this._saveData();
    }

    /**
     * Track cluster capture
     */
    trackClusterCapture() {
        this.progress.clustersCaptured++;
        this._checkBadgeUnlock('hostile_takeover');
        this._checkBadgeUnlock('corporate_raider');
        this._saveData();
    }

    /**
     * Track reconquest (recapturing lost hex quickly)
     */
    trackReconquest() {
        this.progress.reconquests++;
        this._checkBadgeUnlock('reconquista');
        this._saveData();
    }

    /**
     * Track joining a squad
     */
    trackSquadJoin() {
        this.progress.squadsJoined++;
        this._checkBadgeUnlock('squad_up');
        this._saveData();
    }

    /**
     * Track adding a friend
     */
    trackFriendAdded() {
        this.progress.friendsAdded++;
        this._checkBadgeUnlock('social_butterfly');
        this._checkBadgeUnlock('networker');
        this._saveData();
    }

    /**
     * Track sending a chat message
     */
    trackMessageSent() {
        this.progress.messagesSent++;
        this.progress.silentPlaytime = 0; // Reset silent timer
        this._checkBadgeUnlock('diplomat');
        this._saveData();
    }

    /**
     * Track faction switch
     */
    trackFactionSwitch(newFaction) {
        if (!this.progress.factionHistory.includes(newFaction)) {
            this.progress.factionHistory.push(newFaction);
            this.progress.factionsPlayed = this.progress.factionHistory.length;
        }
        this.progress.factionSwitches++;
        this._checkBadgeUnlock('turncoat');
        this._checkBadgeUnlock('triple_agent');
        this._saveData();
    }

    /**
     * Track screenshot taken
     */
    trackScreenshot() {
        this.progress.screenshotsTaken++;
        this._checkBadgeUnlock('photographer');
        this._saveData();
    }

    /**
     * Track social share
     */
    trackSocialShare() {
        this.progress.socialShares++;
        this._checkBadgeUnlock('influencer');
        this._saveData();
    }

    /**
     * Track Tusk setting change
     */
    trackTuskSettingChange(newSetting, oldSetting) {
        if (newSetting === 'off' && oldSetting !== 'off') {
            this.progress.tuskMuted++;
            this._checkBadgeUnlock('listener');
        } else if (newSetting === 'full' && oldSetting === 'off') {
            this.progress.tuskReEnabled++;
            this._checkBadgeUnlock('masochist');
        }
        this._saveData();
    }

    /**
     * Track Tusk callout
     */
    trackTuskCallout(isRoast = false) {
        this.progress.tuskCallouts++;
        if (isRoast) {
            this.progress.tuskRoasts++;
        }
        this._checkBadgeUnlock('tusks_favorite');
        this._checkBadgeUnlock('tusks_enemy');
        this._saveData();
    }

    /**
     * Track becoming commander
     */
    trackBecameCommander() {
        this.progress.timesCommander = (this.progress.timesCommander || 0) + 1;
        this._checkBadgeUnlock('field_promotion');
        this._checkBadgeUnlock('golden_hour');
        this._checkBadgeUnlock('golden_age');
        this._checkBadgeUnlock('gilded');
        this._saveData();
    }

    /**
     * Track commander time (call from game loop when player is commander)
     */
    trackCommanderTime(deltaSeconds) {
        this.progress.commanderTime = (this.progress.commanderTime || 0) + deltaSeconds;
        this._checkBadgeUnlock('golden_hour');
        this._checkBadgeUnlock('golden_age');
        this._checkBadgeUnlock('gilded');
    }

    /**
     * Track crypto tipped as commander
     */
    trackCryptoTipped(amount) {
        this.progress.cryptoTipped = (this.progress.cryptoTipped || 0) + amount;
        this._checkBadgeUnlock('generous_leader');
        this._saveData();
    }

    /**
     * Track tactical drawing as commander
     */
    trackTacticalDrawing() {
        this.progress.tacticalDrawings = (this.progress.tacticalDrawings || 0) + 1;
        this._checkBadgeUnlock('tactician');
        this._saveData();
    }

    /**
     * Track commander survival time without dying
     */
    trackCommanderSurvivalTime(deltaSeconds) {
        this.progress.commanderSurvivalTime = (this.progress.commanderSurvivalTime || 0) + deltaSeconds;
        this._checkBadgeUnlock('untouchable_commander');
    }

    /**
     * Track killing a commander
     */
    trackRegicide() {
        this.progress.regicideKills = (this.progress.regicideKills || 0) + 1;
        this._checkBadgeUnlock('regicide');
        this._saveData();
    }

    /**
     * Track being killed while commander
     */
    trackCommanderDeath() {
        this.progress.commanderDeaths = (this.progress.commanderDeaths || 0) + 1;
        this._checkBadgeUnlock('target_practice');
        // Reset survival time
        this.progress.commanderSurvivalTime = 0;
        this._saveData();
    }

    /**
     * Update pacifist timer (call from game loop)
     */
    updatePacifistTimer(deltaSeconds) {
        // Only count if player hasn't killed anyone since spawn
        if (this.progress.currentSessionKills === 0 ||
            (Date.now() - this.progress.lastKillTime) / 1000 > this.progress.pacifistTime) {
            this.progress.pacifistTime += deltaSeconds;
            this._checkBadgeUnlock('pacifist');
        }
    }

    // ========================
    // BADGE UNLOCKING
    // ========================

    _checkBadgeUnlock(badgeId) {
        // Skip if already unlocked
        if (this.unlockedBadges.some(b => b.id === badgeId)) {
            return false;
        }

        const badge = this.badges[badgeId];
        if (!badge) return false;

        // Check condition
        if (badge.condition(this.progress)) {
            this._unlockBadge(badgeId);
            return true;
        }

        return false;
    }

    _unlockBadge(badgeId) {
        const badge = this.badges[badgeId];
        if (!badge) return;

        // Add to unlocked list
        this.unlockedBadges.push({
            id: badgeId,
            unlockedAt: new Date().toISOString()
        });

        this._saveData();

        // Trigger callback
        if (this.onBadgeUnlock) {
            this.onBadgeUnlock(badge, this._getUnlockMessage(badgeId));
        }

    }

    _getUnlockMessage(badgeId) {
        return this.unlockMessages[badgeId] ||
            `Achievement unlocked: ${this.badges[badgeId]?.name}. Somehow.`;
    }

    /**
     * Check all badges (useful after loading stats from server)
     */
    checkAllBadges() {
        Object.keys(this.badges).forEach(badgeId => {
            this._checkBadgeUnlock(badgeId);
        });
    }

    // ========================
    // GETTERS
    // ========================

    /**
     * Get all unlocked badges
     */
    getUnlockedBadges() {
        return this.unlockedBadges.map(unlock => ({
            ...this.badges[unlock.id],
            unlockedAt: unlock.unlockedAt
        }));
    }

    /**
     * Get badge count
     */
    getBadgeCount() {
        return this.unlockedBadges.length;
    }

    /**
     * Get badges by category
     */
    getBadgesByCategory(category) {
        return Object.values(this.badges).filter(b => b.category === category);
    }

    /**
     * Check if a badge is unlocked
     */
    isBadgeUnlocked(badgeId) {
        return this.unlockedBadges.some(b => b.id === badgeId);
    }

    /**
     * Get a badge by ID
     */
    getBadge(badgeId) {
        return this.badges[badgeId];
    }

    /**
     * Get rarity color
     */
    getRarityColor(rarity) {
        return this.rarityColors[rarity] || '#ffffff';
    }

    /**
     * Get progress stats (for debugging)
     */
    getProgress() {
        return { ...this.progress };
    }

    // ========================
    // IMPORT/EXPORT (for server sync)
    // ========================

    /**
     * Import progress from server
     */
    importProgress(serverProgress) {
        // Merge server progress with local (keep higher values)
        Object.keys(serverProgress).forEach(key => {
            if (typeof serverProgress[key] === 'number') {
                this.progress[key] = Math.max(this.progress[key] || 0, serverProgress[key]);
            } else if (Array.isArray(serverProgress[key])) {
                // Merge arrays (e.g., factionHistory)
                this.progress[key] = [...new Set([
                    ...(this.progress[key] || []),
                    ...serverProgress[key]
                ])];
            }
        });

        // Check all badges with new progress
        this.checkAllBadges();
        this._saveData();
    }

    /**
     * Import unlocked badges from server
     */
    importUnlockedBadges(serverBadges) {
        serverBadges.forEach(serverBadge => {
            if (!this.unlockedBadges.some(b => b.id === serverBadge.id)) {
                this.unlockedBadges.push(serverBadge);
            }
        });
        this._saveData();
    }

    /**
     * Export data for server sync
     */
    exportData() {
        return {
            unlockedBadges: this.unlockedBadges,
            progress: this.progress
        };
    }

    // ========================
    // CLEANUP
    // ========================

    dispose() {
        if (this._sessionInterval) {
            clearInterval(this._sessionInterval);
        }
        this._saveData();
        this.hideBadgeTooltip();
    }

    // ========================
    // BADGE TOOLTIP (Floating)
    // ========================

    /**
     * Show badge tooltip as a floating element on body
     * Ensures tooltip stays within screen boundaries
     */
    showBadgeTooltip(badgeEl, badge) {
        this.hideBadgeTooltip();

        const color = this.getRarityColor(badge.rarity);

        const tooltip = document.createElement('div');
        tooltip.className = 'badge-tooltip-floating';
        tooltip.innerHTML = `
            <div class="badge-tooltip-name" style="color: ${color}">${badge.name}</div>
            <div class="badge-tooltip-desc">${badge.description}</div>
            <div class="badge-tooltip-rarity" style="color: ${color}">${badge.rarity}</div>
        `;

        document.body.appendChild(tooltip);
        this._activeTooltip = tooltip;
        this._activeTooltipBadge = badgeEl;

        // Position after adding to DOM so we can measure
        requestAnimationFrame(() => {
            this._positionTooltip(badgeEl, tooltip);
            tooltip.classList.add('visible');
        });
    }

    /**
     * Position tooltip near badge, keeping it within screen boundaries
     */
    _positionTooltip(badgeEl, tooltip) {
        const badgeRect = badgeEl.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const padding = 12; // Minimum distance from screen edges

        // Start by centering above the badge
        let left = badgeRect.left + (badgeRect.width / 2) - (tooltipRect.width / 2);
        let top = badgeRect.top - tooltipRect.height - 8;

        // Constrain horizontally
        if (left < padding) {
            left = padding;
        } else if (left + tooltipRect.width > window.innerWidth - padding) {
            left = window.innerWidth - tooltipRect.width - padding;
        }

        // If tooltip would go above screen, show below badge instead
        if (top < padding) {
            top = badgeRect.bottom + 8;
        }

        // Constrain vertically (in case below also doesn't fit)
        if (top + tooltipRect.height > window.innerHeight - padding) {
            top = window.innerHeight - tooltipRect.height - padding;
        }

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    }

    /**
     * Hide the active tooltip
     */
    hideBadgeTooltip() {
        if (this._activeTooltip) {
            this._activeTooltip.remove();
            this._activeTooltip = null;
            this._activeTooltipBadge = null;
        }
    }

    /**
     * Attach tooltip hover events to a badge element
     */
    attachTooltipEvents(badgeEl, badge) {
        badgeEl.addEventListener('mouseenter', () => {
            this.showBadgeTooltip(badgeEl, badge);
        });

        badgeEl.addEventListener('mouseleave', () => {
            this.hideBadgeTooltip();
        });
    }
}
