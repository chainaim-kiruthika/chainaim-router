<#
  Demo helpers for a running chainaim-gateway (Windows PowerShell 5.1 or 7).
  Run from the repo root. Every line is self-contained, so it works in any
  terminal without loading anything first:

    .\scripts\demo.ps1 Deployments                                             # per-deployment health
    .\scripts\demo.ps1 Explain chainaim/auto "What is the capital of France?"  # decision only; no model is called
    .\scripts\demo.ps1 Ask chainaim/auto "What is the capital of France?"      # routed answer + x-chainaim-* headers
    .\scripts\demo.ps1 Ask chainaim/auto "Cancel order B-42." -Tools           # tool-bearing (agentic) turn
    .\scripts\demo.ps1 Ask chainaim/auto "Prove it step by step." -MaxTokens 400
    .\scripts\demo.ps1 Stream chainaim/auto "Write a haiku about a network router."
    .\scripts\demo.ps1 Versus "Who is the shortest?"                         # same prompt via eco, then premium
    .\scripts\demo.ps1 Ledger 5                                                # newest decision-ledger lines
    .\scripts\demo.ps1 Ledger -Full                                            # newest line, every field

  Commands target http://127.0.0.1:8700; add -Gateway URL for another gateway.
  Run with no command to load the helpers into the current terminal instead;
  after that the short forms (Explain, Ask, Stream, Deployments, Ledger) work
  there until the terminal is closed.

  Why the plumbing: Windows PowerShell 5.1 splits native-command arguments that
  contain \" at spaces, prefixes piped stdin with a UTF-8 BOM (the gateway
  rejects it as invalid JSON) and decodes charset-less JSON as ISO-8859-1.
  So bodies are sent as bytes or via a BOM-less temp file, and responses are
  decoded as UTF-8 explicitly.
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet("Explain", "Ask", "Stream", "Versus", "Deployments", "Ledger")]
  [string]$Command,
  [Parameter(Position = 1)] [string]$Model,   # for Ledger: how many lines; for Versus: the prompt
  [Parameter(Position = 2)] [string]$Prompt,
  [int]$MaxTokens = 256,
  [switch]$Tools,
  [switch]$Full,
  [string]$Gateway = "http://127.0.0.1:8700"
)

$global:ChainaimGateway = $Gateway.TrimEnd("/")

$global:ChainaimDemoTools = @(
  @{ type = "function"; "function" = @{ name = "cancel_order"; description = "Cancel a customer order"
     parameters = @{ type = "object"; properties = @{ order_id = @{ type = "string" } }; required = @("order_id") } } },
  @{ type = "function"; "function" = @{ name = "book_flight"; description = "Book a flight"
     parameters = @{ type = "object"; properties = @{ destination = @{ type = "string" }; departs = @{ type = "string" } }; required = @("destination") } } }
)

function global:New-ChainaimBody([string]$Model, [string]$Prompt, [int]$MaxTokens, [switch]$Tools, [switch]$Stream) {
  # temperature 0: the answer you rehearse is the answer you get on stage
  $body = @{ model = $Model; temperature = 0; max_tokens = $MaxTokens; messages = @(@{ role = "user"; content = $Prompt }) }
  if ($Tools) { $body.tools = $global:ChainaimDemoTools }
  if ($Stream) { $body.stream = $true }
  $body | ConvertTo-Json -Depth 10 -Compress
}

function global:Invoke-Chainaim([string]$Path, [string]$Json) {
  try {
    $r = Invoke-WebRequest "$global:ChainaimGateway$Path" -Method Post -UseBasicParsing `
      -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($Json))
  } catch {
    if ($_.Exception.Response) { Write-Host "HTTP $([int]$_.Exception.Response.StatusCode)  $($_.ErrorDetails.Message)" -ForegroundColor Yellow }
    else { Write-Host "no response from $global:ChainaimGateway ($($_.Exception.Message))" -ForegroundColor Yellow }
    return
  }
  [pscustomobject]@{ Headers = $r.Headers; Body = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json }
}

function global:Explain([string]$Model, [string]$Prompt, [switch]$Tools) {
  $r = Invoke-Chainaim "/v1/route/explain" (New-ChainaimBody $Model $Prompt 256 -Tools:$Tools)
  if (-not $r) { return }
  $d = $r.Body.decision
  [pscustomobject]@{ mode = $d.mode; tier = $d.tier; chain = $d.chain -join " -> "; excluded = $d.excluded -join ", "; reasoning = $d.reasoning } | Format-List
}

function global:Ask([string]$Model, [string]$Prompt, [int]$MaxTokens = 256, [switch]$Tools) {
  $t = [Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-Chainaim "/v1/chat/completions" (New-ChainaimBody $Model $Prompt $MaxTokens -Tools:$Tools)
  if (-not $r) { return }
  Write-Host ("served by {0} ({1})  tier={2}  attempts={3}  {4} ms" -f $r.Headers["x-chainaim-model"], $r.Headers["x-chainaim-deployment"],
    $r.Headers["x-chainaim-tier"], $r.Headers["x-chainaim-attempts"], $t.ElapsedMilliseconds) -ForegroundColor Cyan
  $m = $r.Body.choices[0].message
  if ($m.tool_calls) { $m.tool_calls | ForEach-Object { "tool call: $($_.function.name) $($_.function.arguments)" } } else { $m.content }
}

function global:Stream([string]$Model, [string]$Prompt, [int]$MaxTokens = 256) {
  $file = Join-Path $env:TEMP "chainaim-demo-body.json"
  [IO.File]::WriteAllText($file, (New-ChainaimBody $Model $Prompt $MaxTokens -Stream))  # UTF-8, no BOM
  $enc = [Console]::OutputEncoding
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  try {
    curl.exe -sN "$global:ChainaimGateway/v1/chat/completions" -H "content-type: application/json" --data-binary "@$file" | ForEach-Object {
      if ($_ -like "data: {*") { Write-Host -NoNewline ($_.Substring(6) | ConvertFrom-Json).choices[0].delta.content }
      elseif ($_ -like "{*") { Write-Host $_ -ForegroundColor Yellow }  # gateway error body
    }
    Write-Host ""
  } finally { [Console]::OutputEncoding = $enc }
}

# Named Versus, not Compare: "compare" is a built-in alias for Compare-Object and aliases win.
function global:Versus([string]$Prompt, [int]$MaxTokens = 256) {
  foreach ($target in "chainaim/eco", "chainaim/premium") {
    Write-Host ""
    Write-Host "== $target" -ForegroundColor White
    Ask $target $Prompt -MaxTokens $MaxTokens
  }
}

function global:Deployments {
  try {
    (Invoke-RestMethod "$global:ChainaimGateway/v1/deployments").deployments |
      Format-Table -AutoSize id, model, healthy, inFlight, consecutiveFailures, lastError
  } catch {
    Write-Host "no gateway at $global:ChainaimGateway ($($_.Exception.Message))" -ForegroundColor Yellow
  }
}

function global:Ledger([int]$Last = 5, [switch]$Full, [string]$Dir = "data\ledger") {
  $file = Get-ChildItem (Join-Path $Dir "*.jsonl") -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $file) { Write-Host "no ledger files in $Dir (run from the repo root)" -ForegroundColor Yellow; return }
  $rows = Get-Content $file.FullName -Tail $Last -Encoding UTF8 | ConvertFrom-Json
  if ($Full) { return $rows | Select-Object -Last 1 | ConvertTo-Json -Depth 10 }
  $rows | Format-Table -AutoSize @{ n = "time"; e = { ([datetime]$_.ts).ToString("HH:mm:ss") } }, requestedModel,
    @{ n = "tier"; e = { $_.decision.tier } }, @{ n = "served"; e = { $_.served.model } },
    @{ n = "attempts"; e = { ($_.attempts | ForEach-Object { "$(($_.model -split '/')[-1]) $($_.outcome)" }) -join " > " } }, status, latencyMs
}

switch ($Command) {
  "Explain"     { Explain $Model $Prompt -Tools:$Tools }
  "Ask"         { Ask $Model $Prompt -MaxTokens $MaxTokens -Tools:$Tools }
  "Stream"      { Stream $Model $Prompt -MaxTokens $MaxTokens }
  "Versus"      { Versus $(if ($Prompt) { $Prompt } else { $Model }) -MaxTokens $MaxTokens }
  "Deployments" { Deployments }
  "Ledger"      { Ledger -Last $(if ($Model) { [int]$Model } else { 5 }) -Full:$Full }
  default       { Write-Host "chainaim demo helpers -> $global:ChainaimGateway   (Explain, Ask, Stream, Versus, Deployments, Ledger)" -ForegroundColor Green }
}
