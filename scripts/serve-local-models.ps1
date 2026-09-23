<#
  Start the local model servers on Windows (llama.cpp llama-server, OpenAI-compatible).
  Defaults match config/catalog.json.

  Examples:
    .\scripts\serve-local-models.ps1 -LlamaServer C:\tools\llama\llama-server.exe -ModelsDir .\models
    .\scripts\serve-local-models.ps1 -Stop

  Using Ollama instead? You do not need this script: run `ollama serve`
  and start the gateway with -Catalog config/catalog.ollama.json.
#>
[CmdletBinding()]
param(
  [string]$LlamaServer = "llama-server.exe",
  [string]$ModelsDir  = "models",
  [int]   $Threads    = 4,
  [int]   $Ctx        = 4096,
  [string]$BindHost   = "127.0.0.1",
  [string]$LogDir     = "data/model-logs",
  [switch]$Stop
)

$ErrorActionPreference = "Stop"

$servers = @(
  @{ Name = "qwen2.5-0.5b"; Port = 8081; File = "qwen2.5-0.5b-instruct-q4_k_m.gguf" },
  @{ Name = "qwen2.5-1.5b"; Port = 8082; File = "qwen2.5-1.5b-instruct-q4_k_m.gguf" }
)

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

foreach ($s in $servers) {
  $pidFile = Join-Path $LogDir "$($s.Name).pid"
  $running = $null
  if (Test-Path $pidFile) {
    $existing = Get-Content $pidFile | Select-Object -First 1
    $running  = Get-Process -Id $existing -ErrorAction SilentlyContinue
  }

  if ($Stop) {
    if ($running) {
      Stop-Process -Id $running.Id -Force
      Remove-Item $pidFile -Force
      Write-Host "stopped $($s.Name)"
    }
    continue
  }

  if ($running) { Write-Host "$($s.Name) already running (pid $($running.Id))"; continue }

  $model = Join-Path $ModelsDir $s.File
  if (-not (Test-Path $model)) { throw "missing model file: $model" }

  $modelArgs = @("-m", $model, "--alias", $s.Name, "--host", $BindHost, "--port", $s.Port,
                 "-c", $Ctx, "-t", $Threads, "-np", 1)
  $proc = Start-Process -FilePath $LlamaServer -ArgumentList $modelArgs -PassThru -NoNewWindow `
            -RedirectStandardOutput (Join-Path $LogDir "$($s.Name).log") `
            -RedirectStandardError  (Join-Path $LogDir "$($s.Name).err.log")
  $proc.Id | Out-File -Encoding ascii $pidFile
  Write-Host "started $($s.Name) on $BindHost`:$($s.Port) (pid $($proc.Id))"
}
