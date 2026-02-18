/**
 * AdLands - Elon Tusk Commentary System
 * Sports-announcer style commentary from the CEO of AdLands
 * GTA1-style murmur audio + subtitles
 */

// Embedded dialogue lines (avoids CORS issues with file:// protocol)
const TUSK_LINES = {
  on_kill: [
    "Hostile eliminated! That's what I call aggressive market expansion.",
    "Confirmed termination. Their clone bill just went up.",
    "Excellent aggression metrics! Keep that KDR climbing.",
    "Neutralized! Remember, violence is just negotiation with explosions.",
    "Another competitor disrupted. Permanently.",
  ],
  on_death: [
    "You've been terminated. Cloning you now — please hold.",
    "Death is just involuntary respawning. You're fine.",
    "Wow. That was expensive. Try blocking next time?",
    "Casualty logged. Your replacement is printing as we speak.",
    "Oof. Well, that's why we have insurance. Well, no you. But we do.",
  ],
  on_capture: [
    "Territory acquired! Shareholders will be pleased.",
    "Excellent work! That hex is now monetized.",
    "I love the smell of profit in the morning!",
    "Capturing hexes — this is what vertical integration looks like.",
    "Prime real estate secured. Property values are going up. For me.",
    "Step 1: Capture territory, Step 2: Hold territory, Step 3: Profit!",
    "Amazing team work on that territory capture - MY teamwork.",
  ],
  on_rent_territory: [
    "@{player} is a land baron now. As for the rest of the lobby: your poverty disgusts me.",
    "BREAKING: @{player} signed a lease. Welcome to the property ladder. The rest of you? Still homeless.",
    "@{player} is officially a real estate mogul. Meanwhile, the rest of you are basically squatters.",
    "@{player} rented territory and honestly? The rest of you look poor by comparison. Just saying.",
    "@{player} is renting from ME. I want the rest of you to think about what that says about your life choices.",
    "REAL ESTATE UPDATE: @{player} just upgraded from 'homeless' to 'slumlord.' The rest of you remain unhoused.",
    "@{player} just rented territory. To everyone else camping on free land: gentrification is coming.",
    "@{player} just rented land. One of you finally understands economics. The rest of you are a rounding error.",
    "@{player} just made a power move. The rest of you should be taking notes.",
    "@{player} — a player of taste and strategy. Everyone else? Noted.",
    "Big landlord energy from @{player} right there. The lobby just got a little more unequal.",
    "@{player}'s territory just increased in value by 300%. Source: me. I make the numbers up.",
  ],
  on_lose_territory: [
    "Territorial loss detected. Someone's shareholders are unhappy.",
    "Remember, failure is just success that hasn't happened yet or whatever it is they say. Just get it done!",
    "They took that hex from you. I'm not angry, just... disappointed. And angry.",
    "Lost ground there. Daddy's going to need you to try a little harder, alright?",
    "Your quarterly performance review is coming up. No pressure.",
    "You lost territory. I don't want excuses! I want results!",
  ],
  on_killstreak: [
    "Three confirmed kills! You're in the top performance quartile!",
    "Five eliminations! You're practically printing money for me.",
    "Killing spree! This is the kind of productivity I tweet about.",
    "Absolutely dominating! Our engagement metrics are through the roof!",
  ],
  on_shield: [
    "Shield deployed! Smart use of company resources.",
    "Damage mitigation detected. Very cost-conscious of you.",
    "Nice block! That's the risk management our investors love.",
  ],
  on_orbital_strike: [
    "Orbital bombardment authorized! NOW this is disruptive innovation!",
    "BOOM! That's what I call a hostile takeover!",
    "Firing the space laser! Who says infrastructure can't be fun?",
    "Excellent use of assets. That explosion cost $47,000, by the way.",
  ],
  on_deploy_turret: [
    "Turret deployed! Passive income generation at its finest.",
    "Automated defense online. I love replacing humans with machines.",
    "Turret active! Set it and forget it—the AdLands way.",
  ],
  on_mine_kill: [
    "BOOM! Your mine just paid dividends!",
    "Mine detonation confirmed! ROI: excellent.",
    "They walked right into it! I love predictable consumer behavior.",
  ],
  on_portal_use: [
    "Portal transit detected. Fast Travel — another AdLands innovation!",
    "Teleporting! That's $12 in infrastructure costs, FYI.",
    "Quantum gate utilized. Efficiency is our middle name. Well, it's 'Limited Liability,' but still.",
  ],
  random_ambient: [
    "Remember: every action is data. Make it good data.",
    "Fun fact: Earth is still technically habitable. Barely.",
    "You're doing great! Probably. I don't actually check individual stats.",
    "AdLands: Where death is just an operational expense.",
    "Combat is just aggressive networking with explosions.",
    "Sometimes I wonder if we went too far. Then I check my bank account.",
    "Your sacrifice today funds tomorrow's expansion. You're welcome.",
    "Reminder: All combat footage is property of AdLands Holdings.",
    "Do you ever feel... watched? That's just our analytics suite. It's fine.",
    "This planet cost $47 trillion to build. No pressure.",
    "I had a dream once. Then I monetized it. This is that dream.",
    "Hydration reminder! Dehydrated mercenaries have 11% lower engagement.",
    "Your mercenary contract includes dental! Well, clone-dental. It's complicated.",
    "AdLands is an equal opportunity destroyer of ecosystems.",
    "Every hex captured is a hex monetized. Someone's always winning. Usually me.",
    "Sponsors love consistency. Try to die in the same spot for marketing purposes.",
    "Remember: there's no 'I' in 'team,' but there IS one in 'liability.'",
    "Quick reminder that Earth is watching. Make humanity proud. Or don't. We're past that.",
    "Chapter #128 in my best-selling book 'Tusk Tusk Tusk': 'Do as you're told!'",
  ],
  // Separate tips array for more frequent delivery to new players
  tips_and_tricks: [
    // Combat basics
    "Pro tip: Shooting at enemies is 100% more effective than shooting at nothing. You're welcome.",
    "Quick tip: If you're dying a lot, have you tried... not standing still?",
    "Tip: The shield ability exists. I know, revolutionary concept.",
    "Here's a thought: enemies behind cover are harder to hit. So flank them. Basic geometry.",
    "Pro tip: Bullets travel in straight lines. Aim where they're going, not where they are.",
    "Tip: If you're getting shot, you're in someone's line of sight. Consider... moving.",
    "Pro tip: Strafing while shooting makes you harder to hit. Basic survival economics.",
    "Tip: Check your six. Enemies love sneaking up on distracted contractors.",
    // Territory basics
    "Territory tip: Capturing hexes near your base creates buffer zones. It's called strategy.",
    "Pro tip: Defending territory is easier than recapturing it. Think about that.",
    "Here's a concept: Capturing clusters near portals gives you faster reinforcement routes.",
    "Tip: Don't spread too thin. Even I know you can't be everywhere at once. Yet.",
    "Quick tip: Watch the minimap. It's there for a reason. Several reasons, actually.",
    "Territory advice: Sometimes retreating to regroup beats dying heroically. We have metrics.",
    "Tip: Contested hexes flash on the map. Pay attention — someone's stealing your revenue.",
    "Pro tip: Hexes near enemy clusters are harder to hold. Pick your battles wisely.",
    // Abilities
    "Pro tip: Your abilities have cooldowns. Use them wisely. Or don't. Entertainment either way.",
    "The orbital strike is best used on groups. One target? That's just showing off.",
    "Turrets work best covering chokepoints. Random placement is... creative, I guess.",
    "Mines are invisible to enemies. Place them on high-traffic hexes. Surprise economics.",
    "Tip: Portal placement is an art. A profitable, shareholder-pleasing art.",
    "Pro tip: Save your shield for when you NEED it. Panic-shielding wastes cooldowns.",
    "Tip: Abilities recharge faster when you're capturing hexes. Synergy!",
    // Meta/teamwork
    "Quick tip: Playing with your faction helps everyone. Shocking concept, teamwork.",
    "Here's wisdom: The best players check their surroundings before engaging. Paranoia pays.",
    "Pro tip: If you keep dying to the same player, try a different approach. Definition of insanity, etc.",
    "Tip: Sound cues exist. Tanks are loud. Use that information commercially — I mean tactically.",
    "Here's a thought: Your kill/death ratio affects faction morale. No pressure. Actually, lots of pressure.",
    "Pro tip: The leaderboard shows who's dangerous. Maybe don't fight them alone?",
    "Tip: Respawning takes time. Time you could spend capturing hexes. Every second is money.",
    "Quick wisdom: A strategic retreat is not cowardice. It's resource preservation. I do it with stocks all the time.",
    "Pro tip: Stick with teammates early on. Lone wolves get eaten by... other lone wolves.",
    "Tip: Your faction chat exists. Use it. Coordination beats chaos. Usually.",
    // New player specific
    "New here? Press TAB to see the scoreboard. Knowledge is power. And power is money.",
    "Tip for rookies: The glowing hexes are capture points. Stand on them. Profit.",
    "New contractor tip: Your tank has multiple abilities. Check your keybinds!",
    "Beginner tip: Follow the experienced players. Learn from their expensive mistakes.",
    "Pro tip for newbies: Dying is fine. Dying repeatedly in the same spot is a pattern.",
    "New player advice: Explore the map early. Learn the terrain before it learns you.",
    // Humor
    "Life tip: If at first you don't succeed, respawn and try again. Clone bills are my problem.",
    "Pro tip: Blaming lag is acceptable up to three times per session. After that, it's you.",
    "Tip: Screaming at your screen doesn't improve accuracy. I've studied this. Extensively.",
    "Here's advice: Sometimes the best strategy is patience. I wouldn't know, but I've heard things.",
    "Pro tip: If everyone is your enemy, you might be playing this wrong. Or very, very right.",
    "Quick tip: Taking breaks prevents tilt. But also reduces my engagement metrics. Tough call.",
  ],
  match_start: [
    "Welcome back, contractor! Time to generate some shareholder value!",
    "New session starting. Remember: every action is monetizable data.",
    "Let's make today profitable for me — I mean, for everyone!",
    "The early bird catches the worm. Get busy and destroy the infidels.",
  ],
  on_foul_language: [
    "Whoa! Language! We have investors watching these streams!",
    "That kind of talk could tank our stock price. Think of the shareholders!",
    "HR is going to have a field day with that one. I'm CC'd on everything, you know.",
    "Remember, everything you say is logged and monetized. Keep it family-friendly!",
    "Our sponsors prefer... cleaner dialogue. Think of the brand deals!",
    "Easy there! We're trying to go public next quarter.",
    "That's going straight to the content moderation team. Which is also me.",
    "Profanity detected! Your clone's vocabulary package is being reviewed.",
    "Do you kiss my mother with that mouth?!",
  ],
  faction_leading: [
    "Your faction is dominating! This is the kind of market share I dream about.",
    "Global supremacy achieved! Well, almost. Keep those numbers up!",
    "Look at that map coverage! Our shareholders are literally weeping with joy.",
    "Your faction controls more territory than any other. This is what winning looks like!",
    "Dominant faction detected! I might even consider giving you a raise. Might.",
  ],
  faction_losing: [
    "Your faction is... underperforming. Globally. Very globally.",
    "Last place? Really? This is not the quarterly report I wanted to see.",
    "Your faction holds the least territory. Pathetic.",
    "Looks like your team needs to step it up. Way up. Like, all the way up.",
    "Dead last in global control. But hey, at least you're consistent!",
    "Your faction is losing the territory race. Time to get aggressive or get replaced!",
  ],
  player_top_of_leaderboard: [
    "You're number one! Finally, someone who understands the assignment.",
    "Top of the leaderboard! This is the kind of performance I put on promotional materials.",
    "You're leading your faction! I might just mention you in the next investor call.",
    "First place! You're making your faction proud. More importantly, you're making ME proud.",
    "Look at you, top of the charts! This is what peak ROI looks like, people.",
    "Number one on the leaderboard! Don't let it go to your head. Actually, do. You've earned it.",
    "First place in your faction leaderboard? I might name my 21st child after you!",
    "You are the best performing member of your faction.... What a try-hard!",
  ],
  on_broke: [
    "You can't afford that. Try being better at capitalism.",
    "Insufficient funds. Have you tried not being poor?",
    "Your wallet says no. Maybe earn some crypto first.",
    "Broke. The word you're looking for is broke.",
    "That costs money. Which you don't have. Awkward.",
    "Your bank account just sent me a distress signal.",
    "Error: funds not found. Have you considered winning more?",
  ],
  on_loan: [
    "Welcome to debt! I knew you'd end up here eventually.",
    "Negative balance. I'll add it to your clone bill.",
    "You owe me money now. I love this game.",
    "Going negative? Bold financial strategy. Let's see how it plays out.",
    "Debt mode activated. Your respawns are now sponsored by embarrassment.",
    "Congrats on your new loan! The interest rate is... unfavorable.",
    "You're in the red now. My favorite color when it's someone else's balance.",
  ],
  on_level_up: [
    "Level up! Your performance metrics just improved. Marginally.",
    "Congratulations on leveling up! Your clone is now slightly more expensive to replace.",
    "New level achieved! I'm upgrading your employee status from 'expendable' to 'slightly less expendable.'",
    "Level up! This calls for a raise! Just kidding. Keep grinding.",
    "Another level! Your skill tree is looking almost as impressive as my stock portfolio.",
    "Leveled up! You know what this means? More responsibilities. No extra pay though.",
    "New level unlocked! I'd say you've earned a bonus, but let's not get carried away.",
    "Level up detected! Your productivity curve is beautiful. Almost brings a tear to my eye.",
    "Congratulations! You're now qualified for missions that pay... exactly the same.",
    "Level milestone achieved! I'm adding this to your quarterly performance review.",
    "You leveled up! Time to update your LinkedIn. Wait, does LinkedIn still exist?",
    "New level! You're climbing the corporate ladder. Well, you're a mercenary, so it's more like a corporate rope.",
    "Level up! Your character sheet looks great. Your retirement plan, however...",
    "Ding! New level! If only real life had crypto bars, am I right?",
    "Leveled up! Don't spend all those skill points in one place. Actually, spend them however. I don't care.",
    "Another level in the bag! You're becoming a real asset. A depreciating asset, but still.",
    "Level up! This is the kind of personal growth our HR department loves to see!",
    "New level achieved! Your value to the company just increased by... carry the one... almost nothing!",
  ],
  // Commander-specific messages
  on_new_commander: [
    "New Commander @{player} has been assigned. Try not to disappoint. Again.",
    "Commander @{player} reporting for duty. Security detail attached.",
    "@{player} is now Commander. The gold trim is ready. Try to keep it.",
    "Congratulations @{player}! You're now Commander. The bodyguards cost extra, FYI.",
    "New leadership detected! @{player} is now calling the shots. Shareholders, adjust your expectations.",
  ],
  on_commander_demotion: [
    "@{player} has been demoted. The gold has been repossessed.",
    "Former Commander @{player} returns to the ranks. How the mighty fall.",
    "@{player} is no longer Commander. Security detail reassigned.",
    "Leadership change! @{player}'s corner office is now vacant.",
    "Demotion logged. @{player}, please return your gold trim at your earliest convenience.",
  ],
  on_commander_death: [
    "Commander down! Leadership vacuum detected.",
    "Commander @{player} has been eliminated. Bodyguards failed spectacularly.",
    "The Commander is dead. Long live the Commander.",
    "Commander eliminated! Someone's performance review just got... complicated.",
    "High-value target neutralized! The enemy gets a bonus for that one.",
  ],
  on_bodyguard_death: [
    "Commander's bodyguard down. Budget cuts incoming.",
    "@{player} just killed the Commander's escort. Bold move.",
    "Bodyguard eliminated. The Commander stands slightly less protected.",
    "Security detail reduced by 50%. Well, one guy anyway.",
    "That bodyguard had a family! Well, a clone-family. Same thing.",
  ],
  // Global chat announcements when tips are given (shown to everyone)
  on_commander_tip: [
    "BREAKING: @{to} just received ¢{amount} from the Commander. Wealth redistribution in action!",
    "ALERT: Commander @{from} has blessed @{to} with ¢{amount}. Remember to thank your overlords.",
    "@{to} received a tip from the Commander. Teacher's pet detected. Other contractors take note.",
    "NOTICE: @{to} just got ¢{amount} from the Commander. Favoritism? We prefer 'strategic incentivization.'",
    "CRYPTO TRANSFER: @{to} is now ¢{amount} richer. The Commander's generosity knows bounds. Specifically, budget bounds.",
    "ECONOMY UPDATE: @{to} received ¢{amount}. Trickle-down economics at its finest. Well, trickle.",
    "Commander @{from} just tipped @{to}. This is basically a gold star in grown-up mercenary terms.",
    "ATTENTION: @{to} has been financially validated by the Commander. The rest of you... try harder.",
    "@{to} just got compensated for existing near the Commander. Performance reviews work!",
    "MORALE BOOST: @{to} received ¢{amount}. This in no way creates unhealthy workplace competition.",
  ],
  // Local commentary for the player who RECEIVED a tip
  on_tip_received: [
    "Congratulations! You've been tipped ¢{amount} by Commander @{from}. Don't spend it all in one respawn.",
    "You just received ¢{amount} from @{from}. This is basically a raise. Enjoy your 0.002% wealth increase.",
    "Commander @{from} deemed you worthy of ¢{amount}. Frame this moment. It may not happen again.",
    "INCOMING: ¢{amount} from @{from}. Remember: gratitude is mandatory but smiling is optional.",
    "You've been tipped! @{from} just gave you ¢{amount}. Quick, look busy so it happens again.",
    "¢{amount} received from Commander @{from}. This counts as your holiday bonus, by the way.",
    "Wow! @{from} gave you ¢{amount}. You must have done something right. Don't let it go to your head.",
    "TIP RECEIVED: ¢{amount} from @{from}. The algorithm has identified you as 'not entirely useless.'",
  ],
  // Local commentary for the player who SENT a tip (the Commander)
  on_tip_sent: [
    "You just gave @{to} ¢{amount}. How generous. How very... tax-deductible.",
    "Tip sent! @{to} now owes you exactly nothing. That's how tips work. I checked.",
    "You tipped @{to} ¢{amount}. Spreading wealth like a true corporate benefactor.",
    "¢{amount} deployed to @{to}. Your generosity will be noted in their performance file. And yours.",
    "You just redistributed ¢{amount} to @{to}. Look at you, playing favorites like a real leader!",
    "Tip complete! @{to} received ¢{amount}. This is the closest thing to socialism we allow here.",
    "Budget allocation to @{to}: ¢{amount}. Very philanthropic. Very 'I'm a good person.'",
    "@{to} got your ¢{amount}. Remember: generosity builds loyalty. Also, dependency. Mostly dependency.",
  ],
  on_commander_drawing: [
    "Commander is drawing. Pay attention or don't. Your funeral.",
    "Tactical markup detected. The gold crayon is out.",
    "Commander @{player} is micromanaging from orbit. Classic management move.",
    "Drawing detected! I'm sure it's very tactical and not just a doodle.",
    "The Commander is communicating through the ancient art of... scribbling.",
  ],
  on_commander_resign: [
    "The Commander has stepped down for {duration}. How very... humble. Suspicious, even.",
    "BREAKING: Commander resigned for {duration}. Corporate will be reviewing this decision.",
    "Leadership vacuum detected! Commander out for {duration}. Chaos, meet opportunity.",
    "The Commander needs 'personal time' ({duration}). We call this 'strategic retreat.'",
    "Commander resignation filed. Duration: {duration}. Your replacement is already warming the seat.",
    "Taking a break from leadership for {duration}? Bold move. Let's see if anyone notices.",
    "Commander out for {duration}. Remember: the throne is always warm when you return. Very warm. Suspiciously warm.",
  ],
  on_commander_returns: [
    "Step aside @{acting}, Daddy @{commander} is home.",
    "The real Commander @{commander} is back. @{acting}, hand over the gold trim.",
    "BREAKING: @{commander} has returned. @{acting}'s temporary authority has been... terminated.",
    "Commander @{commander} is online. @{acting}, your audition is over.",
    "Plot twist! @{commander} returns. @{acting}, please vacate the corner office.",
  ],
};

class TuskCommentary {
  constructor() {
    this.lines = TUSK_LINES; // Use embedded lines
    this.isVisible = false;
    this.queue = []; // Queue of pending messages
    this.cooldowns = new Map(); // Event type → last trigger time
    this.currentTimeout = null; // Current display timeout

    // Commentary mode: 'full' | 'important' | 'off'
    this.commentaryMode = "full";

    // Event priority for filtering based on commentary mode
    this.eventPriority = {
      on_kill: "full",
      on_death: "important",
      on_capture: "full",
      on_rent_territory: "important",
      on_lose_territory: "important",
      on_killstreak: "full",
      on_shield: "full",
      on_portal_use: "full",
      on_orbital_strike: "important",
      on_deploy_turret: "full",
      on_mine_kill: "full",
      random_ambient: "full",
      tips_and_tricks: "full",
      on_foul_language: "important",
      faction_leading: "important",
      faction_losing: "important",
      player_top_of_leaderboard: "important",
      on_level_up: "important",
      match_start: "important",
      // Commander events
      on_new_commander: "important",
      on_commander_demotion: "important",
      on_commander_death: "important",
      on_commander_resign: "important",
      on_bodyguard_death: "full",
      on_commander_tip: "full",
      on_tip_received: "important",
      on_tip_sent: "full",
      on_commander_drawing: "full",
      on_broke: "important",
      on_loan: "important",
    };

    // Cooldown durations (ms) - 4x original for less frequent commentary
    this.COOLDOWNS = {
      on_capture: 20000,
      on_rent_territory: 0,
      on_lose_territory: 40000,
      on_kill: 12000,
      on_death: 20000,
      on_killstreak: 40000,
      on_shield: 32000,
      on_portal_use: 120000,
      random_ambient: 120000,
      tips_and_tricks: 45000, // Tips appear more frequently (45 seconds cooldown)
      on_foul_language: 30000,
      faction_leading: 60000,
      faction_losing: 60000,
      player_top_of_leaderboard: 60000,
      on_level_up: 0, // No cooldown - always comment on level ups
      // Commander events
      on_new_commander: 0, // Always announce commander changes
      on_commander_demotion: 0,
      on_commander_death: 20000,
      on_commander_resign: 0, // Always announce resignations
      on_bodyguard_death: 30000,
      on_commander_tip: 60000,
      on_tip_received: 0, // Always notify recipient
      on_tip_sent: 0, // Always notify sender
      on_commander_drawing: 120000,
      on_commander_returns: 0, // Always announce when true commander returns
      on_broke: 30000,
      on_loan: 0, // Always comment on loans
    };

    // Suppression flag — prevents _show() during terminal sequence
    this.suppressed = false;

    // UI elements (created dynamically)
    this.container = null;
    this.speechElement = null;

    // Reference to ChatWindow for global chat posting (set by main.js)
    this.chatWindow = null;

    // Tusk global chat system
    this.tuskChat = null; // Initialized after chatWindow is set

    // New player tips system - more frequent tips in first 10 minutes
    this.sessionStartTime = Date.now();
    this.newPlayerDuration = 600000; // 10 minutes of "new player" mode
    this.tipsShown = 0;
    this.usedTips = new Set(); // Track shown tips to avoid repeats

    this._createUI();
    this._startAmbientTimer();
    this._startTipsTimer();

    // Show match start message after a short delay
    setTimeout(() => this.onMatchStart(), 2000);

    // Show first tip quickly for new players (after 10-15 seconds)
    setTimeout(() => this._showTip(), 10000 + Math.random() * 5000);

  }

  /**
   * Set commentary mode (from settings)
   * @param {string} mode - 'full' | 'important' | 'off'
   */
  setCommentaryMode(mode) {
    this.commentaryMode = mode;
  }

  setSuppressed(flag) {
    this.suppressed = flag;
    if (flag) {
      if (this.isVisible) {
        this.container.style.display = "none";
        this.container.classList.remove("tusk-enter", "tusk-exit");
        this.isVisible = false;
        if (this.currentTimeout) {
          clearTimeout(this.currentTimeout);
          this.currentTimeout = null;
        }
      }
      this.queue = [];
    }
  }

  /**
   * Check if event should trigger based on current commentary mode
   * @param {string} eventType - The event type to check
   * @returns {boolean}
   */
  _shouldTrigger(eventType) {
    if (this.commentaryMode === "off") return false;

    const priority = this.eventPriority[eventType] || "full";
    if (this.commentaryMode === "important" && priority === "full") {
      return false;
    }

    return true;
  }

  /**
   * Initialize global chat system after chatWindow is set
   */
  initGlobalChat() {
    if (this.chatWindow && !this.tuskChat) {
      this.tuskChat = new TuskGlobalChat(this);
    }
  }

  _createUI() {
    // Create container
    this.container = document.createElement("div");
    this.container.id = "tusk-dialogue";
    this.container.innerHTML = `
            <div class="tusk-portrait">
                <img src="assets/tusk.png" alt="Elon Tusk">
            </div>
            <div class="tusk-content">
                <div class="tusk-name">Elon Tusk</div>
                <div class="tusk-title">CEO, AdLands</div>
                <div class="tusk-speech"></div>
            </div>
        `;
    document.body.appendChild(this.container);

    this.speechElement = this.container.querySelector(".tusk-speech");
  }

  _canTrigger(eventType) {
    const now = Date.now();
    const lastTrigger = this.cooldowns.get(eventType) || 0;
    const cooldown = this.COOLDOWNS[eventType] || 5000;

    if (now - lastTrigger < cooldown) {
      return false;
    }

    this.cooldowns.set(eventType, now);
    return true;
  }

  _getRandomLine(category) {
    if (!this.lines || !this.lines[category]) {
      return null;
    }
    const lines = this.lines[category];
    return lines[Math.floor(Math.random() * lines.length)];
  }

  _calculateDuration(text) {
    // ~180ms per character, min 11.25s, max 27s (50% increase from previous)
    const charDuration = text.length * 180;
    return Math.min(Math.max(charDuration, 11250), 27000);
  }

  // ========================
  // PUBLIC EVENT TRIGGERS
  // ========================

  onCapture(faction, clusterId) {
    if (!this._shouldTrigger("on_capture")) return;
    if (!this._canTrigger("on_capture")) return;
    const line = this._getRandomLine("on_capture");
    if (line) this._queueMessage(line);
  }

  onRentTerritory(playerName) {
    if (!this._shouldTrigger("on_rent_territory")) return;
    if (!this._canTrigger("on_rent_territory")) return;
    let line = this._getRandomLine("on_rent_territory");
    if (line) {
      line = line.replace("{player}", playerName || "Someone");
      this._queueMessage(line);
    }
  }

  onLoseTerritory(faction, clusterId) {
    if (!this._shouldTrigger("on_lose_territory")) return;
    if (!this._canTrigger("on_lose_territory")) return;
    const line = this._getRandomLine("on_lose_territory");
    if (line) this._queueMessage(line);
  }

  onKill(killerFaction, victimFaction) {
    if (!this._shouldTrigger("on_kill")) return;
    if (!this._canTrigger("on_kill")) return;
    const line = this._getRandomLine("on_kill");
    if (line) this._queueMessage(line);
  }

  onDeath(playerFaction) {
    if (!this._shouldTrigger("on_death")) return;
    if (!this._canTrigger("on_death")) return;
    const line = this._getRandomLine("on_death");
    if (line) this._queueMessage(line);
  }

  onKillstreak(count) {
    if (!this._shouldTrigger("on_killstreak")) return;
    if (!this._canTrigger("on_killstreak")) return;
    const line = this._getRandomLine("on_killstreak");
    if (line) this._queueMessage(line);
  }

  onShieldBlock() {
    if (!this._shouldTrigger("on_shield")) return;
    if (!this._canTrigger("on_shield")) return;
    const line = this._getRandomLine("on_shield");
    if (line) this._queueMessage(line);
  }

  onPortalUse() {
    if (!this._shouldTrigger("on_portal_use")) return;
    if (!this._canTrigger("on_portal_use")) return;
    const line = this._getRandomLine("on_portal_use");
    if (line) this._queueMessage(line);
  }

  onOrbitalStrike() {
    if (!this._shouldTrigger("on_orbital_strike")) return;
    // No cooldown for ultimates - always exciting!
    const line = this._getRandomLine("on_orbital_strike");
    if (line) this._queueMessage(line);
  }

  onDeployTurret() {
    if (!this._shouldTrigger("on_deploy_turret")) return;
    const line = this._getRandomLine("on_deploy_turret");
    if (line) this._queueMessage(line);
  }

  onMineKill() {
    if (!this._shouldTrigger("on_mine_kill")) return;
    const line = this._getRandomLine("on_mine_kill");
    if (line) this._queueMessage(line);
  }

  onMatchStart() {
    if (!this._shouldTrigger("match_start")) return;
    const line = this._getRandomLine("match_start");
    if (line) this._queueMessage(line);
  }

  onFoulLanguage() {
    if (!this._shouldTrigger("on_foul_language")) return;
    if (!this._canTrigger("on_foul_language")) return;
    const line = this._getRandomLine("on_foul_language");
    if (line) this._showImmediate(line); // Highest priority - show immediately
  }

  onFactionLeading() {
    if (!this._shouldTrigger("faction_leading")) return;
    if (!this._canTrigger("faction_leading")) return;
    const line = this._getRandomLine("faction_leading");
    if (line) this._queueMessage(line);
  }

  onFactionLosing() {
    if (!this._shouldTrigger("faction_losing")) return;
    if (!this._canTrigger("faction_losing")) return;
    const line = this._getRandomLine("faction_losing");
    if (line) this._queueMessage(line);
  }

  onPlayerTopOfLeaderboard() {
    if (!this._shouldTrigger("player_top_of_leaderboard")) return;
    if (!this._canTrigger("player_top_of_leaderboard")) return;
    const line = this._getRandomLine("player_top_of_leaderboard");
    if (line) this._queueMessage(line);
  }

  onLevelUp(newLevel, oldLevel) {
    if (!this._shouldTrigger("on_level_up")) return;
    if (!this._canTrigger("on_level_up")) return;
    const line = this._getRandomLine("on_level_up");
    if (line) this._queueMessage(line);
  }

  onBroke() {
    if (!this._shouldTrigger("on_broke")) return;
    if (!this._canTrigger("on_broke")) return;
    const line = this._getRandomLine("on_broke");
    if (line) this._queueMessage(line);
  }

  onLoan() {
    if (!this._shouldTrigger("on_loan")) return;
    if (!this._canTrigger("on_loan")) return;
    const line = this._getRandomLine("on_loan");
    if (line) this._queueMessage(line);
  }

  // ========================
  // DISPLAY MANAGEMENT
  // ========================

  /**
   * Show a message immediately, interrupting any current message
   * Used for high-priority messages like profanity warnings
   */
  _showImmediate(text) {
    // Clear current timeout and hide current message instantly
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
    }
    // Clear the queue - this message takes priority
    this.queue = [];
    // Show immediately
    this._show(text);
  }

  _queueMessage(text) {
    this.queue.push(text);
    if (!this.isVisible) {
      this._processQueue();
    }
  }

  _processQueue() {
    if (this.queue.length === 0) {
      return;
    }

    const text = this.queue.shift();
    this._show(text);
  }

  _show(text) {
    if (!this.container || !this.speechElement) return;
    if (this.suppressed) return;

    this.isVisible = true;
    this.speechElement.textContent = text;
    this.container.style.display = "flex";
    this.container.classList.add("tusk-enter");

    // Calculate display duration
    const duration = this._calculateDuration(text);

    // Clear any existing timeout
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
    }

    // Hide after duration
    this.currentTimeout = setTimeout(() => {
      this._hide();
    }, duration);
  }

  _hide() {
    if (!this.container) return;

    this.container.classList.remove("tusk-enter");
    this.container.classList.add("tusk-exit");

    setTimeout(() => {
      this.container.style.display = "none";
      this.container.classList.remove("tusk-exit");
      this.isVisible = false;

      // Process next message in queue
      if (this.queue.length > 0) {
        setTimeout(() => this._processQueue(), 500);
      }
    }, 300);
  }

  // ========================
  // AMBIENT COMMENTARY
  // ========================

  _startAmbientTimer() {
    // Random ambient commentary every 180-360 seconds (4x original)
    const scheduleNext = () => {
      const delay = 180000 + Math.random() * 180000;
      setTimeout(() => {
        if (!this.isVisible && this.queue.length === 0) {
          if (
            this._shouldTrigger("random_ambient") &&
            this._canTrigger("random_ambient")
          ) {
            const line = this._getRandomLine("random_ambient");
            if (line) this._queueMessage(line);
          }
        }
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  // ========================
  // TIPS & TRICKS SYSTEM
  // ========================

  /**
   * Check if player is still in "new player" window (first 10 minutes)
   */
  _isNewPlayer() {
    return Date.now() - this.sessionStartTime < this.newPlayerDuration;
  }

  /**
   * Get a random tip that hasn't been shown yet (or reset if all shown)
   */
  _getUniqueTip() {
    const tips = this.lines.tips_and_tricks;
    if (!tips || tips.length === 0) return null;

    // Reset used tips if we've shown them all
    if (this.usedTips.size >= tips.length) {
      this.usedTips.clear();
    }

    // Find an unused tip
    let attempts = 0;
    let tip;
    do {
      tip = tips[Math.floor(Math.random() * tips.length)];
      attempts++;
    } while (this.usedTips.has(tip) && attempts < 20);

    this.usedTips.add(tip);
    return tip;
  }

  /**
   * Show a tip immediately (if conditions allow)
   */
  _showTip() {
    if (!this._shouldTrigger("tips_and_tricks")) return;
    if (!this._canTrigger("tips_and_tricks")) return;
    if (this.isVisible || this.queue.length > 0) return;

    const tip = this._getUniqueTip();
    if (tip) {
      this.tipsShown++;
      this._queueMessage(tip);
    }
  }

  /**
   * Start the tips timer - more frequent for new players
   */
  _startTipsTimer() {
    const scheduleNextTip = () => {
      // New players get tips every 60-90 seconds
      // Experienced players get tips every 120-180 seconds
      let minDelay, maxDelay;

      if (this._isNewPlayer()) {
        minDelay = 60000; // 1 minute
        maxDelay = 90000; // 1.5 minutes
      } else {
        minDelay = 120000; // 2 minutes
        maxDelay = 180000; // 3 minutes
      }

      const delay = minDelay + Math.random() * (maxDelay - minDelay);

      setTimeout(() => {
        this._showTip();
        scheduleNextTip();
      }, delay);
    };

    // Start after initial delay (handled separately in constructor)
    setTimeout(scheduleNextTip, 60000);
  }

  // ========================
  // COMMANDER EVENTS
  // ========================

  onNewCommander(playerName, faction) {
    if (!this._shouldTrigger("on_new_commander")) return;
    if (!this._canTrigger("on_new_commander")) return;
    let line = this._getRandomLine("on_new_commander");
    if (line) {
      line = line.replace("{player}", playerName);
      this._queueMessage(line);
    }
  }

  onCommanderDemotion(playerName) {
    if (!this._shouldTrigger("on_commander_demotion")) return;
    if (!this._canTrigger("on_commander_demotion")) return;
    let line = this._getRandomLine("on_commander_demotion");
    if (line) {
      line = line.replace("{player}", playerName);
      this._queueMessage(line);
    }
  }

  onCommanderDeath(playerName) {
    if (!this._shouldTrigger("on_commander_death")) return;
    if (!this._canTrigger("on_commander_death")) return;
    let line = this._getRandomLine("on_commander_death");
    if (line) {
      line = line.replace("{player}", playerName);
      this._queueMessage(line);
    }
  }

  onCommanderResign(durationText) {
    if (!this._shouldTrigger("on_commander_resign")) return;
    if (!this._canTrigger("on_commander_resign")) return;
    let line = this._getRandomLine("on_commander_resign");
    if (line) {
      line = line.replace("{duration}", durationText);
      this._queueMessage(line);
    }
  }

  onBodyguardDeath(killerName) {
    if (!this._shouldTrigger("on_bodyguard_death")) return;
    if (!this._canTrigger("on_bodyguard_death")) return;
    let line = this._getRandomLine("on_bodyguard_death");
    if (line) {
      line = line.replace("{player}", killerName);
      this._queueMessage(line);
    }
  }

  /**
   * Called for global chat announcement when any tip happens
   */
  onCommanderTip(fromName, toName, amount) {
    if (!this._shouldTrigger("on_commander_tip")) return;
    if (!this._canTrigger("on_commander_tip")) return;
    let line = this._getRandomLine("on_commander_tip");
    if (line) {
      line = line
        .replace("{from}", fromName)
        .replace("{to}", toName)
        .replace("{amount}", amount);
      this._queueMessage(line);
    }
  }

  /**
   * Called when the local player RECEIVES a tip (shows in their Tusk panel)
   */
  onTipReceived(fromName, amount) {
    if (!this._shouldTrigger("on_tip_received")) return;
    if (!this._canTrigger("on_tip_received")) return;
    let line = this._getRandomLine("on_tip_received");
    if (line) {
      line = line.replace("{from}", fromName).replace("{amount}", amount);
      this._queueMessage(line);
    }
  }

  /**
   * Called when the local player SENDS a tip (shows in their Tusk panel)
   */
  onTipSent(toName, amount) {
    if (!this._shouldTrigger("on_tip_sent")) return;
    if (!this._canTrigger("on_tip_sent")) return;
    let line = this._getRandomLine("on_tip_sent");
    if (line) {
      line = line.replace("{to}", toName).replace("{amount}", amount);
      this._queueMessage(line);
    }
  }

  onCommanderDrawing(playerName) {
    if (!this._shouldTrigger("on_commander_drawing")) return;
    if (!this._canTrigger("on_commander_drawing")) return;
    let line = this._getRandomLine("on_commander_drawing");
    if (line) {
      line = line.replace("{player}", playerName);
      this._queueMessage(line);
    }
  }

  /**
   * Called when commander changes (from commanderSystem)
   * Determines whether to show promotion or demotion message
   */
  onCommanderChange(newCommander, oldCommander, faction) {
    if (oldCommander && oldCommander.username) {
      this.onCommanderDemotion(oldCommander.username);
    }
    if (newCommander && newCommander.username) {
      // Slight delay to separate messages
      setTimeout(
        () => {
          this.onNewCommander(newCommander.username, faction);
        },
        oldCommander ? 3000 : 0,
      );
    }
  }

  /**
   * Called when the true commander returns online, replacing an acting commander
   */
  onCommanderReturns(commanderName, actingName) {
    if (!this._shouldTrigger("on_commander_returns")) return;
    if (!this._canTrigger("on_commander_returns")) return;
    let line = this._getRandomLine("on_commander_returns");
    if (line) {
      line = line.replace("{commander}", commanderName).replace("{acting}", actingName);
      this._queueMessage(line);
    }
  }
}

/**
 * TuskGlobalChat - Lord Elon posts messages to the global chat tab
 * Separate from the bottom-left commentary panel
 */
class TuskGlobalChat {
  constructor(tuskCommentary) {
    this.tusk = tuskCommentary;
    this.lastMessageTime = Date.now(); // Start with current time to prevent immediate quiet lobby trigger
    this.messageCount = 0;
    this.hourStart = Date.now();

    // Callback to resolve a playerId to its current display name (set by main.js)
    // Used for deferred name resolution so Tusk always uses current gamer tag
    this.getPlayerNameById = null;

    // Configuration
    this.config = {
      minInterval: 180000, // 3 minutes minimum between messages
      maxInterval: 600000, // 10 minutes max quiet time before random message
      maxPerHour: 8, // Limit messages per hour
      eventCooldown: 15000, // 15 second delay after event before posting

      // Probability of commenting on events
      eventChance: {
        kill: 0.05,
        killStreak: 0.4,
        deathStreak: 0.3,
        clusterCapture: 0.3,
        factionLeadChange: 0.2,
        factionStruggle: 0.1,
        playerMilestone: 0.6,
        revengeKill: 0.25,
        proximityBuddies: 0.2,
        quietLobby: 0.05,
        randomChaos: 0.05,
      },
    };

    // Message templates (mostly player-specific callouts)
    this.templates = {
      kill: [
        "@{killer} just eliminated @{victim}. {victimFaction} loses another contractor.",
        "@{killer} sends @{victim} to the respawn queue. Business as usual.",
        "RIP @{victim}. @{killer} didn't even hesitate.",
        "@{victim} has been decommissioned by @{killer}. Condolences to their K/D ratio.",
        "@{killer} vs @{victim}. Spoiler: @{victim} lost.",
        "Another one bites the dust. @{killer} takes out @{victim}.",
      ],
      killStreak: [
        "@{player} is on a {count} kill streak. Someone stop them. Or don't. Entertainment value is high.",
        "@{player} has {count} kills in a row. This is either skill or everyone else is terrible.",
        "{count} consecutive kills for @{player}. At this point it's just bullying.",
        "@{player}, slow down! You're making everyone else look bad. Which I appreciate.",
        "Everyone take notes. @{player} is showing you how it's done.",
        "@{player} with {count} kills! HR is going to need a bigger 'Employee of the Month' plaque.",
      ],
      deathStreak: [
        "@{player} has died {count} times in {minutes} minutes. Inspirational persistence or tragic incompetence?",
        "@{player} is speedrunning the respawn screen. {count} deaths and counting.",
        "Someone check on @{player}. {count} deaths suggests a cry for help.",
        "@{player}, at this rate your clone bill is going to exceed your salary.",
        "@{player}, have you considered... not dying? Just a thought.",
        "I'm not saying @{player} is bad, but their K/D ratio just filed for bankruptcy.",
      ],
      clusterCapture: [
        "@{player} just took the {cluster} cluster. Someone's getting a promotion.",
        "@{player} conquered {cluster}. The sponsor will be pleased. Probably.",
        "Nice work @{player}! The {cluster} cluster is now generating revenue. For me.",
        "@{player} claims {cluster}! That's the kind of initiative I pretend to reward.",
        "The {cluster} cluster falls to @{player}. Previous owners: skill issue.",
      ],
      factionLead: [
        "{faction} now controls {percent}% of the planet. {loser1}, {loser2} — are you even trying?",
        "{faction} takes the lead with {percent}%. The other factions are invited to cope.",
        "New standings: {faction} at {percent}%. Corporate is watching.",
        "MARKET REPORT: {faction} stock is UP. {loser1} and {loser2} stock is... well, I wouldn't invest.",
        "{faction} at {percent}%. That's called market dominance. {loser1} and {loser2}, that's called getting acquired.",
        "If {faction} were a company, I'd buy shares. If {loser1} or {loser2} were companies, I'd short them into the ground.",
        "{faction} is running this planet at {percent}%. {loser1} and {loser2} are just renting space at this point. From {faction}.",
        "BREAKING: {faction} controls {percent}% of the map. I'm starting to think {loser1} and {loser2} are here for the vibes, not the victory.",
      ],
      factionStruggle: [
        "{faction} controls just {percent}% of the planet. Should I start writing their eulogy?",
        "{faction} at {percent}% territory. That's not a faction, that's a parking spot.",
        "Thoughts and prayers for {faction}. {percent}% and sinking.",
        "{faction} is at {percent}%. At this point they're paying rent on someone else's land.",
        "Someone check {faction}'s pulse. {percent}% territory isn't a strategy, it's a cry for help.",
        "INVESTOR ALERT: {faction} is at {percent}%. I'm pulling their funding. Effective immediately. I'm kidding. They never had funding.",
        "{faction} at {percent}%. I've seen startups fail more gracefully than this.",
        "If {faction} were a stock it'd be delisted. {percent}% territory is not even a rounding error.",
        "{faction} holds {percent}% of the planet. That's less than my personal bathroom. And I would know — it's massive.",
        "BREAKING: {faction} territory has dropped to {percent}%. At this rate they'll be a Wikipedia article by tomorrow.",
      ],
      playerMilestone: [
        "@{player} just hit {count} kills this session. Somebody's gunning for Employee of the Month.",
        "{count} kills for @{player}. That's not a contractor, that's a natural disaster.",
        "@{player} reached {count} eliminations. HR is reviewing the footage.",
        "MILESTONE: @{player} has {count} kills. The rest of you should be embarrassed.",
        "@{player} with {count} kills. At this rate, we'll need to order more clones.",
      ],
      proximityBuddies: [
        "@{player1} and @{player2}, get a room already!",
        "@{player1}, give @{player2} some space before they file a restraining order!",
        "@{player1}, you're following @{player2} around like a lost puppy. Cute! Pathetic, but cute.",
        "Are @{player1} and @{player2} forming an alliance or just bad at personal space?",
        "@{player1} and @{player2} are inseparable. Should I be concerned?",
      ],
      revengeKill: [
        "@{killer} just got revenge on @{victim}! That's what I call conflict resolution.",
        "@{killer} remembered what @{victim} did. And chose violence.",
        "Payback delivered! @{killer} sends @{victim} back to respawn.",
        "@{killer} to @{victim}: 'Remember me?' Apparently they do now.",
      ],
      quietLobby: [
        "It's been {minutes} minutes without drama. What am I paying you for?!",
        "Did everyone fall asleep? The metrics are flatlining here.",
      ],
      randomChaos: [
        "Performance reviews are next week. Just kidding. Or am I?",
        "Fun fact: one of you is secretly my favorite. Guess who. It's probably not you.",
      ],
      commanderReturns: [
        "Step aside @{acting}, Daddy @{commander} is home.",
        "Commander @{commander} is back online. @{acting}, your watch has ended.",
        "BREAKING: The real Commander @{commander} has returned. Acting Commander @{acting}, please return the gold trim.",
        "@{commander} is back. @{acting}, it was fun while it lasted.",
        "The Commander has returned! @{acting}, back to the ranks with you.",
      ],
    };

    // Start periodic random chaos messages
    this._startRandomChaosTimer();

    // Start quiet lobby checker
    this._startQuietChecker();

    // Send initial welcome message after deployment
    this._sendWelcomeMessage();
  }

  /**
   * Send a welcome message shortly after game starts
   */
  _sendWelcomeMessage() {
    const welcomeMessages = [
      "Welcome to AdLands, contractors! Remember: every death funds my next yacht.",
      "Another day, another opportunity to generate shareholder value through violence.",
      "Good to see you all online. Now get out there and capture some territory!",
      "AdLands welcomes you. Your performance is being monitored. Always.",
      "Contractors deployed. Let the territorial disputes begin!",
    ];

    // Send welcome message 15-30 seconds after initialization
    setTimeout(
      () => {
        if (this.tusk.commentaryMode !== "off") {
          const msg =
            welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];
          this._sendMessage(msg);
        }
      },
      15000 + Math.random() * 15000,
    );
  }

  /**
   * Check if we can send a message (rate limiting)
   */
  canSendMessage() {
    const now = Date.now();

    // Reset hourly counter
    if (now - this.hourStart > 3600000) {
      this.hourStart = now;
      this.messageCount = 0;
    }

    if (this.messageCount >= this.config.maxPerHour) return false;
    if (now - this.lastMessageTime < this.config.minInterval) return false;

    return true;
  }

  /**
   * Re-resolve the human player's name at send time.
   * Only resolves the "player" ID — bot names stay as captured at event time
   * (bots respawn as different characters, so their event-time name is correct).
   */
  _resolvePlayerNames(data, playerRefs) {
    if (!playerRefs || !this.getPlayerNameById) return data;
    const resolved = { ...data };
    for (const [key, playerId] of Object.entries(playerRefs)) {
      if (playerId !== "player") continue;
      const currentName = this.getPlayerNameById(playerId);
      if (currentName) {
        resolved[key] = currentName;
      }
    }
    return resolved;
  }

  /**
   * @param {string} eventType
   * @param {Object} data - Template data (player names as fallback values)
   * @param {Object} [playerRefs] - Map of data key → playerId for deferred name resolution
   */
  onEvent(eventType, data, playerRefs) {
    // Respect Tusk commentary mode setting
    if (this.tusk.commentaryMode === "off") return;
    if (!this.canSendMessage()) return;

    const chance = this.config.eventChance[eventType] || 0.5;
    if (Math.random() > chance) return;

    setTimeout(() => {
      // Re-resolve human player's name at send time (picks up profile/gamer tag changes).
      // Bot names stay as captured at event time — they're correct for the event.
      const resolved = this._resolvePlayerNames(data, playerRefs);
      const message = this._generateMessage(eventType, resolved);
      if (message) {
        this._sendMessage(message);
      }
    }, this.config.eventCooldown);
  }

  /**
   * Generate a message from templates
   */
  _generateMessage(eventType, data) {
    const templates = this.templates[eventType];
    if (!templates || templates.length === 0) return null;

    const template = templates[Math.floor(Math.random() * templates.length)];
    return this._fillTemplate(template, data);
  }

  /**
   * Fill template placeholders with data
   */
  _fillTemplate(template, data) {
    let message = template;
    for (const [key, value] of Object.entries(data || {})) {
      message = message.replace(new RegExp(`\\{${key}\\}`, "g"), value);
    }
    return message;
  }

  /**
   * Send a message to the global chat
   */
  _sendMessage(message) {
    if (!message) return;
    if (!this.tusk.chatWindow) return;
    if (this.tusk.commentaryMode === "off") return;

    this.lastMessageTime = Date.now();
    this.messageCount++;

    // Post to global chat via ChatWindow
    this.tusk.chatWindow.addTuskMessage(message);
  }

  /**
   * Start periodic random chaos message delivery
   */
  _startRandomChaosTimer() {
    const deliverChaos = () => {
      // Deliver random chaos messages every 4-8 minutes
      const delay = 240000 + Math.random() * 240000;

      setTimeout(() => {
        if (this.tusk.commentaryMode !== "off" && this.canSendMessage()) {
          const messages = this.templates.randomChaos;
          const msg = messages[Math.floor(Math.random() * messages.length)];

          if (Math.random() < this.config.eventChance.randomChaos) {
            this._sendMessage(msg);
          }
        }
        deliverChaos();
      }, delay);
    };

    // Start after initial delay (45 seconds)
    setTimeout(deliverChaos, 45000);
  }

  /**
   * Start quiet lobby checker
   */
  _startQuietChecker() {
    setInterval(() => {
      const now = Date.now();
      if (now - this.lastMessageTime > this.config.maxInterval) {
        const minutes = Math.floor((now - this.lastMessageTime) / 60000);
        this.onEvent("quietLobby", { minutes });
      }
    }, 60000);
  }

  /**
   * Call this when a player gets a killstreak
   */
  onKillStreak(playerName, count, playerId) {
    this.onEvent("killStreak", { player: playerName, count }, playerId ? { player: playerId } : null);
  }

  /**
   * Call this when a player has many deaths
   */
  onDeathStreak(playerName, count, minutes, playerId) {
    this.onEvent("deathStreak", { player: playerName, count, minutes }, playerId ? { player: playerId } : null);
  }

  /**
   * Call this when a cluster is captured
   */
  onClusterCapture(playerName, clusterName, faction, playerId) {
    this.onEvent("clusterCapture", {
      player: playerName,
      cluster: clusterName,
      faction: faction.charAt(0).toUpperCase() + faction.slice(1),
    }, playerId ? { player: playerId } : null);
  }

  /**
   * Call this when faction lead changes
   */
  onFactionLeadChange(leadingFaction, percent, loser1, loser2) {
    this.onEvent("factionLead", {
      faction: leadingFaction.charAt(0).toUpperCase() + leadingFaction.slice(1),
      percent: percent.toFixed(1),
      loser1: loser1.charAt(0).toUpperCase() + loser1.slice(1),
      loser2: loser2.charAt(0).toUpperCase() + loser2.slice(1),
    });
  }

  /**
   * Call this when any player kills another
   */
  onKill(killerName, victimName, killerFaction, victimFaction, killerPlayerId, victimPlayerId) {
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    this.onEvent("kill", {
      killer: killerName,
      victim: victimName,
      killerFaction: cap(killerFaction),
      victimFaction: cap(victimFaction),
    }, {
      killer: killerPlayerId,
      victim: victimPlayerId,
    });
  }

  /**
   * Call this when a faction drops below a territory threshold
   */
  onFactionStruggle(faction, percent) {
    this.onEvent("factionStruggle", {
      faction: faction.charAt(0).toUpperCase() + faction.slice(1),
      percent: percent.toFixed(1),
    });
  }

  /**
   * Call this when a player hits a kill milestone
   */
  onPlayerMilestone(playerName, count, playerId) {
    this.onEvent("playerMilestone", { player: playerName, count }, playerId ? { player: playerId } : null);
  }

  /**
   * Call this when the true commander returns online, replacing an acting commander
   * Always fires (important event, no probability gate)
   */
  onCommanderReturns(commanderName, actingName) {
    if (this.tusk.commentaryMode === "off") return;
    if (!this.canSendMessage()) return;
    const msg = this._generateMessage("commanderReturns", {
      commander: commanderName,
      acting: actingName,
    });
    if (msg) this._sendMessage(msg);
  }
}
