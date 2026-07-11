param(
  [string]$BeadsDir,
  [string]$Out = './orchestration-data.js',
  [switch]$NoBdEnrich
)

function Show-Usage {
  @'
Usage:
  powershell -NoProfile -File scripts/refresh.ps1 [-BeadsDir <path>] [-Out <path>] [-NoBdEnrich]

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

function Test-ReparsePointPath {
  param([string]$PathValue)
  if (-not (Test-Path -LiteralPath $PathValue)) {
    return $false
  }
  $item = Get-Item -LiteralPath $PathValue -Force
  return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-ReparsePointAncestors {
  param([string]$PathValue)
  $current = Split-Path -Path $PathValue -Parent
  while (-not [string]::IsNullOrEmpty($current)) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        return $true
      }
    }
    $parent = Split-Path -Path $current -Parent
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) {
      break
    }
    $current = $parent
  }
  return $false
}

function Assert-SafeWriteTarget {
  param([string]$PathValue)
  if (Test-ReparsePointPath $PathValue -or Test-ReparsePointAncestors $PathValue) {
    throw "refusing to write through a reparse point: $PathValue"
  }
}

function JsonString {
  param([string]$Value)
  return ($Value | ConvertTo-Json -Compress)
}

function Strip-LeadBom {
  param([string]$Value)
  if ($null -eq $Value -or $Value.Length -eq 0) {
    return $Value
  }
  if ($Value[0] -eq [char]0xFEFF) {
    return $Value.Substring(1)
  }
  return $Value
}

function Read-Utf8Text {
  param([string]$PathValue)
  return (Strip-LeadBom (Get-Content -LiteralPath $PathValue -Encoding UTF8 -Raw))
}

function Sanitize-MemoryValue {
  param([string]$Value)
  $text = [string]$Value
  $text = [regex]::Replace($text, '(?i)\b((?:api[_-]?key|bearer|token|password)\b\s*[:=]\s*)\S+', '$1***REDACTED***')
  $text = [regex]::Replace($text, '(?i)\b((?:api[_-]?key|bearer|token|password)\b\s+)\S+', '$1***REDACTED***')
  if ($text.Length -gt 2000) {
    $text = $text.Substring(0, 2000)
  }
  return $text
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
$tempPath = $outPath + '.tmp'
Assert-SafeWriteTarget $outPath
Assert-SafeWriteTarget $tempPath

if (($outPath -match '(^|[\\/])\.git([\\/]|$)') -or ($tempPath -match '(^|[\\/])\.git([\\/]|$)')) {
  [Console]::Error.WriteLine((Show-Usage))
  [Console]::Error.WriteLine('error: refusing to write inside a .git directory')
  exit 1
}

$outDir = Split-Path -Path $outPath -Parent
if (-not [string]::IsNullOrEmpty($outDir) -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$generatedAt = (Get-Date).ToUniversalTime().ToString('o')
$sourceJson = JsonString $issuesPath
$generatedJson = JsonString $generatedAt
$issuesJsonlJson = JsonString (Read-Utf8Text $issuesPath)

$orchestratorJson = $null
if (-not $NoBdEnrich -and (Get-Command bd -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine('warning: bd memory enrichment is included in this publishable snapshot; use -NoBdEnrich to disable it')
  try {
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
          $safeValue = Sanitize-MemoryValue $valueText
          $pairs.Add(('{0}:{1}' -f (JsonString $key), (JsonString $safeValue)))
        }
      }

      if ($pairs.Count -gt 0) {
        $orchestratorJson = '{' + [string]::Join(',', $pairs) + '}'
      }
    }
  } catch {
    $orchestratorJson = $null
  }
}

$snapshot = 'window.BMC_SNAPSHOT = {"generated_at":' + $generatedJson + ',"source":' + $sourceJson + ',"issues_jsonl":' + $issuesJsonlJson
if (-not [string]::IsNullOrEmpty($orchestratorJson)) {
  $snapshot += ',"orchestrator":' + $orchestratorJson
}
$snapshot += '};'

$metaPath = Join-Path (Split-Path -Path $outPath -Parent) 'orchestration.meta.json'
$outputParts = New-Object System.Collections.Generic.List[string]
$outputParts.Add($snapshot)
if (Test-Path -LiteralPath $metaPath) {
  $metaText = Read-Utf8Text $metaPath
  $outputParts.Add('window.BMC_META_JSON = ' + (JsonString $metaText) + ';')
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($tempPath, [string]::Join("`n", $outputParts), $utf8NoBom)
Move-Item -LiteralPath $tempPath -Destination $outPath -Force
