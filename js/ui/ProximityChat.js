/**
 * AdLands - Proximity Chat Module
 * Text-based proximity chat with message bubbles above player tags
 */

class ProximityChat {
    constructor(playerTags) {
        this.playerTags = playerTags;
        this.isInputActive = false;
        this.chatMode = 'faction'; // 'faction', 'lobby', or 'squad'
        this.MAX_CHARS = 50;
        this.MAX_MESSAGES = 3;
        this.MESSAGE_LIFETIME = 30000; // 30 seconds

        // Player faction and squad (set externally)
        this.playerFaction = 'cobalt';
        this.playerSquad = null;

        // HUD visibility (H key toggle) — when false, hide all bubbles
        this.hudVisible = true;

        // Store messages per tank: tankId → [{ text, timestamp, element }]
        this.messages = new Map();

        // Bubble containers per tank: tankId → container element
        this.bubbleContainers = new Map();

        // Trash talk lines - {name} will be replaced with nearby player/bot name
        this.trashTalkLines = [
            // Generic taunts
            "ez clap",
            "get rekt",
            "skill issue tbh",
            "gg no re",
            "too easy",
            "yawn",
            "is this ranked?",
            "bruh moment",
            "imagine losing lol",
            "stay mad",
            "cry more",
            "hold this L",
            "free territory",
            "thanks for the capture",
            "lmaooo",

            // Targeted taunts (use {name})
            "{name} is trash",
            "nice aim {name} lol",
            "{name} go back to tutorial",
            "where u going {name}?",
            "{name} scared?",
            "sit down {name}",
            "{name} is lost",
            "bye {name}",
            "{name} playing on a microwave",
            "was that {name}? didnt notice",
            "{name} needs a map",
            "later {name}",
            "{name} thought they had a chance",
            "imagine being {name} rn",
            "{name} down bad fr",

            // Faction pride
            "this is our turf now",
            "territory secured",
            "another one for us",
            "we run this",
            "cant stop us",
            "get off our land",
            "this hex is ours",
            "claiming this ez",

            // Reaction messages
            "oof",
            "rip bozo",
            "L + ratio",
            "no shot",
            "caught in 4k",
            "down horrendous",
            "skill diff",
            "massive cope",
            "touch grass",
            "cope and seethe",
            "mad cuz bad",

            // Aggro challenges
            "come at me bro!",
            "I fear no man",
            "show bobs + vegene",
            "witness me!"
        ];

        // Create input UI
        this._createInputUI();

        // Setup keyboard listeners
        this._setupKeyboardListeners();

        // Reference to ChatWindow (set externally)
        this.chatWindow = null;

        // Profanity filter for Tusk commentary
        this.profanityList = [
            'fuck', 'shit', 'damn', 'ass', 'bitch', 'crap', 'hell',
            'bastard', 'piss', 'dick', 'cock', 'pussy', 'cunt',
            'fck', 'fuk', 'sht', 'btch', 'a$$', 'sh1t', 'f*ck'
        ];

        // Reference to TuskCommentary (set externally)
        this.tuskCommentary = null;

        // Dead state - player cannot chat while dead
        this.isPlayerDead = false;

        // Faction ciphers (WoW-style substitution for enemy faction messages)
        // Each faction has its own cipher - same input always produces same output
        this.factionCiphers = {
            rust: {
                'a': 'o', 'b': 'k', 'c': 'g', 'd': 'r', 'e': 'a', 'f': 'n', 'g': 'l',
                'h': 'z', 'i': 'u', 'j': 'w', 'k': 'm', 'l': 'b', 'm': 'p', 'n': 'e',
                'o': 'i', 'p': 'f', 'q': 'x', 'r': 'd', 's': 't', 't': 'h', 'u': 'y',
                'v': 'c', 'w': 'j', 'x': 'q', 'y': 's', 'z': 'v'
            },
            cobalt: {
                'a': 'u', 'b': 'g', 'c': 'z', 'd': 'n', 'e': 'o', 'f': 'r', 'g': 'k',
                'h': 'a', 'i': 'e', 'j': 'p', 'k': 'w', 'l': 'd', 'm': 'h', 'n': 'i',
                'o': 'y', 'p': 'l', 'q': 'v', 'r': 'b', 's': 'm', 't': 'c', 'u': 'f',
                'v': 'j', 'w': 't', 'x': 's', 'y': 'q', 'z': 'x'
            },
            viridian: {
                'a': 'e', 'b': 'r', 'c': 'p', 'd': 'k', 'e': 'i', 'f': 'w', 'g': 'n',
                'h': 'o', 'i': 'a', 'j': 'v', 'k': 'z', 'l': 'g', 'm': 'f', 'n': 'u',
                'o': 'h', 'p': 'd', 'q': 'y', 'r': 'l', 's': 'c', 't': 'm', 'u': 's',
                'v': 'b', 'w': 'x', 'x': 'j', 'y': 't', 'z': 'q'
            }
        };

        // Squad glyph set (alien/encrypted symbols for other squads' messages)
        this.squadGlyphs = '⌁◊⏃⍟⌬⏁⎔⋔◬⏅⎅⬡⬢∿≋⏏⏚◇◈⌿⍜⎕⏣⏢';
    }

    /**
     * Create the chat input UI elements
     */
    _createInputUI() {
        this.inputContainer = document.createElement('div');
        this.inputContainer.id = 'chat-input-container';

        // Use input for single-line with horizontal auto-expand
        this.inputField = document.createElement('input');
        this.inputField.id = 'chat-input';
        this.inputField.type = 'text';
        this.inputField.maxLength = this.MAX_CHARS;
        this.inputField.placeholder = 'Type a message...';

        // Hidden span for measuring text width
        this.measureSpan = document.createElement('span');
        this.measureSpan.id = 'chat-input-measure';
        this.measureSpan.style.cssText = `
            position: absolute;
            visibility: hidden;
            white-space: pre;
            font-size: var(--font-size-body);
            font-family: var(--font-body);
        `;

        this.inputContainer.appendChild(this.inputField);
        document.body.appendChild(this.inputContainer);
        document.body.appendChild(this.measureSpan);

        // Auto-resize input width as user types
        this.inputField.addEventListener('input', () => {
            this._autoResizeInput();
        });

        // Handle input events
        this.inputField.addEventListener('keydown', (e) => {
            e.stopPropagation(); // Prevent game controls while typing

            if (e.key === 'Enter' && this.inputField.value.trim()) {
                this._sendMessage(this.inputField.value.trim(), this.chatMode);
                this._closeInput();
            } else if (e.key === 'Escape') {
                this._closeInput();
            }
        });

        // Prevent other keys from bubbling to game
        this.inputField.addEventListener('keyup', (e) => e.stopPropagation());
        this.inputField.addEventListener('keypress', (e) => e.stopPropagation());
    }

    /**
     * Auto-resize the input width to fit content
     */
    _autoResizeInput() {
        const text = this.inputField.value || this.inputField.placeholder;
        this.measureSpan.textContent = text;

        const minWidth = 120;
        const maxWidth = 500;
        const padding = 32; // Account for padding

        const measuredWidth = this.measureSpan.offsetWidth + padding;
        const newWidth = Math.max(minWidth, Math.min(measuredWidth, maxWidth));

        this.inputField.style.width = newWidth + 'px';
    }

    /**
     * Setup keyboard listeners for opening chat
     */
    _setupKeyboardListeners() {
        window.addEventListener('keydown', (e) => {
            // Don't open if typing in another input or already active
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
            if (this.isInputActive) return;

            // Enter = faction chat, Shift+Enter = lobby chat, Alt+Enter = squad chat
            // Cannot chat while dead
            if (e.key === 'Enter' && !this.isPlayerDead) {
                e.preventDefault();
                if (e.altKey) {
                    this.chatMode = 'squad';
                } else if (e.shiftKey) {
                    this.chatMode = 'lobby';
                } else {
                    this.chatMode = 'faction';
                }
                this._updateBorderColor();
                this._openInput();
            }
        });
    }

    /**
     * Update the border color based on chat mode
     * Colors match the chat panel header colors:
     * - Global/Lobby: gray (#aaaaaa)
     * - Faction: faction color (dynamic)
     * - Squad: purple (#a064dc)
     */
    _updateBorderColor() {
        if (this.chatMode === 'faction') {
            // Set border to faction color
            this._updateInputBorder();
        } else if (this.chatMode === 'squad') {
            // Set border to purple (matches squad chat header)
            this.inputContainer.style.setProperty('--chat-border-color', '#a064dc');
        } else {
            // Set border to gray (matches global chat header)
            this.inputContainer.style.setProperty('--chat-border-color', '#aaaaaa');
        }
    }

    /**
     * Update input border to match player's faction color
     */
    _updateInputBorder() {
        if (typeof FACTION_COLORS !== 'undefined' && FACTION_COLORS[this.playerFaction]) {
            this.inputContainer.style.setProperty('--chat-border-color', FACTION_COLORS[this.playerFaction].css);
        } else {
            // Fallback faction colors
            const fallbackColors = {
                'cobalt': '#00bfff',
                'rust': '#ff6347',
                'viridian': '#32cd32'
            };
            this.inputContainer.style.setProperty('--chat-border-color', fallbackColors[this.playerFaction] || '#ffd700');
        }
    }

    /**
     * Open the chat input field
     */
    _openInput() {
        this.isInputActive = true;
        this.inputContainer.classList.add('active');
        this.inputField.value = '';
        this.inputField.style.width = '120px';  // Reset to min width
        this.inputField.focus();
    }

    /**
     * Close the chat input field
     */
    _closeInput() {
        this.isInputActive = false;
        this.inputContainer.classList.remove('active');
        this.inputField.blur();
    }

    /**
     * Set player faction (called externally)
     */
    setPlayerFaction(faction) {
        this.playerFaction = faction;
    }

    /**
     * Set player squad (called externally)
     */
    setPlayerSquad(squad) {
        this.playerSquad = squad;
    }

    /**
     * Set player dead state - dead players cannot chat
     * @param {boolean} isDead - Whether the player is dead
     */
    setPlayerDead(isDead) {
        this.isPlayerDead = isDead;
        // Close chat input if player dies while typing
        if (isDead && this.isInputActive) {
            this._closeInput();
        }
    }

    /**
     * Send a message from the player
     * @param {string} text - Message text
     * @param {string} mode - 'faction', 'lobby', or 'squad'
     */
    _sendMessage(text, mode = 'faction') {
        // Check for profanity and trigger Tusk commentary
        if (this.tuskCommentary && this._containsProfanity(text)) {
            this.tuskCommentary.onFoulLanguage();
        }

        // Default to player tank
        this.addMessage('player', text, mode);

        // Send over network in multiplayer mode
        if (window.networkManager?.isMultiplayer) {
            window.networkManager.sendChat(text, mode);
        }
    }

    /**
     * Add a message to a tank's chat bubbles
     * @param {string} tankId - The tank identifier
     * @param {string} text - Message text
     * @param {string} mode - 'faction' (colored, faction-only), 'lobby' (normal, all see), or 'squad' (purple, squad-only)
     */
    addMessage(tankId, text, mode = 'lobby') {
        // Get tag info for ChatWindow
        const tagData = this.playerTags.tags.get(tankId);
        const senderName = tagData ? tagData.config.name : 'Unknown';
        const faction = tagData ? tagData.config.faction : 'cobalt';
        const isPlayer = tankId === 'player';
        // For player, use the authoritative playerSquad; for others, use tag config
        const senderSquad = isPlayer ? this.playerSquad : (tagData ? tagData.config.squad : null);

        // Determine if message should be scrambled
        const isSameFaction = faction === this.playerFaction;
        const isSameSquad = senderSquad && senderSquad === this.playerSquad;

        // Determine display text for chat bubbles based on clearance
        // Lobby: never scrambled - everyone can read
        // Faction: cipher for enemies in bubbles only
        // Squad: glyph scramble for other squads
        let displayText = text;
        let isScrambled = false;

        if (mode === 'faction' && !isSameFaction) {
            // Enemy faction chat: apply WoW-style cipher to bubbles
            displayText = this._applyFactionCipher(text, faction);
            isScrambled = true;
        } else if (mode === 'squad' && !isPlayer && !isSameSquad) {
            // Other squad's chat: apply alien glyph scramble
            displayText = this._applyGlyphScramble(text);
            isScrambled = true;
        }
        // Lobby mode: displayText stays as original text (no scrambling)

        // Send to ChatWindow if available (with original text for same-faction/squad)
        if (this.chatWindow) {
            if (mode === 'faction') {
                // Only add clear text to faction tab if same faction
                if (isSameFaction) {
                    this.chatWindow.addFactionMessage(senderName, text, faction, senderSquad, isPlayer, tankId);
                }
            } else if (mode === 'squad') {
                // Only add clear text to squad tab if same squad
                if (isPlayer || isSameSquad) {
                    this.chatWindow.addSquadMessage(senderName, text, faction, senderSquad, isPlayer, tankId);
                }
            } else {
                // Lobby: everyone can read - no cipher applied
                this.chatWindow.addMessage(senderName, text, faction, senderSquad, isPlayer, tankId);
            }
        }

        // Ensure we have a messages array for this tank
        if (!this.messages.has(tankId)) {
            this.messages.set(tankId, []);
        }

        const messages = this.messages.get(tankId);

        // Ensure we have a bubble container for this tank
        if (!this.bubbleContainers.has(tankId)) {
            const container = document.createElement('div');
            container.className = 'chat-bubbles-container';
            // Add 'other' class for non-player tanks (left-aligned)
            if (tankId !== 'player') {
                container.classList.add('other');
            }
            this.playerTags.container.appendChild(container);
            this.bubbleContainers.set(tankId, container);
        }

        const container = this.bubbleContainers.get(tankId);

        // Create the bubble element
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';

        // Faction messages get colored border/background
        if (mode === 'faction') {
            bubble.classList.add('faction-msg', faction);
            if (isScrambled) {
                bubble.classList.add('scrambled');
            }
        } else if (mode === 'squad') {
            // Squad messages get yellow styling
            bubble.classList.add('squad-msg');
            if (isScrambled) {
                bubble.classList.add('scrambled');
            }
        }

        bubble.textContent = displayText;

        // Add to DOM (at the beginning since we use column-reverse)
        container.insertBefore(bubble, container.firstChild);

        // Store message data
        const messageData = {
            text,
            timestamp: Date.now(),
            element: bubble
        };
        messages.unshift(messageData);

        // Update fading state for 3rd message
        this._updateFadingState(tankId);

        // Remove oldest message if we exceed max
        if (messages.length > this.MAX_MESSAGES) {
            const removed = messages.pop();
            removed.element.classList.add('fade-out');
            setTimeout(() => removed.element.remove(), 300);
        }

        // Schedule automatic removal after lifetime
        setTimeout(() => {
            this._removeMessage(tankId, messageData);
        }, this.MESSAGE_LIFETIME);
    }

    /**
     * Update the fading state for messages (3rd oldest = 50% opacity)
     * @param {string} tankId
     */
    _updateFadingState(tankId) {
        const messages = this.messages.get(tankId);
        if (!messages) return;

        messages.forEach((msg, index) => {
            // The 3rd message (index 2) should fade
            if (index === this.MAX_MESSAGES - 1) {
                msg.element.classList.add('fading');
            } else {
                msg.element.classList.remove('fading');
            }
        });
    }

    /**
     * Remove a specific message
     * @param {string} tankId
     * @param {Object} messageData
     */
    _removeMessage(tankId, messageData) {
        const messages = this.messages.get(tankId);
        if (!messages) return;

        const index = messages.indexOf(messageData);
        if (index === -1) return; // Already removed

        // Fade out and remove
        messageData.element.classList.add('fade-out');
        setTimeout(() => {
            messageData.element.remove();
            messages.splice(index, 1);
            this._updateFadingState(tankId);
        }, 300);
    }

    /**
     * Clear all chat bubbles for a tank (e.g., on death)
     * @param {string} tankId - The tank identifier
     */
    clearMessages(tankId) {
        const messages = this.messages.get(tankId);
        if (!messages) return;

        // Fade out over 2 seconds (death fade)
        messages.forEach(msg => {
            msg.element.classList.add('death-fade');
            setTimeout(() => msg.element.remove(), 2000);
        });

        // Clear the messages array
        this.messages.set(tankId, []);
    }

    /**
     * Update bubble container positions - call every frame
     * This positions the bubble container above each player's tag
     * OPTIMIZED: Uses cached position values from PlayerTags to avoid getBoundingClientRect()
     */
    update() {
        // Early exit if no bubbles to update
        if (this.bubbleContainers.size === 0) return;

        // Hide all bubbles when HUD is hidden
        if (!this.hudVisible) {
            for (const container of this.bubbleContainers.values()) {
                container.style.display = 'none';
            }
            return;
        }

        for (const [tankId, container] of this.bubbleContainers) {
            const tagData = this.playerTags.tags.get(tankId);
            if (!tagData) {
                container.style.display = 'none';
                continue;
            }

            // Use cached visibility and position from PlayerTags (avoids getBoundingClientRect)
            if (tagData.lastVisible === false || tagData.lastX === -9999) {
                container.style.display = 'none';
                continue;
            }

            // Use cached position values from PlayerTags
            // tagData.lastY is the anchor point (bottom of tag due to translate -100%)
            // Tag height is ~60px (title + panel + healthbar), so top is at lastY - 60
            // Position 10px above the top of the tag
            const tagHeight = 60;
            const y = tagData.lastY - tagHeight - 10;

            container.style.display = 'flex';
            container.style.bottom = (window.innerHeight - y) + 'px';

            // Player tank: right-aligned, Other tanks: left-aligned
            // Estimate tag width (~120px typical) for alignment
            const estimatedTagHalfWidth = 60;
            if (tankId === 'player') {
                container.style.left = '';
                container.style.right = (window.innerWidth - tagData.lastX - estimatedTagHalfWidth) + 'px';
            } else {
                container.style.right = '';
                container.style.left = (tagData.lastX - estimatedTagHalfWidth) + 'px';
            }

            // Use cached opacity from PlayerTags
            container.style.opacity = tagData.lastOpacity >= 0 ? tagData.lastOpacity : 1;
        }
    }

    /**
     * Check if chat input is currently active
     * @returns {boolean}
     */
    isActive() {
        return this.isInputActive;
    }

    /**
     * Get a random trash talk line, optionally targeting a name
     * @param {string|null} targetName - Name to insert into {name} placeholder
     * @returns {string}
     */
    getRandomTrashTalk(targetName = null) {
        const line = this.trashTalkLines[Math.floor(Math.random() * this.trashTalkLines.length)];

        if (targetName && line.includes('{name}')) {
            return line.replace('{name}', targetName);
        }

        // If line needs a name but none provided, pick a different line
        if (line.includes('{name}')) {
            // Filter to lines without {name}
            const genericLines = this.trashTalkLines.filter(l => !l.includes('{name}'));
            return genericLines[Math.floor(Math.random() * genericLines.length)];
        }

        return line;
    }

    /**
     * Check if text contains profanity
     * @param {string} text - Text to check
     * @returns {boolean}
     */
    _containsProfanity(text) {
        const lowerText = text.toLowerCase().replace(/[^a-z]/g, '');
        return this.profanityList.some(word => {
            const cleanWord = word.toLowerCase().replace(/[^a-z]/g, '');
            return lowerText.includes(cleanWord);
        });
    }

    /**
     * Apply faction cipher to text (WoW-style substitution)
     * Used for enemy faction messages - looks like a foreign language
     * @param {string} text - Original text
     * @param {string} faction - The sender's faction
     * @returns {string} - Ciphered text
     */
    _applyFactionCipher(text, faction) {
        const cipher = this.factionCiphers[faction];
        if (!cipher) return text;

        return text.split('').map(char => {
            const lower = char.toLowerCase();
            if (cipher[lower]) {
                // Preserve case
                const ciphered = cipher[lower];
                return char === char.toUpperCase() ? ciphered.toUpperCase() : ciphered;
            }
            // Keep punctuation, numbers, spaces unchanged
            return char;
        }).join('');
    }

    /**
     * Apply glyph scrambling to text (alien symbols)
     * Used for other squads' messages - completely unreadable
     * @param {string} text - Original text
     * @returns {string} - Glyph-scrambled text
     */
    _applyGlyphScramble(text) {
        return text.split('').map(char => {
            // Keep spaces and some punctuation for readability
            if (char === ' ' || char === '!' || char === '?' || char === '.') {
                return char;
            }
            // Replace letters and numbers with random glyphs
            if (/[a-zA-Z0-9]/.test(char)) {
                // Use character code as seed for consistent-ish scrambling
                const idx = char.charCodeAt(0) % this.squadGlyphs.length;
                return this.squadGlyphs[idx];
            }
            return char;
        }).join('');
    }

    /**
     * Clean up
     */
    dispose() {
        this.inputContainer.remove();
        for (const container of this.bubbleContainers.values()) {
            container.remove();
        }
        this.bubbleContainers.clear();
        this.messages.clear();
    }
}

/**
 * ChatWindow - Traditional chat window with Clan/Faction/Lobby sections
 */
class ChatWindow {
    constructor() {
        this.squadEl = document.getElementById('chat-squad');
        this.factionEl = document.getElementById('chat-faction');
        this.lobbyEl = document.getElementById('chat-lobby');

        // Get chat window container
        this.chatWindow = document.getElementById('chat-window');

        // Get section elements for resize
        this.squadSection = this.squadEl ? this.squadEl.closest('.chat-section') : null;
        this.factionSection = this.factionEl ? this.factionEl.closest('.chat-section') : null;
        this.lobbySection = this.lobbyEl ? this.lobbyEl.closest('.chat-section') : null;

        // Get header elements for count updates
        this.squadHeader = document.getElementById('chat-header-squad');
        this.factionHeader = document.getElementById('chat-header-faction');
        this.lobbyHeader = document.getElementById('chat-header-lobby');

        this.MAX_MESSAGES = 50; // Per section
        this.playerFaction = 'cobalt'; // Default, updated externally
        this.playerSquad = '7"Army'; // Default, updated externally

        // Player counts
        this.squadCount = 0;
        this.factionCount = 0;
        this.totalCount = 0;

        // Initialize resize handles
        this._initResizeHandles();
    }

    /**
     * Initialize resize handles for dragging between sections
     */
    _initResizeHandles() {
        const handles = document.querySelectorAll('.chat-resize-handle');

        handles.forEach(handle => {
            let isDragging = false;
            let startY = 0;
            let startHeights = { above: 0, below: 0 };
            let aboveSection = null;
            let belowSection = null;

            const onMouseDown = (e) => {
                e.preventDefault();
                isDragging = true;
                startY = e.clientY;
                handle.classList.add('dragging');

                // Get sections based on data attributes
                const aboveType = handle.dataset.above;
                const belowType = handle.dataset.below;

                aboveSection = this.chatWindow.querySelector(`.chat-section.${aboveType}`);
                belowSection = this.chatWindow.querySelector(`.chat-section.${belowType}`);

                if (aboveSection && belowSection) {
                    startHeights.above = aboveSection.offsetHeight;
                    startHeights.below = belowSection.offsetHeight;
                }

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            };

            const onMouseMove = (e) => {
                if (!isDragging || !aboveSection || !belowSection) return;

                const deltaY = e.clientY - startY;
                const minHeight = 60; // Minimum section height

                // Calculate new heights
                let newAboveHeight = startHeights.above + deltaY;
                let newBelowHeight = startHeights.below - deltaY;

                // Enforce minimum heights
                if (newAboveHeight < minHeight) {
                    newAboveHeight = minHeight;
                    newBelowHeight = startHeights.above + startHeights.below - minHeight;
                }
                if (newBelowHeight < minHeight) {
                    newBelowHeight = minHeight;
                    newAboveHeight = startHeights.above + startHeights.below - minHeight;
                }

                // Apply new heights as flex-basis in pixels
                aboveSection.style.flex = `0 0 ${newAboveHeight}px`;
                belowSection.style.flex = `0 0 ${newBelowHeight}px`;
            };

            const onMouseUp = () => {
                isDragging = false;
                handle.classList.remove('dragging');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };

            handle.addEventListener('mousedown', onMouseDown);
        });
    }

    /**
     * Set player info for filtering
     */
    setPlayerInfo(faction, squad) {
        this.playerFaction = faction;
        this.playerSquad = squad;
        this._updateFactionHeaderColor();
    }

    /**
     * Update player counts displayed in chat headers
     * @param {number} squadCount - Number of players in the same squad
     * @param {number} factionCount - Number of players in the same faction
     * @param {number} totalCount - Total number of players on server
     */
    updatePlayerCounts(squadCount, factionCount, totalCount) {
        this.squadCount = squadCount;
        this.factionCount = factionCount;
        this.totalCount = totalCount;

        if (this.squadHeader) {
            this.squadHeader.textContent = `Squad [${squadCount}]`;
        }
        if (this.factionHeader) {
            this.factionHeader.textContent = `Faction [${factionCount}]`;
        }
        if (this.lobbyHeader) {
            this.lobbyHeader.textContent = `Global [${totalCount}]`;
        }
    }

    /**
     * Update faction chat header to match player's faction color
     */
    _updateFactionHeaderColor() {
        if (!this.factionHeader) return;

        // Fallback colors with matching backgrounds (same color at 15% opacity)
        const fallbackColors = {
            'cobalt': { color: '#4477cc', bg: 'rgba(68, 119, 204, 0.15)' },
            'rust': { color: '#cc4444', bg: 'rgba(204, 68, 68, 0.15)' },
            'viridian': { color: '#44aa44', bg: 'rgba(68, 170, 68, 0.15)' }
        };

        if (typeof FACTION_COLORS !== 'undefined' && FACTION_COLORS[this.playerFaction]) {
            const fc = FACTION_COLORS[this.playerFaction];
            this.factionHeader.style.color = fc.css;
            // Convert hex to rgba for background (same color at 15% opacity)
            const hex = fc.hex;
            const r = (hex >> 16) & 255;
            const g = (hex >> 8) & 255;
            const b = hex & 255;
            this.factionHeader.style.background = `rgba(${r}, ${g}, ${b}, 0.15)`;
        } else {
            const fc = fallbackColors[this.playerFaction] || fallbackColors.cobalt;
            this.factionHeader.style.color = fc.color;
            this.factionHeader.style.background = fc.bg;
        }
    }

    /**
     * Add a lobby message to the chat window (visible to all)
     * @param {string} senderName - Name of the sender
     * @param {string} text - Message text
     * @param {string} faction - Sender's faction (rust/cobalt/viridian)
     * @param {string|null} squad - Sender's squad (or null)
     * @param {boolean} isPlayer - Whether this is the local player
     * @param {string} tankId - Tank identifier for profile card
     */
    addMessage(senderName, text, faction, squad = null, isPlayer = false, tankId = null) {
        // Lobby messages only appear in lobby tab
        this._addToSection(this.lobbyEl, senderName, text, faction, isPlayer, tankId);
    }

    /**
     * Add a faction-only message (not visible in lobby)
     * @param {string} senderName - Name of the sender
     * @param {string} text - Message text
     * @param {string} faction - Sender's faction (rust/cobalt/viridian)
     * @param {string|null} squad - Sender's squad (or null)
     * @param {boolean} isPlayer - Whether this is the local player
     * @param {string} tankId - Tank identifier for profile card
     */
    addFactionMessage(senderName, text, faction, squad = null, isPlayer = false, tankId = null) {
        // Faction messages only appear in faction tab (for same faction only)
        if (faction === this.playerFaction) {
            this._addToSection(this.factionEl, senderName, text, faction, isPlayer, tankId);
        }
    }

    /**
     * Add a squad-only message (only visible in squad tab)
     * @param {string} senderName - Name of the sender
     * @param {string} text - Message text
     * @param {string} faction - Sender's faction (rust/cobalt/viridian)
     * @param {string|null} squad - Sender's squad (or null)
     * @param {boolean} isPlayer - Whether this is the local player
     * @param {string} tankId - Tank identifier for profile card
     */
    addSquadMessage(senderName, text, faction, squad = null, isPlayer = false, tankId = null) {
        // For player's own messages, always show in squad panel
        // For others, only show if they're in the same squad
        if (isPlayer || (squad && squad === this.playerSquad)) {
            this._addToSection(this.squadEl, senderName, text, faction, isPlayer, tankId);
        }
    }

    /**
     * Add a system message to a section
     * @param {string} section - 'squad', 'faction', or 'lobby'
     * @param {string} text - System message text
     */
    addSystemMessage(section, text) {
        let el;
        switch (section) {
            case 'squad': el = this.squadEl; break;
            case 'faction': el = this.factionEl; break;
            default: el = this.lobbyEl;
        }

        const msgEl = document.createElement('div');
        msgEl.className = 'chat-msg system';
        msgEl.textContent = text;
        el.appendChild(msgEl);
        this._trimMessages(el);
        el.scrollTop = el.scrollHeight;
    }

    /**
     * Add a Lord Elon (Tusk) message to the global/lobby chat
     * @param {string} text - Lord Elon's message
     */
    addTuskMessage(text) {
        if (!this.lobbyEl) return;

        const msgEl = document.createElement('div');
        msgEl.className = 'chat-msg tusk-msg';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'msg-name tusk';
        nameSpan.textContent = '👑 Lord Elon:';

        // Parse @mentions and make them clickable
        const textSpan = document.createElement('span');
        textSpan.className = 'msg-text';
        textSpan.appendChild(document.createTextNode(' '));
        this._parseMentions(text, textSpan);

        msgEl.appendChild(nameSpan);
        msgEl.appendChild(textSpan);
        this.lobbyEl.appendChild(msgEl);

        this._trimMessages(this.lobbyEl);
        this.lobbyEl.scrollTop = this.lobbyEl.scrollHeight;
    }

    /**
     * Parse @mentions in text and create clickable spans
     * @param {string} text - Text potentially containing @mentions
     * @param {HTMLElement} container - Element to append parsed content to
     */
    _parseMentions(text, container) {
        // Regex to match @playerName (alphanumeric + underscores)
        const mentionRegex = /@(\w+)/g;
        let lastIndex = 0;
        let match;

        while ((match = mentionRegex.exec(text)) !== null) {
            // Add text before the mention
            if (match.index > lastIndex) {
                container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            // Create clickable mention span
            const mentionSpan = document.createElement('span');
            mentionSpan.className = 'chat-mention';
            mentionSpan.textContent = match[0]; // includes the @

            // Try to find player ID by name
            if (window.profileCard) {
                const playerId = window.profileCard.getPlayerIdByName(match[1]);
                if (playerId) {
                    mentionSpan.dataset.playerId = playerId;
                }
            }

            container.appendChild(mentionSpan);
            lastIndex = mentionRegex.lastIndex;
        }

        // Add remaining text after last mention
        if (lastIndex < text.length) {
            container.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
    }

    /**
     * Internal: add message to a specific section
     * @param {HTMLElement} sectionEl - The section element to add to
     * @param {string} senderName - Name of the sender
     * @param {string} text - Message text
     * @param {string} faction - Sender's faction
     * @param {boolean} isPlayer - Whether this is the local player
     * @param {string} tankId - Tank identifier for profile card
     */
    _addToSection(sectionEl, senderName, text, faction, isPlayer, tankId = null) {
        const msgEl = document.createElement('div');
        msgEl.className = 'chat-msg';

        // Check if sender is a commander
        const isCommander = window.commanderSystem && tankId && window.commanderSystem.isCommander(tankId);
        if (isCommander) {
            msgEl.classList.add('commander', faction);
        }

        const nameSpan = document.createElement('span');
        // Always color by faction - enemies show their faction color, allies show theirs
        nameSpan.className = `msg-name ${faction}`;
        nameSpan.textContent = senderName + ':';

        // Add data-player-id for profile card right-click
        if (tankId) {
            nameSpan.dataset.playerId = tankId;
        }

        const textSpan = document.createElement('span');
        textSpan.className = 'msg-text';
        textSpan.textContent = text;

        msgEl.appendChild(nameSpan);
        msgEl.appendChild(textSpan);
        sectionEl.appendChild(msgEl);

        this._trimMessages(sectionEl);
        sectionEl.scrollTop = sectionEl.scrollHeight;
    }

    /**
     * Trim old messages if exceeding max
     */
    _trimMessages(sectionEl) {
        while (sectionEl.children.length > this.MAX_MESSAGES) {
            sectionEl.removeChild(sectionEl.firstChild);
        }
    }

    /**
     * Clear all messages in the faction chat tab
     * Called when player switches factions
     */
    clearFactionChat() {
        if (this.factionEl) {
            this.factionEl.innerHTML = '';
        }
    }
}
