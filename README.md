# GenLayer Anime Trivia Duel

A 1v1 anime trivia game where players bet real **GOT (GenLayer Otaku Token)** on their anime knowledge. Built on the [GenLayer](https://genlayer.com) blockchain — questions are generated live by AI, answers are verified on-chain.

---

## What Is This?

Two players pick their anime, each get airdropped **20 GOT tokens**, and battle through **40 AI-generated trivia questions**. Miss a question and your opponent gets a steal window. Miss together and the tokens get **burned forever**. Last one standing keeps the pot.

---

## Features

- **AI-Generated Questions** — Every question is generated in real-time from the chosen anime using GenLayer's Intelligent Contracts
- **Token Stakes** — Real GOT tokens on the line. Win means you take their tokens. Quit means half burned, half to opponent
- **Steal Mechanic** — Miss a question and your opponent has 5 seconds to steal your token
- **Wild Card Round** — Questions 36-40 come from a random anime neither player picked
- **Streak Burn** — 5 wrong answers in a row burns 1 of your tokens
- **Power-Ups** (earned every 3 correct in a row):
  - **SHIELD** — Block one steal attempt
  - **DOUBLE DOWN** — Next steal wins 2 tokens
  - **SNIPE** — Force opponent to answer one of YOUR anime questions
- **League System** — Create leagues, track standings, compete across multiple matches
- **AI Opponent** — Play solo against an AI challenger
- **Spectator Mode** — Watch live matches in real time

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Blockchain | [GenLayer](https://genlayer.com) (Studionet) |
| Smart Contract | Python Intelligent Contract |
| Backend | Node.js + Socket.io |
| Frontend | HTML / CSS / Vanilla JS |
| SDK | genlayer-js v0.18.10 |

---

## How to Run Locally

**1. Clone the repo**
```bash
git clone https://github.com/bolarinwa420/genlayer-anime-trivia.git
cd genlayer-anime-trivia
```

**2. Install dependencies**
```bash
npm install
```

**3. Create a `.env` file**
```
PRIVATE_KEY=your_wallet_private_key
CONTRACT_ADDRESS=your_deployed_contract_address
RPC_ENDPOINT=https://studio.genlayer.com/api
PORT=3000
```

**4. Deploy the contract**
- Open `contract.py` in [GenLayer Studio](https://studio.genlayer.com)
- Deploy it and copy the contract address into your `.env`

**5. Start the server**
```bash
node server.js
```

Then open `http://localhost:3000` in your browser.

---

## Contract

The Intelligent Contract (`contract.py`) handles:
- Token airdrop at game start
- Question generation via AI
- Answer verification
- Token transfers between players
- Burn mechanics
- Forfeit logic
- Full league system

---

## Built For

GenLayer Builder Program — showcasing Intelligent Contracts with real AI-driven game logic on-chain.
