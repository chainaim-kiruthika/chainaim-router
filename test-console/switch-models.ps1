<#
Switches the local test gateway (container ca-gateway) between the stand-in
model, which echoes, and OpenRouter's real free models.

  switch-models.ps1 real   asks for your OpenRouter API key in a hidden prompt
                           (or uses OPENROUTER_API_KEY if it is already set)
  switch-models.ps1 stub   back to the stand-in; the key is removed again

The key is never written to a file. While real models are on, Docker keeps it
in the gateway container's settings on this PC.
#>
param([Parameter(Mandatory = $true)][ValidateSet("real", "stub")][string]$To)
$ErrorActionPreference = "Stop"

$env:CHAINAIM_GATEWAY_KEY = (Get-Content -Raw "$PSScriptRoot\local-gateway-key.txt").Trim()
$envArgs = @("-e", "CHAINAIM_GATEWAY_KEY")
$flags = @("--host", "::", "--port", "8700", "--api-key-env", "CHAINAIM_GATEWAY_KEY", "--model-source", "openrouter-free",
  "--presidio-url", "http://presidio.railway.internal:3000", "--ledger", "/data/ledger")

if ($To -eq "real") {
  if ($env:OPENROUTER_API_KEY) {
    Write-Host "Using OPENROUTER_API_KEY from your environment."
  } else {
    $secure = Read-Host "Paste your OpenRouter API key and press Enter (it stays hidden)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $env:OPENROUTER_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
  if (-not $env:OPENROUTER_API_KEY) { throw "No key entered, so nothing changed." }
  $envArgs += @("-e", "OPENROUTER_API_KEY")
  # Free models are often rate-limited or slow, and some are gated. For this local demo, let a failing model sit out for
  # 5 minutes and let one request try up to 5 models, so it reaches one that works. The production image keeps its defaults.
  $flags += @("--cooldown-ms", "300000", "--max-attempts", "5")
} else {
  $env:OR_DUMMY = "sk-or-dummy"
  $envArgs += @("-e", "OR_DUMMY")
  $flags += @("--openrouter-base-url", "http://openrouter-stub:5003", "--openrouter-key-env", "OR_DUMMY")
}

docker rm -f ca-gateway | Out-Null
docker run -d --name ca-gateway --network chainaim-test --network-alias gateway.railway.internal `
  -p 127.0.0.1:8720:8700 -v chainaim-test-ledger:/data @envArgs chainaim-gateway:test @flags | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker run failed; see the message above." }

Write-Host "Waiting for the gateway..."
$ready = $false
for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
  if ((docker inspect -f "{{.State.Running}}" ca-gateway) -ne "true") { docker logs --tail 20 ca-gateway; throw "The gateway stopped." }
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8720/healthz | Out-Null; $ready = $true }
  catch { Start-Sleep -Seconds 2 }
}
if (-not $ready) { docker logs --tail 20 ca-gateway; throw "The gateway is not answering." }

Write-Host "Test question: What is the capital of India?"
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:8720/v1/chat/completions -TimeoutSec 90 `
    -Headers @{ authorization = "Bearer $env:CHAINAIM_GATEWAY_KEY" } -ContentType "application/json" `
    -Body '{"messages":[{"role":"user","content":"What is the capital of India?"}]}'
  $model = $r.Headers.Keys | Where-Object { $_ -ieq "x-chainaim-model" } | ForEach-Object { $r.Headers[$_] }
  Write-Host ("Answer from " + $model + ": " + ($r.Content | ConvertFrom-Json).choices[0].message.content)
} catch {
  $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
  Write-Host "The test question failed: $detail"
  if ($To -eq "real") { Write-Host "Check the key, or run use-stand-in.cmd to go back." }
  exit 1
}
if ($To -eq "real") { Write-Host "Real models are on. Ask in the console at http://127.0.0.1:8730/ (section 2)." }
else { Write-Host "The stand-in model is back on." }
