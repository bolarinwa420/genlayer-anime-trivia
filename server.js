import "dotenv/config";
import express from "express";
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const app  = express();
const PORT = process.env.PORT || 3000;
const CONTRACT = process.env.CONTRACT_ADDRESS;

app.use(express.json());
app.use(express.static("public"));

// ── GenLayer client ────────────────────────────────────────────────────────
const account = createAccount(process.env.PRIVATE_KEY);
const client  = createClient({ account, chain: studionet });

console.log("=================================");
console.log("  ANIME TRIVIA DUEL SERVER");
console.log("=================================");
console.log("Contract:", CONTRACT);
console.log("Wallet:  ", account.address);
console.log("=================================");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ── Transaction queue — prevents nonce collisions from concurrent TXs ───────
let txQueue = Promise.resolve();
function enqueue(fn) {
  const result = txQueue.then(fn);
  // Chain on a no-throw wrapper so one failure doesn't jam the whole queue
  txQueue = result.catch(() => {});
  return result;
}

async function writeAndWait(functionName, args, timeoutMs = 300_000) {
  return enqueue(async () => {
  console.log(`[${functionName}] Calling with args:`, args);

  const txHash = await client.writeContract({
    address: CONTRACT,
    functionName,
    args,
    value: 0n,
  });

  console.log(`[${functionName}] TX hash:`, txHash);

  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash: txHash,
      retries: Math.floor(timeoutMs / 3000),
      interval: 3000,
    });
  } catch (err) {
    console.warn(`[${functionName}] waitForTransactionReceipt threw:`, err.message);
    const tx = await client.getTransaction({ hash: txHash });
    if (tx && Number(tx.status) >= 4) {
      receipt = tx;
    } else {
      throw err;
    }
  }

  const leaderReceipt = receipt?.consensus_data?.leader_receipt?.[0];
  const resultObj     = leaderReceipt?.result;

  if (!resultObj) {
    console.warn(`[${functionName}] No result in receipt — returning null`);
    return { result: null };
  }

  if (resultObj.status === "rollback" || resultObj.status === "contract_error") {
    const msg = resultObj.payload || "Contract error";
    throw new Error(`[${functionName}] Contract error: ${msg}`);
  }

  let result = resultObj.payload?.readable ?? String(resultObj.payload ?? "");

  if (typeof result === "string" && result.startsWith('"') && result.endsWith('"')) {
    result = result.slice(1, -1);
  }

  console.log(`[${functionName}] Result:`, result);
  return { result };
  }); // end enqueue
}

function flexibleJsonParse(raw) {
  let str = String(raw || "").trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  str = str.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // Unescape common AI escape patterns: literal \n \t \" \\
  const unescape = s => s
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");

  // Attempt 1: parse as-is
  try { return JSON.parse(str); } catch {}

  // Attempt 2: unescape then parse
  try { return JSON.parse(unescape(str)); } catch {}

  // Attempt 3: extract first {...} block
  const block = str.match(/\{[\s\S]*\}/);
  if (block) {
    try { return JSON.parse(block[0]); } catch {}
    try { return JSON.parse(unescape(block[0])); } catch {}
  }

  // Attempt 4: eval (last resort)
  const target = block ? block[0] : str;
  try {
    // eslint-disable-next-line no-new-func
    return new Function("return " + target)();
  } catch {}

  return null;
}

async function readContract(functionName, args) {
  const result = await client.readContract({
    address: CONTRACT,
    functionName,
    args,
  });
  return String(result);
}

// ── Question prefetch cache ────────────────────────────────────────────────
const questionCache = new Map();

function prefetchQuestion(room_code, for_player, question_num, retryCount = 0) {
  if (question_num < 1 || question_num > 40) return;
  const key = `${room_code}-${for_player}-${question_num}`;
  if (questionCache.has(key)) return;

  console.log(`[prefetch] ${for_player} Q${question_num} — firing background fetch${retryCount ? ` (retry ${retryCount})` : ""}`);

  const promise = writeAndWait(
    "get_question",
    [room_code, for_player, question_num],
    300_000
  ).then(({ result }) => {
    const parsed = flexibleJsonParse(result);
    if (!parsed) throw new Error("Parse failed: " + String(result).substring(0, 100));
    console.log(`[prefetch] ${for_player} Q${question_num} — READY`);
    return parsed;
  }).catch(err => {
    console.warn(`[prefetch] ${for_player} Q${question_num} failed:`, err.message);
    questionCache.delete(key);
    // Retry once after 15s — chain might just be temporarily busy
    if (retryCount < 1) {
      setTimeout(() => prefetchQuestion(room_code, for_player, question_num, retryCount + 1), 15_000);
    }
    return null;
  });

  questionCache.set(key, promise);
}

// ── Room State (in-memory) ─────────────────────────────────────────────────
const roomState = new Map();
// Structure per room:
// {
//   p1_address, p1_anime, p2_address, p2_anime,
//   status: "waiting" | "active" | "ended",
//   p1_steal: null | { question, question_num },
//   p2_steal: null | { question, question_num },
//   winner: null | string,
//   events: [{ type, player, qNum, ts }, ...]   ← capped at 30
//   leagueCode: string | null,
//   p1_timer: timeout | null,  p2_timer: timeout | null,
//   p1_last_q: number,         p2_last_q: number,
//   p1_last_active: number,    p2_last_active: number,
// }

// ── League registry (in-memory mirror for fast /api/leagues) ────────────────
const leagueRegistry = new Map();

// ── AI Player ──────────────────────────────────────────────────────────────
const AI_ADDRESS = "0xAb07000000000000000000000000000000000001";
const AI_ANIMES  = [
  "Dragon Ball Z", "Hunter x Hunter", "Fullmetal Alchemist Brotherhood",
  "One Punch Man", "Mob Psycho 100", "Cowboy Bebop",
];

async function runAIPlayer(roomCode, accuracy = 0.6) {
  console.log(`[AI] Starting AI loop for room ${roomCode}`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  for (let qNum = 1; qNum <= 40; qNum++) {
    const state = roomState.get(roomCode);
    if (!state || state.status !== "active") break;

    // Sync gate: wait for P1 to finish the previous question before AI proceeds
    // This keeps both players on the same question number at all times
    for (let wait = 0; wait < 120; wait++) {
      const s = roomState.get(roomCode);
      if (!s || s.status !== "active") break;
      if ((s.p1_answered_q || 0) >= qNum - 1) break;
      await sleep(3000);
    }

    const stateCheck = roomState.get(roomCode);
    if (!stateCheck || stateCheck.status !== "active") break;

    // Simulate thinking time: 20–45 seconds (realistic human-ish pace)
    await sleep(20000 + Math.random() * 25000);

    const state2 = roomState.get(roomCode);
    if (!state2 || state2.status !== "active") break;

    try {
      const key = `${roomCode}-p2-${qNum}`;
      if (!questionCache.has(key)) prefetchQuestion(roomCode, "p2", qNum);

      const qData = await questionCache.get(key);
      questionCache.delete(key);
      if (!qData) { qNum--; await sleep(3000); continue; } // retry

      // Pick answer based on accuracy setting
      const correctIdx = qData.answer ? "ABCD".indexOf(qData.answer.toUpperCase()) : 0;
      let chosenAnswer;
      if (Math.random() < accuracy) {
        chosenAnswer = qData.options?.[correctIdx] || qData.answer || "";
      } else {
        const wrongOpts = (qData.options || []).filter((_, i) => i !== correctIdx);
        chosenAnswer = wrongOpts[Math.floor(Math.random() * wrongOpts.length)] || "";
      }

      const { result } = await writeAndWait(
        "submit_answer",
        [roomCode, JSON.stringify(qData), chosenAnswer, false, AI_ADDRESS],
        300_000
      );

      const state3 = roomState.get(roomCode);
      if (state3) {
        // If AI got it wrong, give P1 a steal
        if ((result === "wrong" || result === "wrong_burn") && !state3.p1_steal) {
          state3.p1_steal = { question: qData, question_num: qNum };
        }
        state3.events = state3.events || [];
        state3.events.push({ type: result, player: "p2", qNum, ts: Date.now() });
        if (state3.events.length > 30) state3.events.shift();
        // Track AI answer for sync gate
        state3.p2_answered_q = Math.max(state3.p2_answered_q || 0, qNum);
      }

      console.log(`[AI] Q${qNum} → ${result}`);

      // Prefetch next 2 questions
      prefetchQuestion(roomCode, "p2", qNum + 1);
      prefetchQuestion(roomCode, "p2", qNum + 2);

      // Handle steal opportunity for AI (50% chance, 2s delay)
      const state4 = roomState.get(roomCode);
      if (state4 && state4.p2_steal) {
        await sleep(1500 + Math.random() * 1500);
        const stealData = state4.p2_steal;
        state4.p2_steal = null;
        try {
          const stealAns = Math.random() < 0.5
            ? (stealData.question.options?.[0] || "") : "";
          const { result: sr } = await writeAndWait(
            "submit_answer",
            [roomCode, JSON.stringify(stealData.question), stealAns, true, AI_ADDRESS],
            300_000
          );
          state4.events = state4.events || [];
          state4.events.push({ type: sr, player: "p2", qNum: stealData.question_num, ts: Date.now() });
          if (state4.events.length > 30) state4.events.shift();
        } catch {}
      }

    } catch (err) {
      console.warn(`[AI] Q${qNum} error:`, err.message);
    }
  }

  console.log(`[AI] Finished all questions for room ${roomCode}`);
}

// ── Auto-miss helper ───────────────────────────────────────────────────────
async function autoMiss(roomCode, player, qNum) {
  const state = roomState.get(roomCode);
  if (!state || state.status !== "active") return;
  if (state[`${player}_last_q`] !== qNum) return; // player already moved on

  // Mark this question as auto-missed so the real answer (if it arrives late) is ignored
  state[`${player}_automissed`] = state[`${player}_automissed`] || new Set();
  state[`${player}_automissed`].add(qNum);

  const playerAddr = player === "p1" ? state.p1_address : state.p2_address;
  if (!playerAddr) return;

  console.log(`[auto-miss] ${player} timed out on Q${qNum} in room ${roomCode}`);

  try {
    // Submit empty answer (treated as wrong)
    const { result } = await writeAndWait(
      "submit_answer",
      [roomCode, "timeout", "", false, playerAddr],
      300_000
    );

    const opponentRole = player === "p1" ? "p2" : "p1";
    const oppStealKey  = `${opponentRole}_steal`;

    // Wrong → give opponent steal if they don't already have one
    if ((result === "wrong" || result === "wrong_burn") && !state[oppStealKey]) {
      state[oppStealKey] = { question: { question: "Timeout question", options: [], answer: "" }, question_num: qNum };
    }

    state.events = state.events || [];
    state.events.push({ type: "timeout", player, qNum, ts: Date.now() });
    if (state.events.length > 30) state.events.shift();
    // Count auto-miss as answered so the sync gate unblocks the opponent
    state[`${player}_answered_q`] = Math.max(state[`${player}_answered_q`] || 0, qNum);

    console.log(`[auto-miss] ${player} Q${qNum} result: ${result}`);
  } catch (err) {
    console.warn(`[auto-miss] Error for ${player} Q${qNum}:`, err.message);
  }
}

// ── Forfeit trigger ────────────────────────────────────────────────────────
async function triggerForfeit(roomCode, winnerRole) {
  const state = roomState.get(roomCode);
  if (!state || state.status !== "active") return;
  if (state.forfeiting) return; // already in progress — block re-entry
  state.forfeiting = true;

  const winnerAddr = winnerRole === "p1" ? state.p1_address : state.p2_address;
  if (!winnerAddr) { state.forfeiting = false; return; }

  console.log(`[forfeit] Triggering forfeit in room ${roomCode} — winner: ${winnerRole}`);

  try {
    const { result } = await writeAndWait("forfeit_game", [roomCode, winnerAddr], 120_000);
    state.status         = "ended";
    state.winner         = result;
    state.forfeit_reason = true;

    state.events = state.events || [];
    state.events.push({ type: "forfeit", player: winnerRole, qNum: 0, ts: Date.now() });
    if (state.events.length > 30) state.events.shift();

    console.log(`[forfeit] Room ${roomCode} forfeited. Result: ${result}`);
  } catch (err) {
    console.warn(`[forfeit] Error in room ${roomCode}:`, err.message);

    // Contract likely rejected because game already ended on-chain — check and sync
    try {
      const raw = await readContract("get_room_info", [roomCode]);
      if (raw && raw !== "not_found") {
        const parts = raw.split("|");
        const chainStatus = parts[0];
        const chainWinner = parts[11];
        if (chainStatus === "finished") {
          state.status = "ended";
          state.winner = chainWinner || state.winner;
          console.log(`[forfeit] Room ${roomCode} already finished on-chain — synced.`);
        }
      }
    } catch {}

    // If still not resolved after check, force-close to stop the watcher loop
    if (state.status !== "ended") {
      state.status = "ended";
      console.warn(`[forfeit] Force-closing room ${roomCode} to stop retry loop.`);
    }
  }
}

// ── Disconnect watcher (runs every 30s) ────────────────────────────────────
setInterval(() => {
  const now     = Date.now();
  const TIMEOUT = 90_000; // 90s silence = rage quit

  for (const [code, state] of roomState) {
    if (state.status !== "active") continue;
    if (state.p2_address === AI_ADDRESS) continue; // AI games never forfeit
    const p1Dead = (now - (state.p1_last_active || now)) > TIMEOUT;
    const p2Dead = (now - (state.p2_last_active || now)) > TIMEOUT;
    if      (p1Dead && !p2Dead) triggerForfeit(code, "p2");
    else if (p2Dead && !p1Dead) triggerForfeit(code, "p1");
  }
}, 30_000);

// ── API Routes ─────────────────────────────────────────────────────────────

/**
 * POST /api/create-room
 * Body: { player_address, anime, league_code? }
 */
app.post("/api/create-room", async (req, res) => {
  const { player_address, anime, league_code } = req.body;
  if (!player_address || !anime) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const room_code = makeRoomCode();
    await writeAndWait("create_room", [room_code, anime, player_address, league_code || ""]);

    roomState.set(room_code, {
      p1_address:   player_address,
      p1_anime:     anime,
      p2_address:   null,
      p2_anime:     null,
      status:       "waiting",
      p1_steal:     null,
      p2_steal:     null,
      winner:       null,
      leagueCode:   league_code || null,
      p1_timer:     null,
      p2_timer:     null,
      p1_last_q:    0,
      p2_last_q:    0,
      p1_answered_q: 0,
      p2_answered_q: 0,
      p1_last_active: Date.now(),
      p2_last_active: Date.now(),
      forfeit_reason: false,
    });

    console.log(`[create-room] Room ${room_code} created by ${player_address}`);
    res.json({ room_code });
  } catch (err) {
    console.error("Create room error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/create-room-ai
 * Body: { player_address, anime, difficulty? }
 * Creates a room and immediately joins it with an AI bot as P2.
 * difficulty: "easy" (40%), "normal" (60%), "hard" (80%)
 */
app.post("/api/create-room-ai", async (req, res) => {
  res.setTimeout(180_000); // only needs time for create_room now
  const { player_address, anime, difficulty } = req.body;
  if (!player_address || !anime) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const accuracyMap = { easy: 0.40, normal: 0.60, hard: 0.82 };
  const accuracy    = accuracyMap[difficulty] || 0.60;
  const ai_anime    = AI_ANIMES[Math.floor(Math.random() * AI_ANIMES.length)];

  try {
    const room_code = makeRoomCode();

    // Step 1: create room — must wait so the room exists before join_room fires
    await writeAndWait("create_room", [room_code, anime, player_address, ""]);

    // Set state as "waiting" — flips to "active" once join_room confirms in background
    roomState.set(room_code, {
      p1_address:     player_address,
      p1_anime:       anime,
      p2_address:     AI_ADDRESS,
      p2_anime:       ai_anime,
      status:         "waiting",
      p1_steal:       null,
      p2_steal:       null,
      winner:         null,
      leagueCode:     null,
      p1_timer:       null,
      p2_timer:       null,
      p1_last_q:      0,
      p2_last_q:      0,
      p1_answered_q:  0,
      p2_answered_q:  0,
      p1_last_active: Date.now(),
      p2_last_active: Date.now(),
      forfeit_reason: false,
    });

    // Respond immediately — client polls for "active" while we finish setup
    console.log(`[create-room-ai] Room ${room_code} created — AI joining in background`);
    res.json({ room_code, ai_anime, ai_address: AI_ADDRESS });

    // Background: join + reset + prefetch + start AI loop
    ;(async () => {
      try {
        await writeAndWait("join_room", [room_code, ai_anime, AI_ADDRESS]);

        // Reset human balance to 20 (requires contract redeployment)
        try {
          await writeAndWait("reset_balance_for_ai", [room_code, player_address], 120_000);
        } catch (resetErr) {
          console.warn("[create-room-ai] reset_balance_for_ai not available yet:", resetErr.message.slice(0, 60));
        }

        const state = roomState.get(room_code);
        if (!state) return;
        state.status = "active";
        state.p1_last_active = Date.now();
        state.p2_last_active = Date.now();

        prefetchQuestion(room_code, "p1", 1);
        prefetchQuestion(room_code, "p1", 2);
        prefetchQuestion(room_code, "p2", 1);
        prefetchQuestion(room_code, "p2", 2);

        runAIPlayer(room_code, accuracy).catch(err =>
          console.error(`[AI] Fatal error in room ${room_code}:`, err.message)
        );

        console.log(`[create-room-ai] Room ${room_code} ACTIVE — AI (${ai_anime}, ${difficulty || "normal"}) vs ${player_address}`);
      } catch (bgErr) {
        console.error(`[create-room-ai] Background setup failed for ${room_code}:`, bgErr.message);
        const state = roomState.get(room_code);
        if (state) state.status = "error";
      }
    })();

  } catch (err) {
    console.error("Create AI room error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/join-room
 * Body: { room_code, player_address, anime, league_code? }
 */
app.post("/api/join-room", async (req, res) => {
  res.setTimeout(300_000);

  const { room_code, player_address, anime, league_code } = req.body;
  if (!room_code || !player_address || !anime) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const state = roomState.get(room_code);
  if (!state) return res.status(404).json({ error: "Room not found. Check the code and try again." });
  if (state.status !== "waiting") return res.status(400).json({ error: "This room has already started." });

  try {
    await writeAndWait("join_room", [room_code, anime, player_address]);

    state.p2_address   = player_address;
    state.p2_anime     = anime;
    state.status       = "active";
    state.p1_last_active = Date.now();
    state.p2_last_active = Date.now();
    if (league_code) state.leagueCode = league_code;

    // Immediately start prefetching Q1+Q2 for both players
    prefetchQuestion(room_code, "p1", 1);
    prefetchQuestion(room_code, "p1", 2);
    prefetchQuestion(room_code, "p2", 1);
    prefetchQuestion(room_code, "p2", 2);

    console.log(`[join-room] Room ${room_code} — P2 ${player_address} joined. Game is ACTIVE.`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Join room error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/poll/:code/:player
 * Lightweight polling — returns game status, scores, steal opportunities.
 */
app.get("/api/poll/:code/:player", async (req, res) => {
  const { code, player } = req.params;
  const state = roomState.get(code);

  if (!state) return res.status(404).json({ error: "Room not found" });

  // Update last_active for this player
  if (player === "p1" || player === "p2") {
    state[`${player}_last_active`] = Date.now();
  }

  if (state.status === "waiting") {
    return res.json({ status: "waiting" });
  }

  let cd = {
    roomStatus: state.status,
    p1: state.p1_address, p2: state.p2_address,
    anime1: state.p1_anime, anime2: state.p2_anime,
    p1_bal: 20, p2_bal: 20, q1: 0, q2: 0,
    pu1: "", pu2: "", winner: state.winner,
    snipe1: 0, snipe2: 0, bets_p1: 0, bets_p2: 0,
    p1_cstreak: 0, p2_cstreak: 0, p1_wstreak: 0, p2_wstreak: 0,
  };

  try {
    const raw = await readContract("get_room_info", [code]);
    if (raw && raw !== "not_found") {
      const parts = raw.split("|");
      const [roomStatus, p1, p2, anime1, anime2, p1_bal, p2_bal, q1, q2,
             pu1, pu2, winner, snipe1, snipe2, bets_p1, bets_p2,
             p1_cs, p2_cs, p1_ws, p2_ws, league_code_chain] = parts;
      cd = {
        roomStatus, p1, p2, anime1, anime2,
        p1_bal: Number(p1_bal), p2_bal: Number(p2_bal),
        q1: Number(q1), q2: Number(q2),
        pu1, pu2, winner,
        snipe1: Number(snipe1||0), snipe2: Number(snipe2||0),
        bets_p1: Number(bets_p1||0), bets_p2: Number(bets_p2||0),
        p1_cstreak: Number(p1_cs||0), p2_cstreak: Number(p2_cs||0),
        p1_wstreak: Number(p1_ws||0), p2_wstreak: Number(p2_ws||0),
        league_code_chain: league_code_chain || "",
      };
      // Sync leagueCode from chain into memory (survives server restart)
      if (state && !state.leagueCode && cd.league_code_chain) {
        state.leagueCode = cd.league_code_chain;
      }
    }
  } catch (err) {
    console.warn(`[poll] readContract failed for ${code}: ${err.message.slice(0, 80)}`);
  }

  const mySteal     = player === "p1" ? state.p1_steal : state.p2_steal;
  const myBal       = player === "p1" ? cd.p1_bal      : cd.p2_bal;
  const oppBal      = player === "p1" ? cd.p2_bal      : cd.p1_bal;
  const myCstreak   = player === "p1" ? cd.p1_cstreak  : cd.p2_cstreak;
  const myWstreak   = player === "p1" ? cd.p1_wstreak  : cd.p2_wstreak;
  const myPU        = player === "p1" ? cd.pu1         : cd.pu2;

  res.json({
    status:          state.status,
    room_status:     cd.roomStatus,
    p1_address:      cd.p1,
    p2_address:      cd.p2,
    p1_anime:        cd.anime1 || state.p1_anime,
    p2_anime:        cd.anime2 || state.p2_anime,
    p1_bal:          cd.p1_bal,
    p2_bal:          cd.p2_bal,
    myBal,
    oppBal,
    p1_question:     cd.q1,
    p2_question:     cd.q2,
    pu1: cd.pu1,     pu2: cd.pu2,
    myPU,
    steal_available: mySteal || null,
    winner:          cd.winner || state.winner || null,
    forfeit_reason:  state.forfeit_reason || false,
    myCorrectStreak: myCstreak,
    myWrongStreak:   myWstreak,
  });
});

/**
 * POST /api/question
 * Body: { room_code, for_player, question_num }
 * Sets server-side auto-miss timer (15s).
 */
app.post("/api/question", async (req, res) => {
  res.setTimeout(300_000);

  const { room_code, for_player, question_num } = req.body;
  if (!room_code || !for_player || !question_num) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const qNum  = Number(question_num);
    const key   = `${room_code}-${for_player}-${qNum}`;
    const state = roomState.get(room_code);

    // ── Sync gate: both players advance together question by question ─────────
    // Don't give Q(n) until the opponent has answered Q(n-1).
    // Skipped for AI games — AI has built-in chain delay so gating would stack
    // wait times and feel broken (20-45s AI delay + 30-120s chain × 40 questions).
    const isAIGame = state && state.p2_address === AI_ADDRESS;
    if (qNum > 1 && state && !isAIGame) {
      const oppRole     = for_player === "p1" ? "p2" : "p1";
      const oppAnswered = state[`${oppRole}_answered_q`] || 0;
      if (oppAnswered < qNum - 1) {
        console.log(`[question] ${for_player} wants Q${qNum} but opp at Q${oppAnswered} — gating`);
        return res.json({ waiting: true, opp_q: oppAnswered, your_q: qNum });
      }
    }

    if (!questionCache.has(key)) {
      console.log(`[question] Cache miss for ${for_player} Q${qNum} — fetching now`);
      prefetchQuestion(room_code, for_player, qNum);
    } else {
      console.log(`[question] Cache hit for ${for_player} Q${qNum} — using prefetch`);
    }

    const parsed = await questionCache.get(key);
    questionCache.delete(key);

    if (!parsed) throw new Error("Failed to generate question — please try again");

    // ── Set auto-miss timer ────────────────────────────────────────────────
    if (state) {
      clearTimeout(state[`${for_player}_timer`]);
      state[`${for_player}_last_q`]      = qNum;
      state[`${for_player}_last_active`] = Date.now();
      state[`${for_player}_timer`]       = setTimeout(
        () => autoMiss(room_code, for_player, qNum), 120_000
      );
    }

    // Prefetch next 2 questions — gives more buffer time against chain slowness
    // AI loop handles p2 prefetching independently so we only prefetch for the requesting player
    prefetchQuestion(room_code, for_player, qNum + 1);
    prefetchQuestion(room_code, for_player, qNum + 2);

    res.json({ question: parsed });
  } catch (err) {
    console.error("Question error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/answer
 * Body: { room_code, question, player_answer, is_steal, player_address, player_role, question_num }
 * Optimistic: clears timer immediately, fires contract in background.
 */
app.post("/api/answer", async (req, res) => {
  res.setTimeout(300_000);

  const { room_code, question, player_answer, is_steal, player_address, player_role, question_num } = req.body;
  if (!room_code || !question || !player_address) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const state = roomState.get(room_code);

  // Clear auto-miss timer immediately
  if (state && player_role) {
    clearTimeout(state[`${player_role}_timer`]);
    state[`${player_role}_last_active`] = Date.now();
  }

  // If auto-miss already fired for this question, skip — don't double-increment counter
  if (!is_steal && state && player_role && question_num) {
    const missed = state[`${player_role}_automissed`];
    if (missed && missed.has(Number(question_num))) {
      console.log(`[answer] Skipping late answer for ${player_role} Q${question_num} — already auto-missed`);
      return res.json({ result: "wrong" }); // treat as wrong, don't re-submit to chain
    }
  }

  try {
    const { result } = await writeAndWait(
      "submit_answer",
      [room_code, question, player_answer || "", Boolean(is_steal), player_address],
      150_000  // 2.5 min cap — Studionet rarely needs more; if it does, treat as miss
    );

    if (state) {
      const opponentRole = player_role === "p1" ? "p2" : "p1";
      const oppStealKey  = `${opponentRole}_steal`;

      // Track answered question for sync gate (normal answers only, not steals)
      if (!is_steal && player_role && question_num) {
        const qn = Number(question_num);
        if (qn > (state[`${player_role}_answered_q`] || 0)) {
          state[`${player_role}_answered_q`] = qn;
        }
      }

      // Wrong answer on a regular question → give opponent a steal
      if (!is_steal && (result === "wrong" || result === "wrong_burn")) {
        if (!state[oppStealKey]) {
          let questionObj = null;
          try { questionObj = typeof question === "string" ? JSON.parse(question) : question; } catch {}
          state[oppStealKey] = { question: questionObj, question_num: Number(question_num) };
          console.log(`[answer] ${player_role} wrong on Q${question_num} — steal queued for ${opponentRole}`);
        }
      }

      // After a steal attempt, clear the steal state
      if (is_steal) {
        state[`${player_role}_steal`] = null;
        console.log(`[answer] ${player_role} steal cleared`);
      }

      state.events = state.events || [];
      state.events.push({ type: result, player: player_role, qNum: Number(question_num||0), ts: Date.now() });
      if (state.events.length > 30) state.events.shift();
    }

    res.json({ result });
  } catch (err) {
    console.error("Answer error:", err.message);
    // Chain failed (UNDETERMINED / timeout) — don't crash the game.
    // Count as answered so sync gate and end-game don't get stuck.
    if (state && player_role && question_num && !is_steal) {
      const qn = Number(question_num);
      if (qn > (state[`${player_role}_answered_q`] || 0)) {
        state[`${player_role}_answered_q`] = qn;
      }
    }
    // Return wrong so client can show result and advance
    res.json({ result: "wrong", chain_error: true });
  }
});

/**
 * POST /api/end-game
 * Body: { room_code, player_address }
 */
app.post("/api/end-game", async (req, res) => {
  res.setTimeout(120_000);

  const { room_code, player_address } = req.body;
  if (!room_code || !player_address) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // ── Pre-check: both players must have answered all 40 questions ───────────
  // Avoids hitting the contract's assert and crashing the client.
  try {
    const raw = await readContract("get_room_info", [room_code]);
    if (raw && raw !== "not_found") {
      const parts = raw.split("|");
      const q1 = Number(parts[7]);
      const q2 = Number(parts[8]);
      if (q1 < 40 || q2 < 40) {
        console.log(`[end-game] Not ready — q1=${q1}, q2=${q2}`);
        return res.json({ waiting: true, q1, q2 });
      }
    }
  } catch (checkErr) {
    console.warn("[end-game] Pre-check failed:", checkErr.message.slice(0, 80));
    // Fall through — let the contract assertion give the real error
  }

  try {
    const { result } = await writeAndWait(
      "end_game",
      [room_code, player_address],
      120_000
    );

    const state = roomState.get(room_code);
    if (state) {
      state.status = "ended";
      state.winner = result;

      // ── Record league result if this room belongs to a league ─────────────
      // Fetch final room info to get balances AND league_code from chain
      // (league_code from chain = survives server restart, state.leagueCode is memory-only fallback)
      if (result && result !== "tie") {
        try {
          const raw = await readContract("get_room_info", [room_code]);
          if (raw && raw !== "not_found") {
            const parts           = raw.split("|");
            const p1_bal          = Number(parts[5]);
            const p2_bal          = Number(parts[6]);
            const league_code_chain = parts[20] || "";

            // Prefer chain value, fall back to in-memory
            const effectiveLeague = league_code_chain || state.leagueCode || null;

            if (effectiveLeague) {
              const winnerAddr = result.replace("winner:", "");
              const loserAddr  = state.p1_address === winnerAddr ? state.p2_address : state.p1_address;
              const winBal     = state.p1_address === winnerAddr ? p1_bal : p2_bal;
              const loseBal    = state.p1_address === loserAddr  ? p1_bal : p2_bal;
              const winDelta   = winBal  - 20;
              const loseDelta  = loseBal - 20;

              await writeAndWait("record_league_result", [
                effectiveLeague, winnerAddr, loserAddr, winDelta, loseDelta
              ], 120_000);
              console.log(`[end-game] League result recorded for ${effectiveLeague}`);
            }
          }
        } catch (leagueErr) {
          console.warn("[end-game] League record failed:", leagueErr.message);
        }
      }
    }

    console.log(`[end-game] Room ${room_code} ended. Winner: ${result}`);
    res.json({ result });
  } catch (err) {
    console.warn("End game error (may be duplicate call):", err.message);
    const state = roomState.get(room_code);
    if (state?.winner) {
      return res.json({ result: state.winner });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/room/:code
 * Raw contract room info (kept for debugging).
 */
app.get("/api/room/:code", async (req, res) => {
  try {
    const raw = await readContract("get_room_info", [req.params.code]);
    if (raw === "not_found") return res.json({ found: false });

    const parts = raw.split("|");
    const [state, p1, p2, anime1, anime2, p1_bal, p2_bal, q1, q2,
           pu1, pu2, winner, snipe1, snipe2, bets_p1, bets_p2,
           p1_cs, p2_cs, p1_ws, p2_ws, league_code] = parts;
    res.json({
      found: true,
      state, p1, p2, anime1, anime2,
      p1_bal: Number(p1_bal), p2_bal: Number(p2_bal),
      q1: Number(q1), q2: Number(q2),
      pu1, pu2, winner,
      snipe1: Number(snipe1||0), snipe2: Number(snipe2||0),
      bets_p1: Number(bets_p1||0), bets_p2: Number(bets_p2||0),
      p1_cstreak: Number(p1_cs||0), p2_cstreak: Number(p2_cs||0),
      p1_wstreak: Number(p1_ws||0), p2_wstreak: Number(p2_ws||0),
      league_code: league_code || "",
    });
  } catch (err) {
    console.error("Room info error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/balance/:addr
 */
app.get("/api/balance/:addr", async (req, res) => {
  try {
    const result = await readContract("get_balance", [req.params.addr]);
    res.json({ balance: Number(result) });
  } catch (err) {
    console.error("Balance error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/use-snipe
 */
app.post("/api/use-snipe", async (req, res) => {
  res.setTimeout(120_000);
  const { room_code, player_address } = req.body;
  if (!room_code || !player_address) return res.status(400).json({ error: "Missing fields" });

  try {
    const { result } = await writeAndWait("use_snipe", [room_code, player_address], 120_000);

    const state = roomState.get(room_code);
    if (state) {
      const player_role = state.p1_address === player_address ? "p1" : "p2";
      state.events = state.events || [];
      state.events.push({ type: "snipe_used", player: player_role, qNum: 0, ts: Date.now() });
      if (state.events.length > 30) state.events.shift();
    }

    console.log(`[use-snipe] ${player_address} activated snipe in room ${room_code}`);
    res.json({ result });
  } catch (err) {
    console.error("Use snipe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/lobby
 */
app.get("/api/lobby", (req, res) => {
  const rooms = [];
  for (const [code, state] of roomState.entries()) {
    if (state.status !== "ended") {
      rooms.push({
        room_code: code,
        status:    state.status,
        p1_anime:  state.p1_anime,
        p2_anime:  state.p2_anime || null,
      });
    }
  }
  res.json({ rooms });
});

/**
 * GET /api/spectate/:code
 */
app.get("/api/spectate/:code", async (req, res) => {
  const { code } = req.params;
  const state = roomState.get(code);
  if (!state) return res.status(404).json({ error: "Room not found" });

  let cd = {
    roomStatus: state.status,
    p1: state.p1_address, p2: state.p2_address,
    anime1: state.p1_anime, anime2: state.p2_anime,
    p1_bal: 20, p2_bal: 20, q1: 0, q2: 0, pu1: "", pu2: "",
    winner: state.winner, snipe1: 0, snipe2: 0, bets_p1: 0, bets_p2: 0,
  };

  try {
    const raw = await readContract("get_room_info", [code]);
    if (raw && raw !== "not_found") {
      const parts = raw.split("|");
      const [roomStatus, p1, p2, anime1, anime2, p1_bal, p2_bal, q1, q2,
             pu1, pu2, winner, snipe1, snipe2, bets_p1, bets_p2] = parts;
      cd = {
        roomStatus, p1, p2, anime1, anime2,
        p1_bal: Number(p1_bal), p2_bal: Number(p2_bal),
        q1: Number(q1), q2: Number(q2),
        pu1, pu2, winner,
        snipe1: Number(snipe1||0), snipe2: Number(snipe2||0),
        bets_p1: Number(bets_p1||0), bets_p2: Number(bets_p2||0),
      };
    }
  } catch (err) {
    console.warn(`[spectate] readContract failed: ${err.message.slice(0, 80)}`);
  }

  res.json({
    status:       state.status,
    p1_address:   cd.p1  || state.p1_address,
    p2_address:   cd.p2  || state.p2_address,
    p1_anime:     cd.anime1 || state.p1_anime,
    p2_anime:     cd.anime2 || state.p2_anime,
    p1_bal:       cd.p1_bal,
    p2_bal:       cd.p2_bal,
    p1_question:  cd.q1,
    p2_question:  cd.q2,
    pu1: cd.pu1,  pu2: cd.pu2,
    winner:       cd.winner || state.winner || null,
    snipe1:       cd.snipe1, snipe2: cd.snipe2,
    bets_p1:      cd.bets_p1, bets_p2: cd.bets_p2,
    events:       (state.events || []).slice(-15),
    forfeit_reason: state.forfeit_reason || false,
  });
});

/**
 * POST /api/spectator-airdrop
 */
app.post("/api/spectator-airdrop", async (req, res) => {
  res.setTimeout(120_000);
  const { bettor_address } = req.body;
  if (!bettor_address) return res.status(400).json({ error: "Missing bettor_address" });

  try {
    await writeAndWait("spectator_airdrop", [bettor_address], 120_000);
    res.json({ ok: true });
  } catch (err) {
    console.error("Spectator airdrop error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bet
 */
app.post("/api/bet", async (req, res) => {
  res.setTimeout(120_000);
  const { room_code, bettor_address, side, amount } = req.body;
  if (!room_code || !bettor_address || !side || !amount) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    await writeAndWait("place_bet", [room_code, bettor_address, side, Number(amount)], 120_000);
    res.json({ ok: true });
  } catch (err) {
    console.error("Bet error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/claim
 */
app.post("/api/claim", async (req, res) => {
  res.setTimeout(120_000);
  const { room_code, bettor_address } = req.body;
  if (!room_code || !bettor_address) return res.status(400).json({ error: "Missing fields" });

  try {
    const { result } = await writeAndWait("claim_winnings", [room_code, bettor_address], 120_000);
    res.json({ payout: Number(result) });
  } catch (err) {
    console.error("Claim error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/bettor/:code/:addr
 */
app.get("/api/bettor/:code/:addr", async (req, res) => {
  try {
    const raw = await readContract("get_bettor_info", [req.params.code, req.params.addr]);
    if (raw === "none") return res.json({ bet: null });
    const [side, amount, claimed] = raw.split("|");
    res.json({ bet: { side, amount: Number(amount), claimed: Number(claimed) === 1 } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── League Endpoints ────────────────────────────────────────────────────────

/**
 * POST /api/league/create
 * Body: { league_code, name, creator_address }
 */
app.post("/api/league/create", async (req, res) => {
  res.setTimeout(120_000);
  const { league_code, name, creator_address } = req.body;
  if (!league_code || !name || !creator_address) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const created_at = Math.floor(Date.now() / 1000);
    await writeAndWait("create_league", [league_code, name, creator_address, created_at], 120_000);

    leagueRegistry.set(league_code, { name, creator: creator_address, created_at, member_count: 1 });

    console.log(`[league/create] ${league_code} — ${name}`);
    res.json({ ok: true, league_code });
  } catch (err) {
    console.error("League create error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/league/join
 * Body: { league_code, member_address }
 */
app.post("/api/league/join", async (req, res) => {
  res.setTimeout(120_000);
  const { league_code, member_address } = req.body;
  if (!league_code || !member_address) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    await writeAndWait("join_league", [league_code, member_address], 120_000);

    const reg = leagueRegistry.get(league_code);
    if (reg) reg.member_count = (reg.member_count || 0) + 1;

    console.log(`[league/join] ${member_address} joined ${league_code}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("League join error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/league/:code
 * Returns league info + assembled standings.
 */
app.get("/api/league/:code", async (req, res) => {
  const { code } = req.params;

  try {
    const infoRaw = await readContract("get_league_info", [code]);
    if (infoRaw === "not_found") return res.status(404).json({ error: "League not found" });

    const [name, creator, member_count_str, created_at_str] = infoRaw.split("|");
    const member_count = Number(member_count_str);
    const created_at   = Number(created_at_str);

    // Fetch all members in parallel
    const memberPromises = [];
    for (let i = 0; i < member_count; i++) {
      memberPromises.push(readContract("get_league_member", [code, i]));
    }
    const members = await Promise.all(memberPromises);

    // Fetch stats for each member in parallel
    const statsPromises = members.map(addr =>
      addr ? readContract("get_member_stats", [code, addr]) : Promise.resolve("0|0|0|0")
    );
    const statsRaw = await Promise.all(statsPromises);

    const standings = members.map((addr, i) => {
      const raw    = statsRaw[i] || "0|0|0|0";
      const parts  = raw.split("|");
      return {
        address:       addr,
        short_addr:    addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "—",
        wins:          Number(parts[0] || 0),
        losses:        Number(parts[1] || 0),
        tokens_earned: Number(parts[2] || 0),
        games:         Number(parts[3] || 0),
      };
    });

    // Sort: wins desc, then tokens_earned desc
    standings.sort((a, b) => b.wins - a.wins || b.tokens_earned - a.tokens_earned);

    res.json({ name, creator, member_count, created_at, standings });
  } catch (err) {
    console.error("League info error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/leagues
 * Returns all leagues from in-memory registry.
 */
app.get("/api/leagues", (req, res) => {
  const leagues = [];
  for (const [code, info] of leagueRegistry.entries()) {
    leagues.push({ league_code: code, ...info });
  }
  res.json({ leagues });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log("Open that URL in your browser to play!");
});
