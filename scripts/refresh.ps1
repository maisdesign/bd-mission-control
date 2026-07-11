param(
  [string]$BeadsDir,
  [string]$Out = './orchestration-data.js'
)

function Show-Usage {
  @'
Usage:
  powershell -NoProfile -File scripts/refresh.ps1 [-BeadsDir <path>] [-Out <path>]

Behavior:
  - Finds .beads/issues.jsonl by explicit -BeadsDir or by walking up from cwd.
  - Writes a UTF-8 no-BOM orchestration-data.js snapshot to -Out.
'@
}

function Resolve-AbsolutePath {
  param([string]$PathValue)
  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return [System.IO.Path]::GetFullPath($PathValue)
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $PathValue))
}

function Find-IssuesPathFromBeadsDir {
  param([string]$DirValue)
  $dir = Resolve-AbsolutePath $DirValue
  $direct = Join-Path $dir 'issues.jsonl'
  if (Test-Path -LiteralPath $direct) {
    return $direct
  }
  $nested = Join-Path (Join-Path $dir '.beads') 'issues.jsonl'
  if (Test-Path -LiteralPath $nested) {
    return $nested
  }
  return $null
}

function Find-IssuesPathUpward {
  $current = Resolve-AbsolutePath (Get-Location).Path
  while ($true) {
    $candidate = Join-Path (Join-Path $current '.beads') 'issues.jsonl'
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
    $parent = Split-Path -Path $current -Parent
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) {
      break
    }
    $current = $parent
  }
  return $null
}

function Test-InGitDirectory {
  param([string]$AbsolutePath)
  $current = Split-Path -Path $AbsolutePath -Parent
  while (-not [string]::IsNullOrEmpty($current)) {
    if ((Split-Path -Path $current -Leaf) -eq '.git') {
      return $true
    }
    $parent = Split-Path -Path $current -Parent
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) {
      break
    }
    $current = $parent
  }
  return $false
}

function JsonString {
  param([string]$Value)
  return ($Value | ConvertTo-Json -Compress)
}

$issuesPath = $null
if (-not [string]::IsNullOrEmpty($BeadsDir)) {
  $issuesPath = Find-IssuesPathFromBeadsDir $BeadsDir
} else {
  $issuesPath = Find-IssuesPathUpward
}

if ([string]::IsNullOrEmpty($issuesPath)) {
  [Console]::Error.WriteLine((Show-Usage))
  [Console]::Error.WriteLine('error: could not find .beads/issues.jsonl')
  exit 1
}

$outPath = Resolve-AbsolutePath $Out
if (Test-InGitDirectory $outPath) {
  [Console]::Error.WriteLine((Show-Usage))
  [Console]::Error.WriteLine('error: refusing to write inside a .git directory')
  exit 1
}

$outDir = Split-Path -Path $outPath -Parent
if (-not [string]::IsNullOrEmpty($outDir) -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$issues = New-Object System.Collections.Generic.List[string]
$skipped = 0
foreach ($line in Get-Content -LiteralPath $issuesPath) {
  $trimmed = $line.TrimEnd([char]13)
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    $skipped++
    continue
  }
  if ($trimmed.StartsWith('{') -and $trimmed.EndsWith('}')) {
    $issues.Add($trimmed)
    continue
  }
  $skipped++
}

if ($skipped -gt 0) {
  [Console]::Error.WriteLine(('Skipped {0} corrupt/blank lines from {1}' -f $skipped, $issuesPath))
}

$generatedAt = (Get-Date).ToUniversalTime().ToString('o')
$sourceJson = JsonString $issuesPath
$generatedJson = JsonString $generatedAt
$issuesJson = [string]::Join(',', $issues)

$orchestratorJson = $null
try {
  if (Get-Command bd -ErrorAction SilentlyContinue) {
    $listing = & bd memories 2>$null
    if ($LASTEXITCODE -eq 0) {
      $keys = New-Object System.Collections.Generic.List[string]
      foreach ($entry in @($listing)) {
        if ($entry -match '^  (\S.*)$') {
          $keys.Add($Matches[1].Trim())
        }
      }

      $pairs = New-Object System.Collections.Generic.List[string]
      foreach ($key in $keys) {
        if ($key.StartsWith('orchestrator-lock') -or $key.StartsWith('handoff') -or $key.StartsWith('attempts-')) {
          $value = & bd recall $key 2>$null
          if ($LASTEXITCODE -ne 0) {
            throw 'bd recall failed'
          }
          $valueText = [string]::Join("`n", @($value))
          $pairs.Add(('"{0}":{1}' -f (JsonString $key).Trim('"'), (JsonString $valueText)))
        }
      }

      if ($pairs.Count -gt 0) {
        $orchestratorJson = '{' + [string]::Join(',', $pairs) + '}'
      }
    }
  }
} catch {
  $orchestratorJson = $null
}

$snapshot = 'window.BMC_SNAPSHOT = {"generated_at":' + $generatedJson + ',"source":' + $sourceJson + ',"issues":[' + $issuesJson + ']'
if (-not [string]::IsNullOrEmpty($orchestratorJson)) {
  $snapshot += ',"orchestrator":' + $orchestratorJson
}
$snapshot += '};'

$metaPath = Join-Path (Split-Path -Path $outPath -Parent) 'orchestration.meta.json'
$outputParts = New-Object System.Collections.Generic.List[string]
$outputParts.Add($snapshot)
if (Test-Path -LiteralPath $metaPath) {
  $metaText = Get-Content -LiteralPath $metaPath -Raw
  $outputParts.Add('window.BMC_META = ' + $metaText + ';')
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($outPath, [string]::Join("`n", $outputParts), $utf8NoBom)
