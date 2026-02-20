# Anime Trivia Duel - GenLayer Intelligent Contract v3
# 40 Questions, Forfeit/Rage-Quit, League System
#
# POWER-UP CYCLE (earned every 3 correct in a row):
#   "" → shield → snipe → double_down → shield → ...
#
# WILD CARD ROUND:
#   Questions 36-40 use a surprise anime (not chosen by either player)
#
# SNIPE:
#   Activating fires on opponent's next un-cached question
#   Forces them to answer from YOUR anime
#
# SPECTATOR BETTING:
#   Spectators claim 10 GOT airdrop (once per address)
#   Bet on P1 or P2 (max 10 GOT per room)
#   Payout: proportional share of total pool if your side wins
#   Tie: bet returned
#
# FORFEIT / RAGE QUIT:
#   Called by server when a player is silent for 90s
#   Half of quitter's balance goes to opponent, half burned
#   Active player gets +5 GOT win bonus
#
# LEAGUE SYSTEM:
#   Players create/join weekly leagues, standings tracked on-chain
#
# TOKEN MECHANICS:
#   Answer correctly   → streak +1, no token change
#   Miss + steal works → miss-er loses 1 token to stealer
#   Miss + steal fails → miss-er loses 1 token (burned)
#   3 correct streak   → earn next power-up in cycle
#   5 wrong in a row   → 1 token burned from your balance
#   Win game           → +5 GOT bonus mint

from genlayer import *

@gl.contract
class AnimeTrivialDuel:

    # ── GOT Token ──────────────────────────────────────────────────────────────
    balances: TreeMap[str, int]
    total_supply: int
    total_burned: int

    # ── Room Identity ──────────────────────────────────────────────────────────
    room_player1: TreeMap[str, str]
    room_player2: TreeMap[str, str]
    room_anime1:  TreeMap[str, str]
    room_anime2:  TreeMap[str, str]
    room_state:   TreeMap[str, str]   # "waiting" | "active" | "finished"

    # ── Game Progress ──────────────────────────────────────────────────────────
    room_q1_answered: TreeMap[str, int]
    room_q2_answered: TreeMap[str, int]

    # ── Streaks ────────────────────────────────────────────────────────────────
    room_p1_correct_streak: TreeMap[str, int]
    room_p2_correct_streak: TreeMap[str, int]
    room_p1_wrong_streak:   TreeMap[str, int]
    room_p2_wrong_streak:   TreeMap[str, int]

    # ── Power-ups: "" | "shield" | "snipe" | "double_down" ────────────────────
    room_p1_powerup: TreeMap[str, str]
    room_p2_powerup: TreeMap[str, str]

    # ── Snipe Active: 0 or 1 ──────────────────────────────────────────────────
    room_p1_snipe_active: TreeMap[str, int]
    room_p2_snipe_active: TreeMap[str, int]

    # ── Result ─────────────────────────────────────────────────────────────────
    room_winner: TreeMap[str, str]

    # ── Spectator Betting ──────────────────────────────────────────────────────
    room_bets_p1: TreeMap[str, int]    # total GOT bet on P1 per room
    room_bets_p2: TreeMap[str, int]    # total GOT bet on P2 per room
    bettor_side:    TreeMap[str, str]  # key "room|addr" → "p1" | "p2"
    bettor_amount:  TreeMap[str, int]  # key "room|addr" → amount wagered
    bettor_claimed: TreeMap[str, int]  # key "room|addr" → 0 | 1
    spectator_airdrop_claimed: TreeMap[str, int]  # addr → 0 | 1

    # ── League System ──────────────────────────────────────────────────────────
    league_name:          TreeMap[str, str]   # code → name
    league_creator:       TreeMap[str, str]   # code → address
    league_created_at:    TreeMap[str, int]   # code → unix timestamp
    league_member_count:  TreeMap[str, int]   # code → count
    league_members:       TreeMap[str, str]   # "code|idx" → address
    league_joined:        TreeMap[str, int]   # "code|addr" → 1 if member
    league_wins:          TreeMap[str, int]   # "code|addr" → wins
    league_losses:        TreeMap[str, int]   # "code|addr" → losses
    league_tokens_earned: TreeMap[str, int]   # "code|addr" → net GOT earned (can be negative via 0 floor)
    league_games:         TreeMap[str, int]   # "code|addr" → games played
    room_league:          TreeMap[str, str]   # room_code → league_code (or "")


    def __init__(self):
        self.total_supply = 0
        self.total_burned = 0


    # ══════════════════════════════════════════════════════════════════════════
    # ROOM MANAGEMENT
    # ══════════════════════════════════════════════════════════════════════════

    @gl.public.write
    def create_room(self, room_code: str, anime: str, player_address: str, league_code: str) -> None:
        assert room_code not in self.room_state, "Room code already taken"
        assert len(room_code) >= 4,              "Room code must be at least 4 characters"
        assert len(anime.strip()) >= 2,          "Anime name too short"
        assert len(player_address) >= 10,        "Invalid player address"

        self.room_player1[room_code]           = player_address
        self.room_anime1[room_code]            = anime.strip()
        self.room_state[room_code]             = "waiting"
        self.room_q1_answered[room_code]       = 0
        self.room_q2_answered[room_code]       = 0
        self.room_p1_correct_streak[room_code] = 0
        self.room_p2_correct_streak[room_code] = 0
        self.room_p1_wrong_streak[room_code]   = 0
        self.room_p2_wrong_streak[room_code]   = 0
        self.room_p1_powerup[room_code]        = ""
        self.room_p2_powerup[room_code]        = ""
        self.room_winner[room_code]            = ""
        self.room_p1_snipe_active[room_code]   = 0
        self.room_p2_snipe_active[room_code]   = 0
        self.room_bets_p1[room_code]           = 0
        self.room_bets_p2[room_code]           = 0
        self.room_league[room_code]            = league_code.strip()


    @gl.public.write
    def join_room(self, room_code: str, anime: str, player_address: str) -> None:
        assert room_code in self.room_state,            "Room not found"
        assert self.room_state[room_code] == "waiting", "Room is not open"
        assert len(anime.strip()) >= 2,                 "Anime name too short"
        assert len(player_address) >= 10,               "Invalid player address"

        p1 = self.room_player1[room_code]
        assert player_address != p1, "Cannot join your own room"

        self.room_player2[room_code] = player_address
        self.room_anime2[room_code]  = anime.strip()
        self.room_state[room_code]   = "active"

        # Airdrop 20 GOT to each player
        self._mint(p1, 20)
        self._mint(player_address, 20)


    # ══════════════════════════════════════════════════════════════════════════
    # FORFEIT / RAGE QUIT
    # ══════════════════════════════════════════════════════════════════════════

    @gl.public.write
    def forfeit_game(self, room_code: str, active_player_address: str) -> str:
        """
        Called when a player disconnects (server-side auto-detect).
        active_player_address = the player who is STILL present (winner).
        The quitter is the other player.
        Returns: "forfeited:{active_player_address}"
        """
        assert room_code in self.room_state,           "Room not found"
        assert self.room_state[room_code] == "active", "Game not active"

        p1 = self.room_player1[room_code]
        p2 = self.room_player2[room_code]
        assert active_player_address == p1 or active_player_address == p2, "Not a player in this room"

        # Determine quitter
        quitter = p2 if active_player_address == p1 else p1

        quitter_bal = self.balances[quitter] if quitter in self.balances else 0
        half        = quitter_bal // 2
        remainder   = quitter_bal - half

        # Transfer half to active player, burn the rest
        if half > 0:
            self._transfer(quitter, active_player_address, half)
        if remainder > 0:
            self._burn(quitter, remainder)

        # Win bonus for active player
        self._mint(active_player_address, 5)

        self.room_state[room_code]  = "finished"
        self.room_winner[room_code] = active_player_address

        return "forfeited:" + active_player_address


    # ══════════════════════════════════════════════════════════════════════════
    # SNIPE
    # ══════════════════════════════════════════════════════════════════════════

    @gl.public.write
    def use_snipe(self, room_code: str, player_address: str) -> str:
        assert room_code in self.room_state,           "Room not found"
        assert self.room_state[room_code] == "active", "Game not active"

        p1 = self.room_player1[room_code]
        p2 = self.room_player2[room_code]

        if player_address == p1:
            assert self.room_p1_powerup[room_code] == "snipe", "No snipe powerup to use"
            self.room_p1_powerup[room_code]      = ""
            self.room_p1_snipe_active[room_code] = 1
            return "snipe_activated"
        elif player_address == p2:
            assert self.room_p2_powerup[room_code] == "snipe", "No snipe powerup to use"
            self.room_p2_powerup[room_code]      = ""
            self.room_p2_snipe_active[room_code] = 1
            return "snipe_activated"
        else:
            assert False, "Not a player in this room"


    # ══════════════════════════════════════════════════════════════════════════
    # AI: QUESTION GENERATION  (Wild Card at Q36-40 + Snipe override)
    # ══════════════════════════════════════════════════════════════════════════

    @gl.public.write
    def get_question(self, room_code: str, for_player: str, question_num: int) -> str:
        assert room_code in self.room_state,           "Room not found"
        assert self.room_state[room_code] == "active", "Game not active"
        assert for_player in ("p1", "p2"),             "for_player must be p1 or p2"
        assert 1 <= question_num <= 40,                "Question number must be 1-40"

        a1 = self.room_anime1[room_code]
        a2 = self.room_anime2[room_code] if room_code in self.room_anime2 else ""

        # ── WILD CARD ROUND: Questions 36-40 ──────────────────────────────────
        if question_num >= 36:
            wc_seed = (ord(room_code[0]) + question_num) % 16
            wc_pool = [
                "Dragon Ball Z", "Hunter x Hunter", "Fullmetal Alchemist Brotherhood",
                "JoJo's Bizarre Adventure", "Tokyo Ghoul", "Re:Zero", "Sword Art Online",
                "Fairy Tail", "Black Clover", "Vinland Saga", "Mob Psycho 100", "Code Geass",
                "Cowboy Bebop", "Steins;Gate", "Neon Genesis Evangelion", "One Punch Man",
            ]
            wc_hint = wc_pool[wc_seed]
            prompt = (
                f"WILD CARD ROUND! Generate trivia question #{question_num} of 40.\n"
                f"Session seed: {room_code}. Suggested anime: '{wc_hint}' — but pick any from the pool below EXCEPT '{a1}' and '{a2}'.\n"
                f"Pool: Dragon Ball Z, Hunter x Hunter, Fullmetal Alchemist Brotherhood, "
                f"JoJo's Bizarre Adventure, Tokyo Ghoul, Re:Zero, Sword Art Online, Fairy Tail, "
                f"Black Clover, Vinland Saga, Mob Psycho 100, Code Geass, Cowboy Bebop, Steins;Gate, "
                f"Neon Genesis Evangelion, One Punch Man.\n"
                f"Ask something SPECIFIC and NON-OBVIOUS — not basic character names or main plot.\n"
                f"All 4 options must be plausible wrong answers.\n"
                f"Return ONLY valid JSON — no other text:\n"
                f'{{"question": "...", "options": ["A) ...", "B) ...", "C) ...", "D) ..."], '
                f'"answer": "A", "wildcard_anime": "the anime you picked"}}\n'
                f"The answer field must be just the letter A, B, C, or D."
            )

        # ── NORMAL ROUND with SNIPE check ─────────────────────────────────────
        else:
            if for_player == "p1":
                anime = a1
                # P2 sniped P1 → force P1 to answer from P2's anime
                if room_code in self.room_p2_snipe_active and self.room_p2_snipe_active[room_code] == 1:
                    anime = a2
                    self.room_p2_snipe_active[room_code] = 0
            else:
                anime = a2
                # P1 sniped P2 → force P2 to answer from P1's anime
                if room_code in self.room_p1_snipe_active and self.room_p1_snipe_active[room_code] == 1:
                    anime = a1
                    self.room_p1_snipe_active[room_code] = 0

            # Rotate through 8 categories based on question number so every
            # batch of 5 questions covers a completely different aspect of the anime.
            # Including room_code as a seed ensures different rooms get different questions.
            categories = [
                "characters — personality, backstory, relationships, or character development",
                "fights and battles — specific moves, outcomes, strategies, or key moments in combat",
                "plot and story arcs — events, turning points, episode/chapter details, or consequences",
                "powers, abilities, and techniques — how they work, their names, limitations, or users",
                "world-building and lore — geography, factions, history, rules of the world",
                "quotes and dialogue — who said it, when, or what it means",
                "side characters and villains — motivations, abilities, roles, or fates",
                "lesser-known trivia — behind-the-scenes facts, manga differences, author intent, or obscure details",
            ]
            category = categories[(question_num - 1) % len(categories)]

            prompt = (
                f"You are an anime trivia host generating question #{question_num} of 40 about '{anime}'.\n"
                f"Session seed: {room_code}-{for_player}. Use this to pick a UNIQUE angle not used in other sessions.\n"
                f"This question's category: {category}.\n"
                f"Rules:\n"
                f"- DO NOT ask about the most famous or obvious facts (e.g. main character's name, basic power).\n"
                f"- Ask something SPECIFIC and DETAILED within the category above.\n"
                f"- Vary difficulty: questions 1-15 easy, 16-30 medium, 31-40 hard.\n"
                f"- All 4 options must be plausible — no obviously silly wrong answers.\n"
                f"Return ONLY valid JSON, no other text:\n"
                f'{{"question": "...", "options": ["A) ...", "B) ...", "C) ...", "D) ..."], "answer": "A"}}\n'
                f"The answer field must be just the letter A, B, C, or D."
            )

        def ask():
            return gl.nondet.exec_prompt(prompt)

        return gl.eq_principle.strict_eq(ask)


    # ══════════════════════════════════════════════════════════════════════════
    # AI: ANSWER VERIFICATION + TOKEN LOGIC
    # ══════════════════════════════════════════════════════════════════════════

    @gl.public.write
    def submit_answer(
        self,
        room_code: str,
        question: str,
        player_answer: str,
        is_steal: bool,
        player_address: str
    ) -> str:
        """
        Returns: "correct" | "wrong" | "wrong_burn" |
                 "steal_success" | "steal_blocked" | "steal_failed_burn"
        """
        assert room_code in self.room_state,           "Room not found"
        assert self.room_state[room_code] == "active", "Game not active"

        p1 = self.room_player1[room_code]
        p2 = self.room_player2[room_code]

        is_p1 = (player_address == p1)
        is_p2 = (player_address == p2)
        assert is_p1 or is_p2, "Not a player in this room"

        prompt = (
            f"Anime trivia question: {question}\n"
            f"Player's answer: {player_answer}\n\n"
            f"Is the player's answer correct? Be lenient — accept alternate valid answers "
            f"and minor spelling errors.\n"
            f"Reply with ONLY the single word 'correct' or 'wrong'."
        )

        def check():
            return gl.nondet.exec_prompt(prompt)

        verdict    = gl.eq_principle.strict_eq(check).strip().lower()
        is_correct = verdict.startswith("correct")

        # ── STEAL ATTEMPT ──────────────────────────────────────────────────────
        if is_steal:
            if is_p1:
                stealer    = p1
                victim     = p2
                stealer_pu = self.room_p1_powerup[room_code]
                victim_pu  = self.room_p2_powerup[room_code]
            else:
                stealer    = p2
                victim     = p1
                stealer_pu = self.room_p2_powerup[room_code]
                victim_pu  = self.room_p1_powerup[room_code]

            if is_correct:
                # SHIELD blocks the steal
                if victim_pu == "shield":
                    if is_p1:
                        self.room_p2_powerup[room_code] = ""
                    else:
                        self.room_p1_powerup[room_code] = ""
                    return "steal_blocked"

                # DOUBLE DOWN = steal 2 tokens
                steal_amount = 1
                if stealer_pu == "double_down":
                    steal_amount = 2
                    if is_p1:
                        self.room_p1_powerup[room_code] = ""
                    else:
                        self.room_p2_powerup[room_code] = ""

                victim_bal    = self.balances[victim] if victim in self.balances else 0
                actual_amount = min(steal_amount, victim_bal)
                if actual_amount > 0:
                    self._transfer(victim, stealer, actual_amount)
                return "steal_success"

            else:
                # Steal failed → burn 1 token from victim
                victim_bal = self.balances[victim] if victim in self.balances else 0
                if victim_bal > 0:
                    self._burn(victim, 1)
                return "steal_failed_burn"

        # ── NORMAL ANSWER ──────────────────────────────────────────────────────
        else:
            if is_p1:
                self.room_q1_answered[room_code] = self.room_q1_answered[room_code] + 1
            else:
                self.room_q2_answered[room_code] = self.room_q2_answered[room_code] + 1

            if is_correct:
                if is_p1:
                    self.room_p1_wrong_streak[room_code]   = 0
                    self.room_p1_correct_streak[room_code] = self.room_p1_correct_streak[room_code] + 1
                    streak = self.room_p1_correct_streak[room_code]
                else:
                    self.room_p2_wrong_streak[room_code]   = 0
                    self.room_p2_correct_streak[room_code] = self.room_p2_correct_streak[room_code] + 1
                    streak = self.room_p2_correct_streak[room_code]

                # 3 correct in a row → earn next power-up in cycle
                if streak >= 3:
                    if is_p1:
                        cur = self.room_p1_powerup[room_code]
                        self.room_p1_powerup[room_code]        = self._next_powerup(cur)
                        self.room_p1_correct_streak[room_code] = 0
                    else:
                        cur = self.room_p2_powerup[room_code]
                        self.room_p2_powerup[room_code]        = self._next_powerup(cur)
                        self.room_p2_correct_streak[room_code] = 0

                return "correct"

            else:
                if is_p1:
                    self.room_p1_correct_streak[room_code] = 0
                    self.room_p1_wrong_streak[room_code]   = self.room_p1_wrong_streak[room_code] + 1
                    wrong_streak = self.room_p1_wrong_streak[room_code]
                else:
                    self.room_p2_correct_streak[room_code] = 0
                    self.room_p2_wrong_streak[room_code]   = self.room_p2_wrong_streak[room_code] + 1
                    wrong_streak = self.room_p2_wrong_streak[room_code]

                # 5 wrong in a row → Streak Burn
                if wrong_streak >= 5:
                    bal = self.balances[player_address] if player_address in self.balances else 0
                    if bal > 0:
                        self._burn(player_address, 1)
                    if is_p1:
                        self.room_p1_wrong_streak[room_code] = 0
                    else:
                        self.room_p2_wrong_streak[room_code] = 0
                    return "wrong_burn"

                return "wrong"


    # ══════════════════════════════════════════════════════════════════════════
    # GAME END
    # ══════════════════════════════════════════════════════════════════════════

    @gl.public.write
    def end_game(self, room_code: str, player_address: str) -> str:
        assert room_code in self.room_state,           "Room not found"
        assert self.room_state[room_code] == "active", "Game not active"

        p1 = self.room_player1[room_code]
        p2 = self.room_player2[room_code]
        assert player_address == p1 or player_address == p2, "Not a player in this room"

        q1 = self.room_q1_answered[room_code]
        q2 = self.room_q2_answered[room_code]
        assert q1 >= 40 and q2 >= 40, f"Game not complete. P1: {q1}/40, P2: {q2}/40"

        p1_bal = self.balances[p1] if p1 in self.balances else 0
        p2_bal = self.balances[p2] if p2 in self.balances else 0

        self.room_state[room_code] = "finished"

        if p1_bal > p2_bal:
            winner = p1
        elif p2_bal > p1_bal:
            winner = p2
        else:
            self.room_winner[room_code] = "tie"
            return "tie"

        self.room_winner[room_code] = winner
        self._mint(winner, 5)
        return "winner:" + winner


    # ══════════════════════════════════════════════════════════════════════════
    # SPECTATOR BETTING
    # ══════════════════════════════════════════════════════════════════════════

    @gl.public.write
    def spectator_airdrop(self, bettor_address: str) -> None:
        """Anyone can claim 10 GOT once to use for spectator betting."""
        assert len(bettor_address) >= 10, "Invalid address"
        already = (bettor_address in self.spectator_airdrop_claimed and
                   self.spectator_airdrop_claimed[bettor_address] == 1)
        assert not already, "Already claimed spectator airdrop"
        self._mint(bettor_address, 10)
        self.spectator_airdrop_claimed[bettor_address] = 1

    @gl.public.write
    def place_bet(self, room_code: str, bettor_address: str, side: str, amount: int) -> None:
        """Lock GOT into the bet pool. Bets open while room is waiting or active."""
        assert room_code in self.room_state,                 "Room not found"
        assert self.room_state[room_code] in ("waiting", "active"), "Game already ended"
        assert side in ("p1", "p2"),                         "side must be p1 or p2"
        assert amount > 0,                                   "Amount must be positive"
        assert amount <= 10,                                 "Max bet is 10 GOT per room"

        key = f"{room_code}|{bettor_address}"
        assert key not in self.bettor_side, "Already placed a bet in this room"

        bal = self.balances[bettor_address] if bettor_address in self.balances else 0
        assert bal >= amount, "Insufficient GOT balance"

        # Deduct from bettor, hold in pool
        self.balances[bettor_address] = bal - amount
        self.bettor_side[key]    = side
        self.bettor_amount[key]  = amount
        self.bettor_claimed[key] = 0

        if side == "p1":
            prev = self.room_bets_p1[room_code] if room_code in self.room_bets_p1 else 0
            self.room_bets_p1[room_code] = prev + amount
        else:
            prev = self.room_bets_p2[room_code] if room_code in self.room_bets_p2 else 0
            self.room_bets_p2[room_code] = prev + amount

    @gl.public.write
    def claim_winnings(self, room_code: str, bettor_address: str) -> int:
        """
        Proportional payout from total pool if your side won.
        Tie returns your bet. Loss returns 0.
        """
        assert room_code in self.room_state,             "Room not found"
        assert self.room_state[room_code] == "finished", "Game not finished yet"

        key = f"{room_code}|{bettor_address}"
        assert key in self.bettor_side, "No bet found for this address"

        already = key in self.bettor_claimed and self.bettor_claimed[key] == 1
        assert not already, "Already claimed winnings"

        self.bettor_claimed[key] = 1

        winner  = self.room_winner[room_code]
        my_side = self.bettor_side[key]
        my_amt  = self.bettor_amount[key] if key in self.bettor_amount else 0
        p1_pool = self.room_bets_p1[room_code] if room_code in self.room_bets_p1 else 0
        p2_pool = self.room_bets_p2[room_code] if room_code in self.room_bets_p2 else 0
        total   = p1_pool + p2_pool

        # Tie → return original bet
        if winner == "tie":
            if bettor_address in self.balances:
                self.balances[bettor_address] = self.balances[bettor_address] + my_amt
            else:
                self.balances[bettor_address] = my_amt
            return my_amt

        # Determine winning side
        p1 = self.room_player1[room_code]
        winning_side = "p1" if winner == p1 else "p2"

        if my_side != winning_side:
            return 0  # Lost — nothing to claim

        my_pool = p1_pool if my_side == "p1" else p2_pool
        if my_pool == 0:
            return 0

        payout = (my_amt * total) // my_pool

        if bettor_address in self.balances:
            self.balances[bettor_address] = self.balances[bettor_address] + payout
        else:
            self.balances[bettor_address] = payout
        return payout


    # ══════════════════════════════════════════════════════════════════════════
    # LEAGUE SYSTEM
    # ══════════════════════════════════════════════════════════════════════════

    @gl.public.write
    def create_league(self, league_code: str, name: str, creator_address: str, created_at: int) -> None:
        assert len(league_code) >= 4,        "League code must be at least 4 characters"
        assert league_code not in self.league_name, "League code already taken"
        assert len(name.strip()) >= 2,       "League name too short"
        assert len(creator_address) >= 10,   "Invalid creator address"

        self.league_name[league_code]         = name.strip()
        self.league_creator[league_code]      = creator_address
        self.league_created_at[league_code]   = created_at
        self.league_member_count[league_code] = 1

        # Creator is first member
        idx_key = f"{league_code}|0"
        self.league_members[idx_key] = creator_address

        join_key = f"{league_code}|{creator_address}"
        self.league_joined[join_key]        = 1
        self.league_wins[join_key]          = 0
        self.league_losses[join_key]        = 0
        self.league_tokens_earned[join_key] = 0
        self.league_games[join_key]         = 0

    @gl.public.write
    def join_league(self, league_code: str, member_address: str) -> None:
        assert league_code in self.league_name,  "League not found"
        assert len(member_address) >= 10,        "Invalid address"

        join_key = f"{league_code}|{member_address}"
        already  = join_key in self.league_joined and self.league_joined[join_key] == 1
        assert not already, "Already a member of this league"

        count   = self.league_member_count[league_code]
        idx_key = f"{league_code}|{count}"
        self.league_members[idx_key]       = member_address
        self.league_member_count[league_code] = count + 1

        self.league_joined[join_key]        = 1
        self.league_wins[join_key]          = 0
        self.league_losses[join_key]        = 0
        self.league_tokens_earned[join_key] = 0
        self.league_games[join_key]         = 0

    @gl.public.write
    def record_league_result(
        self,
        league_code: str,
        winner_addr: str,
        loser_addr: str,
        winner_delta: int,
        loser_delta: int
    ) -> None:
        """Called by server after a league game ends. Updates win/loss/token stats."""
        assert league_code in self.league_name, "League not found"

        wk = f"{league_code}|{winner_addr}"
        lk = f"{league_code}|{loser_addr}"

        if wk in self.league_wins:
            self.league_wins[wk]          = self.league_wins[wk] + 1
            self.league_tokens_earned[wk] = self.league_tokens_earned[wk] + winner_delta
            self.league_games[wk]         = self.league_games[wk] + 1
        if lk in self.league_losses:
            self.league_losses[lk]        = self.league_losses[lk] + 1
            self.league_tokens_earned[lk] = self.league_tokens_earned[lk] + loser_delta
            self.league_games[lk]         = self.league_games[lk] + 1


    # ══════════════════════════════════════════════════════════════════════════
    # READ FUNCTIONS
    # ══════════════════════════════════════════════════════════════════════════

    @gl.public.view
    def get_balance(self, addr: str) -> int:
        if addr in self.balances:
            return self.balances[addr]
        return 0

    @gl.public.view
    def get_room_state(self, room_code: str) -> str:
        if room_code not in self.room_state:
            return "not_found"
        return self.room_state[room_code]

    @gl.public.view
    def get_room_info(self, room_code: str) -> str:
        """state|p1|p2|anime1|anime2|p1_bal|p2_bal|q1|q2|pu1|pu2|winner|snipe1|snipe2|bets_p1|bets_p2|p1_cstreak|p2_cstreak|p1_wstreak|p2_wstreak|league_code"""
        if room_code not in self.room_state:
            return "not_found"

        state   = self.room_state[room_code]
        p1      = self.room_player1[room_code]    if room_code in self.room_player1    else ""
        p2      = self.room_player2[room_code]    if room_code in self.room_player2    else ""
        a1      = self.room_anime1[room_code]     if room_code in self.room_anime1     else ""
        a2      = self.room_anime2[room_code]     if room_code in self.room_anime2     else ""
        p1_bal  = self.balances[p1]               if p1 in self.balances               else 0
        p2_bal  = self.balances[p2]               if p2 in self.balances               else 0
        q1      = self.room_q1_answered[room_code] if room_code in self.room_q1_answered else 0
        q2      = self.room_q2_answered[room_code] if room_code in self.room_q2_answered else 0
        pu1     = self.room_p1_powerup[room_code]  if room_code in self.room_p1_powerup  else ""
        pu2     = self.room_p2_powerup[room_code]  if room_code in self.room_p2_powerup  else ""
        winner  = self.room_winner[room_code]      if room_code in self.room_winner      else ""
        sn1     = self.room_p1_snipe_active[room_code] if room_code in self.room_p1_snipe_active else 0
        sn2     = self.room_p2_snipe_active[room_code] if room_code in self.room_p2_snipe_active else 0
        bp1     = self.room_bets_p1[room_code]     if room_code in self.room_bets_p1    else 0
        bp2     = self.room_bets_p2[room_code]     if room_code in self.room_bets_p2    else 0
        p1_cs   = self.room_p1_correct_streak[room_code] if room_code in self.room_p1_correct_streak else 0
        p2_cs   = self.room_p2_correct_streak[room_code] if room_code in self.room_p2_correct_streak else 0
        p1_ws   = self.room_p1_wrong_streak[room_code]   if room_code in self.room_p1_wrong_streak   else 0
        p2_ws   = self.room_p2_wrong_streak[room_code]   if room_code in self.room_p2_wrong_streak   else 0
        lc      = self.room_league[room_code]             if room_code in self.room_league             else ""

        return (f"{state}|{p1}|{p2}|{a1}|{a2}|{p1_bal}|{p2_bal}|{q1}|{q2}|"
                f"{pu1}|{pu2}|{winner}|{sn1}|{sn2}|{bp1}|{bp2}|{p1_cs}|{p2_cs}|{p1_ws}|{p2_ws}|{lc}")

    @gl.public.view
    def get_bettor_info(self, room_code: str, bettor_address: str) -> str:
        """Returns: side|amount|claimed  or  none"""
        key = f"{room_code}|{bettor_address}"
        if key not in self.bettor_side:
            return "none"
        side    = self.bettor_side[key]
        amount  = self.bettor_amount[key]  if key in self.bettor_amount  else 0
        claimed = self.bettor_claimed[key] if key in self.bettor_claimed else 0
        return f"{side}|{amount}|{claimed}"

    @gl.public.view
    def get_token_stats(self) -> str:
        return f"{self.total_supply}|{self.total_burned}"

    @gl.public.view
    def get_league_info(self, league_code: str) -> str:
        """Returns: name|creator|member_count|created_at  or  not_found"""
        if league_code not in self.league_name:
            return "not_found"
        name    = self.league_name[league_code]
        creator = self.league_creator[league_code]
        count   = self.league_member_count[league_code] if league_code in self.league_member_count else 0
        ts      = self.league_created_at[league_code]   if league_code in self.league_created_at   else 0
        return f"{name}|{creator}|{count}|{ts}"

    @gl.public.view
    def get_league_member(self, league_code: str, index: int) -> str:
        """Returns address at index, or empty string."""
        idx_key = f"{league_code}|{index}"
        if idx_key in self.league_members:
            return self.league_members[idx_key]
        return ""

    @gl.public.view
    def get_member_stats(self, league_code: str, addr: str) -> str:
        """Returns: wins|losses|tokens_earned|games  or  not_found"""
        join_key = f"{league_code}|{addr}"
        if join_key not in self.league_joined:
            return "not_found"
        wins   = self.league_wins[join_key]          if join_key in self.league_wins          else 0
        losses = self.league_losses[join_key]         if join_key in self.league_losses         else 0
        tokens = self.league_tokens_earned[join_key]  if join_key in self.league_tokens_earned  else 0
        games  = self.league_games[join_key]          if join_key in self.league_games          else 0
        return f"{wins}|{losses}|{tokens}|{games}"


    # ══════════════════════════════════════════════════════════════════════════
    # AI GAME RESET
    # ══════════════════════════════════════════════════════════════════════════

    @gl.public.write
    def reset_balance_for_ai(self, room_code: str, player_address: str) -> None:
        """
        Sets a player's balance to exactly 20 GOT at the start of an AI game.
        Prevents accumulated tokens from previous games carrying over.
        Only callable while the room is active.
        """
        assert room_code in self.room_state,           "Room not found"
        assert self.room_state[room_code] == "active", "Room not active"

        p1 = self.room_player1[room_code]
        p2 = self.room_player2[room_code]
        assert player_address == p1 or player_address == p2, "Not a player in this room"

        old = self.balances[player_address] if player_address in self.balances else 0
        self.balances[player_address] = 20
        # Keep total_supply accurate
        self.total_supply = self.total_supply - old + 20


    # ══════════════════════════════════════════════════════════════════════════
    # INTERNAL HELPERS
    # ══════════════════════════════════════════════════════════════════════════

    def _next_powerup(self, current: str) -> str:
        """Cycle: "" → shield → snipe → double_down → shield → ..."""
        cycle = {
            "":           "shield",
            "shield":     "snipe",
            "snipe":      "double_down",
            "double_down":"shield",
        }
        if current in cycle:
            return cycle[current]
        return "shield"

    def _mint(self, addr: str, amount: int) -> None:
        if addr in self.balances:
            self.balances[addr] = self.balances[addr] + amount
        else:
            self.balances[addr] = amount
        self.total_supply = self.total_supply + amount

    def _burn(self, addr: str, amount: int) -> None:
        if addr in self.balances and self.balances[addr] >= amount:
            self.balances[addr] = self.balances[addr] - amount
            self.total_burned   = self.total_burned + amount
            self.total_supply   = self.total_supply - amount

    def _transfer(self, from_addr: str, to_addr: str, amount: int) -> None:
        if from_addr in self.balances and self.balances[from_addr] >= amount:
            self.balances[from_addr] = self.balances[from_addr] - amount
            if to_addr in self.balances:
                self.balances[to_addr] = self.balances[to_addr] + amount
            else:
                self.balances[to_addr] = amount
