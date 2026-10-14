> **BACKEND PLAN 2026-10-14:** server ab Firestore par shift ho raha hai (Firebase Admin SDK), SQLite naye kaam ke liye nahi. Poora plan, niyam aur TASK LOG root `../README.md` ke sabse upar. Naye routes `/api/v2/...`: wallet, wallet/history, deposit/config, deposits, deposits/mine, admin/deposits (+proof, approve, reject), admin/payment-info, admin/deposit-settings, withdraw/config, withdrawals (+mine, proof), admin/withdrawals (+proof, approve, reject), admin/withdraw-settings, tournaments/:tid/join. Env: `FIREBASE_SERVICE_ACCOUNT_B64`. Tests: `npm test` (54).

> **ZIP RULE:** zip chhoti rakho. `build/`, `.gradle/`, `node_modules/`, `*.apk`, `*.class`, `*.dex`, `*.log` zip mein mat daalo (Termux build se khud ban jaate hain). Poori detail aur command: root `../README.md` (top box + section "RULE FOR EVERY AI: how to give the project zip").

# NST Server (deposit server, TEST version)

Node.js 22 + SQLite (`node:sqlite`), **zero dependencies** (no `npm install` needed). Abhi sirf **Payvex ka Deposit screen** isse juda hai.
Login Firebase Google Sign-In hi hai; server har request ka Firebase ID token khud verify karta hai (Google ki public certificates se, koi service-account key nahi).

## 1. GitHub par kya chal sakta hai (SACH)
- **GitHub Pages / raw files sirf static hain.** Node.js server wahan nahi chalta.
- Test ke liye server **GitHub Codespaces** mein chalta hai (`.devcontainer/devcontainer.json` ready hai). Codespace ka address `https://<codespace-naam>-3000.app.github.dev` hota hai aur **naya codespace banne par badal jata hai**, aur idle hone par codespace so jata hai.
- Isliye app mein server ka address **fix nahi** hai. Neeche ka design isi ke liye hai.

## 2. URL design: app ko hamesha GitHub wala hi address milta hai
```
Payvex / Admin app  --(1) fixed address-->  GitHub: server.json  (repo ki file)
                    <--(2) {"baseUrl": "https://....app.github.dev"}
                    --(3) asli API calls --> baseUrl + /api/...
```
- Apps mein sirf ek fixed address hai: `Api.CONFIG_URL` = `https://raw.githubusercontent.com/<GITHUB_USER>/<REPO>/main/server.json` (Payvex aur Admin, dono `Api.java`, **repo public hona chahiye**).
- Server ka address badle to **sirf `server.json` badalti hai**, app dobara build nahi karni. `npm run codespace` (ya `npm run publish-url -- --push`) ye khud kar deta hai: address nikalta hai, `server.json` likhta hai, git commit + push.
- App address 10 minute memory mein rakhti hai. Agar call connect na ho (server naye address par chala gaya), app `server.json` dobara padhti hai aur **ek baar naye address par retry** karti hai. GitHub ka cache ~5 minute ho sakta hai, isliye address badalne ke baad 5 minute tak purana dikh sakta hai.
- Address kabhi screen par nahi dikhta.

## 3. Owner ke steps (order zaroori)
1. GitHub par **public repo** banao, is folder (`NST Server/`) ki saari files repo ke **root** par daalo (`server.json`, `src/`, `.devcontainer/` ... root par).
2. `Payvex/.../Api.java` aur `Noryvexal Admin/.../Api.java` mein `CONFIG_URL` ki line mein `YOUR_GITHUB_USER/YOUR_REPO` badlo. Dono apps dobara build karo (ek hi baar).
3. Repo > Settings > Secrets and variables > **Codespaces** mein secret `ADMIN_UIDS` = owner ka Firebase uid (Firebase Console > Authentication > Users > User UID). Optional: `CORS_ORIGINS`, `DEPOSIT_DAILY_LIMIT` etc. (`.env.example`).
4. Repo > Code > **Codespaces** > naya codespace. Start par `npm run codespace` apne aap chalta hai (server + `server.json` push + port public).
5. Admin app > **Payment details** mein UPI ID (+ QR https link) daalo. Phir Payvex > Deposit mein test karo.
- Agar port public nahi hua: Codespace > Ports tab > 3000 par right click > Port Visibility > **Public** (phone app GitHub login nahi kar sakti).

## 4. API (sab JSON, `Authorization: Bearer <Firebase ID token>`)
| Kaun | Route | Kaam |
|---|---|---|
| public | `GET /api/health` | chal raha hai? |
| user | `POST /api/auth/session` | user banao/dhundo, `isAdmin`, coins |
| user | `GET /api/wallet`, `GET /api/wallet/history` | server wallet (coins, winCoins) + ledger |
| user | `GET /api/deposit/config` | UPI ID, QR link, `depositOn`, `dailyLimit`, `usedToday`, `min`, `max` (Deposit screen ek call mein) |
| user | `GET /api/payment-info` | UPI ID + QR |
| user | `POST /api/deposits` `{amount, img, thumb}` | deposit request (img/thumb = base64 JPEG) |
| user | `GET /api/deposits/mine` | apni requests (screenshot ke bina) |
| owner | `GET /api/admin/deposits?status=&limit=` | pending pehle, thumb ke saath |
| owner | `GET /api/admin/deposits/:id/proof` | poora screenshot |
| owner | `POST /api/admin/deposits/:id/approve` / `reject` | ek hi baar; approve = coins server wallet mein |
| owner | `PUT/DELETE /api/admin/payment-info` | UPI ID + QR |
| owner | `PUT /api/admin/deposit-settings` `{depositOn, dailyLimit}` | deposit on/off, daily limit |
| owner | `GET /api/admin/backup` | SQLite ki copy download |
Errors: `{ "error": "<code>", "message": "<user ke liye chhota text>" }`.

## 5. Security (kya server khud check karta hai)
- Token: RS256 signature, `exp`, `iat`, `aud`, `iss`, `sub`. Owner = `ADMIN_UIDS` (env). App ka login sirf screen ka gate hai.
- Deposit id = **server khud screenshot ka SHA-256** banata hai (app ka bheja hash nahi maanta): same screenshot do baar nahi (kisi bhi user se).
- Screenshot sirf JPEG (magic bytes), max 300 KB; thumb max 40 KB. Amount whole number, min/max, daily limit (India din, `TZ_OFFSET_MIN=330`), max pending per user (default 5), per-user rate limit (10 deposits / 10 min).
- Approve/reject: status + coins **ek transaction** mein; ledger `(type, ref)` unique, isliye ek deposit ke coins do baar nahi judte.
- CORS sirf `CORS_ORIGINS` wale web origins ko. Body max 600 KB.

## 6. Limits / kya abhi NAHI hua (imandari se)
- **Coins server ke wallet (SQLite) mein jama hote hain.** Payvex Home, Withdraw aur Arena abhi **Firestore wallet** padhte hain, isliye approve ke baad coins unhe nahi dikhte jab tak wallet bhi server par shift na ho (agla task). `GET /api/wallet` ready hai.
- Admin ka App Control (deposit on/off, daily limit) Firestore par hai; deposit screen ab server ki settings se chalta hai (`PUT /api/admin/deposit-settings`). Admin mein iska button agla chhota task.
- Server abhi check nahi karta ki user Arena website par signup hua hai (Payvex ka login gate client par Firestore se hai).
- **Data:** Codespace ki disk par SQLite file tab tak rehti hai jab tak codespace delete na ho. Ye **sirf test** hai. Asli paise se pehle persistent host + backup (`/api/admin/backup`) ka faisla owner ka (root README 23.3).
- Codespaces idle (~30 min) par so jata hai; phone se pehli request fail ho sakti hai, codespace dobara chalao.
- **Chalaya nahi gaya:** asli GitHub Codespace, asli Firebase token, phone par app. Sirf yahan: 22 automated tests pass (`npm test`).

## 7. Local run
```
cd "NST Server"
ADMIN_UIDS=<uid> npm start      # http://localhost:3000
npm test                         # 22 tests
```

## 8. v2 (Firestore) owner routes: result, complete, cancel (T5, 2026-10-14)
| Route | Kaam |
|---|---|
| `POST /api/v2/admin/tournaments/:tid/result` `{players:[{uid,kills,coins}], complete?}` | prize + kills save: `prizeCredits`, `results/{tid}/players`, wallet (winnings), `leaderboard`, `leaderboardWeeks`. Ek player ek baar. Total coins <= prizePool, kills <= joined - 1 |
| `POST /api/v2/admin/tournaments/:tid/complete` | ongoing > completed + `results/{tid}` summary |
| `POST /api/v2/admin/tournaments/:tid/cancel` | cancelled + sab ko fee wapas (`refunds`, ledger `refund_*`); dobara call karne par sirf bache hue ko |
Week rule (IST Monday) = `src/weekkey.js`, Admin `Week.java` aur Arena `weekKey()` jaisa hi. Tests: `npm test` (73).

## 9. v2 owner routes: players (T6, 2026-10-14)
| Route | Kaam |
|---|---|
| `GET /api/v2/admin/users/:uid` | profile, status, game verify, wallet |
| `POST .../status` `{status, hours?, reason?}` | active / suspended (1..8760 ghante) / banned; reason 3..200; admin par nahi |
| `POST .../game-verified` `{value}` | true sirf poore game details par |
| `POST .../activity` `{matchesPlayed, totalKill}` | 0..1,000,000 |
| `POST .../wallet` `{coins, winCoins, note?}` | exact set, log `walletEdits` + ledger `admin_*` |
Tests: `npm test` (82).
