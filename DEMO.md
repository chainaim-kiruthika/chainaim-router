# Demo runbook: ChainAim gateway on Windows

Use this every time you run or present the gateway demo on this machine.
Setup (Steps 1 to 3) takes about 2 minutes.

Last verified 2026-09-22: Windows 11, Windows PowerShell 5.1, Node 24.19, Ollama 0.34.2,
`config/catalog.ollama.json`.

## Every time: quick start

1. **Warm the models** unless `ollama ps` already lists both with `Forever` ([Step 1](#step-1-warm-the-models)).
2. **Terminal 1:** start the gateway and leave it running ([Step 2](#step-2-start-the-gateway-terminal-1)).
3. **Any other terminal:** `.\scripts\demo.ps1 Deployments` shows both models healthy ([Step 3](#step-3-check-the-gateway)).
4. **Present** from that terminal ([Step 4](#step-4-run-the-demo)).

Run every command from the repo root (the folder containing `README.md`). Every demo command
starts with `.\scripts\demo.ps1`, so it works in any terminal; there is nothing to load first.

## Before the first run (once per machine)

- Node 22.22 or newer: `node --version`
- Ollama installed and running (tray icon), with both models pulled:
  ```powershell
  ollama pull qwen2.5:0.5b-instruct
  ollama pull qwen2.5:1.5b-instruct
  ```
- PowerShell allows local scripts: `Get-ExecutionPolicy -List` shows `RemoteSigned` for `CurrentUser`.
  If scripts are blocked, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Step 1: Warm the models

Ollama unloads every model when it restarts (reboot, update, quitting the tray app). A cold
model sends nothing until its weights are loaded, so the first demo request can stall, time
out and fail over to the other model. See "Cold start" in README.md.

```powershell
ollama ps
```

If both models are listed with UNTIL `Forever`, go to Step 2. Otherwise load and pin them
(a few seconds on this GPU):

```powershell
foreach ($m in "qwen2.5:0.5b-instruct", "qwen2.5:1.5b-instruct") { Invoke-RestMethod http://127.0.0.1:11434/api/generate -Method Post -ContentType application/json -Body (@{ model = $m; prompt = "hi"; stream = $false; keep_alive = -1 } | ConvertTo-Json) | Out-Null }
ollama ps
```

Expected:

```text
NAME                     ID              SIZE      PROCESSOR    CONTEXT    UNTIL
qwen2.5:1.5b-instruct    65ec06548149    1.2 GB    100% GPU     4096       Forever
qwen2.5:0.5b-instruct    a8b0c5157701    481 MB    100% GPU     4096       Forever
```

## Step 2: Start the gateway (Terminal 1)

```powershell
node services/gateway/src/main.ts --catalog config/catalog.ollama.json --port 8700
```

Ready when it prints:

```text
[chainaim-gateway] listening on http://127.0.0.1:8700  catalog=iter0-ollama-2026-09-21 models=2 strategy=rules ledger=data/ledger auth=off
```

Leave this terminal alone. Closing it or pressing Ctrl+C stops the gateway.

## Step 3: Check the gateway

In any other terminal in the repo root:

```powershell
.\scripts\demo.ps1 Deployments
```

Expected:

```text
id               model              healthy inFlight consecutiveFailures lastError
--               -----              ------- -------- ------------------- ---------
qwen-0.5b@ollama local/qwen2.5-0.5b    True        0                   0
qwen-1.5b@ollama local/qwen2.5-1.5b    True        0                   0
```

In VS Code, split the terminal (Ctrl+Shift+5) to keep the gateway visible next to the demo.
After `.\scripts\demo.ps1 `, press Tab to cycle through the commands.

## Step 4: Run the demo

Run one line at a time. The helpers send `temperature 0`, so answers are mostly repeatable:
short factual answers match word for word, but longer or creative ones (like the haiku) can
vary between runs. The outputs below are from a rehearsal; timings vary too.

1. **One OpenAI-compatible endpoint.** Clients pick `chainaim/auto`, `eco` or `premium`, or name a model.
   ```powershell
   Invoke-RestMethod http://127.0.0.1:8700/v1/models | Select-Object -ExpandProperty data | Format-Table id, kind
   ```
   You'll see the three routing profiles and the two models they route between:
   ```text
   id                 kind
   --                 ----
   chainaim/auto      routing-profile
   chainaim/eco       routing-profile
   chainaim/premium   routing-profile
   local/qwen2.5-0.5b model
   local/qwen2.5-1.5b model
   ```

2. **The routing decision, no model called.** The question gets tier `SIMPLE` (0.5B first); the
   proof gets `REASONING` (1.5B first).
   ```powershell
   .\scripts\demo.ps1 Explain chainaim/auto "What is the capital of France?"
   .\scripts\demo.ps1 Explain chainaim/auto "Prove that the sum of two odd integers is even, step by step."
   ```
   You'll see:
   ```text
   mode      : profile
   tier      : SIMPLE
   chain     : local/qwen2.5-0.5b -> local/qwen2.5-1.5b
   excluded  :
   reasoning : score=-0.10 | short (8 tokens), simple (what is, capital of)

   mode      : profile
   tier      : REASONING
   chain     : local/qwen2.5-1.5b -> local/qwen2.5-0.5b
   excluded  :
   reasoning : score=0.10 | short (16 tokens), reasoning (prove, step by step)
   ```
   How to read it:
   - `mode`: `profile` means the gateway picked the model, because you asked for `chainaim/auto`,
     `eco` or `premium`. `pinned` means you named a model yourself.
   - `tier`: how hard the prompt looks: SIMPLE, MEDIUM, COMPLEX or REASONING.
   - `chain`: the models in the order they'll be tried. The first is preferred; the rest are fallbacks.
   - `excluded`: models skipped because they're unhealthy right now. Empty when everything is up.
   - `reasoning`: why. The `score` sets the tier (below 0 SIMPLE, 0 to 0.3 MEDIUM, 0.3 to 0.5
     COMPLEX, 0.5 or more REASONING), followed by the prompt length and the keyword groups that
     matched. Two or more reasoning words, such as `prove` and `step by step`, force REASONING
     whatever the score, which is why the proof is REASONING at 0.10.
     `ambiguous -> default: MEDIUM` means the score was too close to a boundary to call.

3. **Real answers.** About 0.4 s on the 0.5B; the full proof takes about 2.4 s on the 1.5B.
   ```powershell
   .\scripts\demo.ps1 Ask chainaim/auto "What is the capital of France?"
   .\scripts\demo.ps1 Ask chainaim/auto "Prove that the sum of two odd integers is even, step by step." -MaxTokens 400
   ```
   You'll see:
   ```text
   served by local/qwen2.5-0.5b (qwen-0.5b@ollama)  tier=SIMPLE  attempts=1  413 ms
   The capital of France is Paris.

   served by local/qwen2.5-1.5b (qwen-1.5b@ollama)  tier=REASONING  attempts=1  2426 ms
   To prove that the sum of two odd integers is even, we can follow these steps:
   ...
   Thus, we have proven that the sum of two odd integers is even.
   ```
   How to read the cyan status line: `served by` names the model and deployment that answered
   (the `x-chainaim-model` and `x-chainaim-deployment` response headers). `tier` is empty when you
   name a model. `attempts=1` is normal; 2 or more means the first choice failed and the gateway
   fell back. The time is the full round trip, including generating the answer.

4. **Profiles: eco is cheaper, premium is more accurate.** `Versus` sends one prompt through
   `chainaim/eco` and then `chainaim/premium`, so both answers appear one after the other. On
   these four prompts the 0.5B (eco) was wrong and the 1.5B (premium) right on every rehearsal run.
   ```powershell
   .\scripts\demo.ps1 Versus "Mary is taller than Jane. Jane is taller than Sue. Who is the shortest?"
   .\scripts\demo.ps1 Versus "On what date did the Berlin Wall fall?"
   .\scripts\demo.ps1 Versus "A shirt costs 40 dollars and is discounted by 25%. What is the sale price? Answer with just the price."
   .\scripts\demo.ps1 Versus "A train leaves at 3:45 PM and the trip takes 2 hours and 35 minutes. What time does it arrive? Answer with just the time."
   ```
   You'll see:

   | Prompt | eco (0.5B) | premium (1.5B) | Correct |
   | --- | --- | --- | --- |
   | Who is the shortest? | "... Mary must be the shortest among the three." | "Sue is the shortest." | Sue |
   | Berlin Wall date | "The Berlin Wall fell on August 15, 1989. ..." | "The Berlin Wall fell on November 9, 1989." | 9 November 1989 |
   | 25% off 40 dollars | `20.` | `30` | 30 |
   | 3:45 PM plus 2 h 35 min | `15:15` | `6:20 PM` | 6:20 PM |

   The cyan lines confirm the routing: eco is `served by local/qwen2.5-0.5b`, premium is
   `served by local/qwen2.5-1.5b`, both `tier=SIMPLE`. The point to make: the caller trades cost
   for accuracy by changing one word in the model name. Don't read speed from these two lines:
   eco runs first and its time includes PowerShell's start-up cost, and the answers differ in length.

   Be ready for questions, because the 1.5B isn't always right either. For "Anna is 12 years old.
   Her father is 3 times her age. How old will her father be when Anna is 20? Answer with just the
   number." the 1.5B answers 40 and the 0.5B answers 44 (correct). Both answer "Friday" for 10 days
   after a Wednesday (it's Saturday). Run each prompt once before presenting: these answers were
   stable in rehearsal, but small models can vary between runs.

   Follow-up: ask the same question through `chainaim/auto` and you get the 0.5B's wrong answer,
   because auto rates a short prompt with no reasoning words as SIMPLE. Wording changes the route:
   ```powershell
   .\scripts\demo.ps1 Explain chainaim/auto "Mary is taller than Jane. Jane is taller than Sue. Who is the shortest?"
   .\scripts\demo.ps1 Explain chainaim/auto "Mary is taller than Jane. Jane is taller than Sue. Who is the shortest? Think step by step."
   ```
   The first is `SIMPLE` (0.5B first); the second is `MEDIUM` (1.5B first) because it matches
   `reasoning (step by step)`. If you then `Ask` the step-by-step version, the 1.5B concludes "Sue
   is the shortest" but explains that she "is taller than both Mary and Jane": the right answer
   with the wrong reasoning, which shows that a model's written reasoning isn't proof.

5. **Agent requests go to the stronger model.** The same prompt, without and with tools attached.
   ```powershell
   .\scripts\demo.ps1 Explain chainaim/auto "Cancel order B-42 and book the 9am flight to SFO."
   .\scripts\demo.ps1 Explain chainaim/auto "Cancel order B-42 and book the 9am flight to SFO." -Tools
   .\scripts\demo.ps1 Ask chainaim/auto "Cancel order B-42 and book the 9am flight to SFO." -Tools
   ```
   You'll see the chain change (only the lines that differ are shown), then two real tool calls:
   ```text
   chain     : local/qwen2.5-0.5b -> local/qwen2.5-1.5b
   reasoning : score=-0.08 | short (13 tokens)

   chain     : local/qwen2.5-1.5b
   reasoning : score=-0.08 | short (13 tokens) | agentic (tools)

   served by local/qwen2.5-1.5b (qwen-1.5b@ollama)  tier=SIMPLE  attempts=1  726 ms
   tool call: cancel_order {"order_id":"B-42"}
   tool call: book_flight {"destination":"SFO","departs":"9am"}
   ```
   With tools attached, the chain is the 1.5B alone, with no fallback to the 0.5B: an action such
   as cancelling an order is never downgraded to the weakest model.

6. **Streaming, pinning, unknown models.**
   ```powershell
   .\scripts\demo.ps1 Stream chainaim/auto "Write a haiku about a network router."
   .\scripts\demo.ps1 Ask local/qwen2.5-1.5b "What is 12 times 8?"
   .\scripts\demo.ps1 Ask openai/gpt-4o "hi"
   ```
   You'll see the haiku appear word by word (its wording can change between runs), then:
   ```text
   Network light shines,
   Router guides the digital flow,
   Silent, yet powerful.

   served by local/qwen2.5-1.5b (qwen-1.5b@ollama)  tier=  attempts=1  176 ms
   12 times 8 is 96.

   HTTP 404  {"error":{"message":"unknown model openai/gpt-4o","type":"invalid_request_error","code":404}}
   ```
   Naming a model skips routing, so `tier` is empty. An unknown model gets a 404: the gateway only
   ever calls models in its catalog.

7. **Decision ledger.**
   ```powershell
   .\scripts\demo.ps1 Ledger 5
   .\scripts\demo.ps1 Ledger -Full
   ```
   You'll see one row per request:
   ```text
   time     requestedModel     tier      served             attempts        status latencyMs
   ----     --------------     ----      ------             --------        ------ ---------
   12:49:30 chainaim/auto      REASONING local/qwen2.5-1.5b qwen2.5-1.5b ok    200      2386
   12:49:31 chainaim/eco       MEDIUM    local/qwen2.5-0.5b qwen2.5-0.5b ok    200       428
   12:49:32 chainaim/premium   MEDIUM    local/qwen2.5-1.5b qwen2.5-1.5b ok    200       735
   12:49:32 local/qwen2.5-1.5b           local/qwen2.5-1.5b qwen2.5-1.5b ok    200       139
   12:49:44 chainaim/auto      SIMPLE    local/qwen2.5-1.5b qwen2.5-1.5b ok    200       693
   ```
   How to read it: `requestedModel` is what the client asked for and `served` is the model that
   answered. `attempts` lists each try and its outcome (`ok`, `http_error`, `timeout`,
   `network_error`, `no_deployment` or `client_abort`); after a failover it reads
   `qwen2.5-0.5b http_error > qwen2.5-1.5b ok`. `latencyMs` is measured by the gateway.
   `Ledger -Full` prints the newest record with every field. It holds `promptChars`, the prompt's
   length, but never the prompt text. Requests rejected before routing, like the unknown model,
   aren't logged.

8. **Proof it holds.** Smoke runs 17 checks. The matrix sends 10 prompts to each of the three
   profiles (30 calls, about 8 s).
   ```powershell
   npm run smoke
   node scripts/iter0-matrix.ts --max-tokens 64
   ```
   You'll see `17 passed, 0 failed`, then one line per matrix call and the report paths:
   ```text
   200 simple-1  chainaim/auto        tier=SIMPLE -> local/qwen2.5-0.5b 190ms
   200 simple-1  chainaim/eco         tier=SIMPLE -> local/qwen2.5-0.5b 117ms
   200 simple-1  chainaim/premium     tier=SIMPLE -> local/qwen2.5-1.5b 190ms
   ...
   wrote eval\reports\iter0-<timestamp>.jsonl
   wrote eval\reports\iter0-<timestamp>.md
   ```
   The matrix writes that report into `eval\reports\` each run. For a practice run, add
   `--out "$env:TEMP\chainaim-eval"` to keep the repo clean.

Closing point: the `phi-1`, `pii-1` and `pci-1` rows in the matrix are routed like any other
prompt today. Detecting that kind of data is Iteration 1 (chainaim-sentinel and chainaim-vault,
see PROJECT_CONTEXT.md).

## Step 5: Failover lab (optional, about 2 minutes)

Under Ollama both models run in one process, so you can't fail just one. The stub servers
impersonate the two models on ports 8081 and 8082 and can be broken on command. They echo the
prompt back, so this shows routing and failover, not answer quality. Keep the main gateway
running; the lab uses a second gateway on port 8701, so its commands add `-Gateway`.

**Terminal 3:**

```powershell
npm run stub-models
```

**Terminal 4:** the lab gateway, with health checks every 2 s so changes show quickly.

```powershell
node services/gateway/src/main.ts --catalog config/catalog.json --port 8701 --health-interval-ms 2000
```

**Demo terminal:**

```powershell
# 1. The 0.5B stub answers.
.\scripts\demo.ps1 Ask chainaim/auto "What is the capital of France?" -Gateway http://127.0.0.1:8701
# 2. Break the 0.5B and ask again: the 1.5B answers with attempts=2.
Invoke-RestMethod "http://127.0.0.1:8081/admin/mode?m=fail500"
.\scripts\demo.ps1 Ask chainaim/auto "What is the capital of France?" -Gateway http://127.0.0.1:8701
# 3. The health check takes the 0.5B out: False, health HTTP 503, and excluded from routing.
Start-Sleep 3; .\scripts\demo.ps1 Deployments -Gateway http://127.0.0.1:8701
.\scripts\demo.ps1 Explain chainaim/auto "What is the capital of France?" -Gateway http://127.0.0.1:8701
# 4. Heal it: back to True within a few seconds.
Invoke-RestMethod "http://127.0.0.1:8081/admin/mode?m=ok"
Start-Sleep 3; .\scripts\demo.ps1 Deployments -Gateway http://127.0.0.1:8701
# 5. The ledger recorded the failover: qwen2.5-0.5b http_error > qwen2.5-1.5b ok
.\scripts\demo.ps1 Ledger 4
```

The client never sees the failure: the gateway retries on the next model in the chain, then
stops sending traffic to the broken one until a health check passes. `?m=slow` adds 3 s per
request. Stop Terminals 3 and 4 with Ctrl+C when you're done.

## Step 6: Shut down

- Ctrl+C in Terminal 1 (and Terminals 3 and 4 if you used them).
- Optional, to free about 1.7 GB of GPU memory. Step 1 loads the models again next time.
  ```powershell
  ollama stop qwen2.5:0.5b-instruct
  ollama stop qwen2.5:1.5b-instruct
  ```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `The term '.\scripts\demo.ps1' is not recognized` | The terminal isn't in the repo root | `cd` to the repo root |
| `The term 'Explain' is not recognized` (or `Ask`, `Deployments`) | The `.\scripts\demo.ps1` prefix is missing | Add it: `.\scripts\demo.ps1 Explain ...` |
| `no response from http://127.0.0.1:8700 (Unable to connect to the remote server)` or `no gateway at ...` | The gateway isn't running; its terminal was probably closed | Step 2 |
| `{"error":{"message":"no route for GET /",...}}`, for example after VS Code's "Open in Browser" | Nothing is wrong: the gateway is an API with no page at `/` | Open `http://127.0.0.1:8700/healthz` (shows `{"status":"ok"}`) or `/v1/models` instead |
| The gateway exits with `EADDRINUSE: address already in use 127.0.0.1:8700` | Another gateway already has the port, often in a forgotten terminal | Use that one, or find it with `Get-NetTCPConnection -LocalPort 8700 -State Listen` and run `Stop-Process -Id <OwningProcess>` |
| The first answer is slow, shows `attempts=2`, or comes from the other model | The models were cold | Step 1 |
| `ollama ps` can't connect | Ollama isn't running | Start Ollama from the Start menu, then Step 1 |
| `running scripts is disabled on this system` | The execution policy blocks local scripts | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `Cannot validate argument on parameter 'Command'` | The command name is misspelled | Use Explain, Ask, Stream, Versus, Deployments or Ledger (Tab completes them) |
| `npm run stub-models` exits with `EADDRINUSE` | Something already uses port 8081 or 8082, such as llama.cpp started by `serve-local-models.ps1` | `.\scripts\serve-local-models.ps1 -Stop`, or close that terminal |
| Garbled characters such as `Â²`, or `request body is not valid JSON` from a hand-typed `curl.exe` | Windows PowerShell 5.1 mis-decodes UTF-8 and mangles JSON arguments and piped input | Use the helpers, which handle both (see the comment at the top of `scripts/demo.ps1`) |

## Known issues (as of 2026-09-22)

Delete each line once it's fixed.

- `--cooldown-ms` has no effect. A failed deployment comes back only when a health check
  passes, and with `--health-interval-ms 0` it never comes back until the gateway restarts.

## Reference

- `.\scripts\demo.ps1 <Command> [arguments] [-Gateway URL]`, targeting `http://127.0.0.1:8700` by default:
  - `Explain <model> "<prompt>" [-Tools]`: the routing decision only
  - `Ask <model> "<prompt>" [-MaxTokens N] [-Tools]`: a routed answer
  - `Stream <model> "<prompt>" [-MaxTokens N]`: a streamed answer
  - `Versus "<prompt>" [-MaxTokens N]`: the same prompt through `chainaim/eco`, then `chainaim/premium`
  - `Deployments`: deployment health
  - `Ledger [N] [-Full]`: the newest N ledger lines (default 5), or the newest line in full
- `.\scripts\demo.ps1` with no command loads the helpers into the current terminal, so the
  short forms (`Explain ...`, `Ask ...`) work there until it's closed.
- Endpoints, response headers and model names: README.md.
- Every gateway flag and its default: `node services/gateway/src/main.ts --help`.
