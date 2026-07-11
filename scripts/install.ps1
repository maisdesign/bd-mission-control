param(
  [Parameter(Mandatory = $true)]
  [string]$Target,
  [string]$Dir = 'docs',
  [switch]$Update,
  [switch]$Force
)

function Show-Usage {
  @'
Usage:
  powershell -NoProfile -File scripts/install.ps1 -Target <project-root> [-Dir <subdir>] [-Update] [-Force]

Behavior:
  - Vendors dist/orchestration.html into the target project.
  - Copies scripts/refresh.ps1 and scripts/refresh.sh into target/scripts/.
  - Creates orchestration.config.js only when it does not already exist.
  - -Update replaces the panel and refresh scripts.
  - -Force is dangerous: it warns loudly before overwriting a locally modified panel.
'@
}

function Resolve-ExistingPath {
  param([string]$PathValue)
  $resolved = Resolve-Path -LiteralPath $PathValue -ErrorAction Stop
  return $resolved.Path
}

function Get-ExistingItem {
  param([string]$PathValue)
  return (Get-Item -LiteralPath $PathValue -Force -ErrorAction SilentlyContinue)
}

function Normalize-AbsolutePath {
  param([string]$PathValue)
  return [System.IO.Path]::GetFullPath($PathValue)
}

function Normalize-PathPrefix {
  param([string]$PathValue)
  $full = Normalize-AbsolutePath $PathValue
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full.Length -le $root.Length) {
    return $full
  }
  return $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Test-PathInsideRoot {
  param(
    [string]$PathValue,
    [string]$RootValue
  )

  $root = Normalize-PathPrefix $RootValue
  $path = Normalize-PathPrefix $PathValue
  if ($path.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }

  return $path.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-ReparsePointPath {
  param([string]$PathValue)
  $item = Get-ExistingItem $PathValue
  if ($null -eq $item) {
    return $false
  }

  return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-ReparsePointAncestors {
  param([string]$PathValue)
  $current = Split-Path -Path $PathValue -Parent
  while (-not [string]::IsNullOrEmpty($current)) {
    $item = Get-ExistingItem $current
    if ($null -ne $item) {
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

function Assert-NoTraversal {
  param([string]$RelativePath)
  if ([System.IO.Path]::IsPathRooted($RelativePath)) {
    throw "refusing rooted -Dir value: $RelativePath"
  }
  if ($RelativePath -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "refusing path traversal in -Dir: $RelativePath"
  }
}

function Assert-PathSegments {
  param([string]$PathValue)
  if ($PathValue -match '(^|[\\/])\.git([\\/]|$)') {
    throw "refusing to write inside a .git directory: $PathValue"
  }
}

function Assert-SafeWritePath {
  param([string]$PathValue)
  Assert-PathSegments $PathValue
  if ((Test-ReparsePointPath $PathValue) -or (Test-ReparsePointAncestors $PathValue)) {
    throw "refusing to write through a reparse point: $PathValue"
  }
}

function Assert-PathInsideTarget {
  param([string]$PathValue)
  if (-not (Test-PathInsideRoot $PathValue $script:TargetRoot)) {
    throw "refusing to write outside target root: $PathValue"
  }
}

function Read-Utf8Text {
  param([string]$PathValue)
  return (Get-Content -LiteralPath $PathValue -Encoding UTF8 -Raw)
}

function Read-Bytes {
  param([string]$PathValue)
  return [System.IO.File]::ReadAllBytes($PathValue)
}

function Write-BytesAtomic {
  param(
    [string]$SourcePath,
    [string]$DestinationPath
  )

  $destinationDir = Split-Path -Path $DestinationPath -Parent
  if (-not [string]::IsNullOrEmpty($destinationDir) -and -not (Get-ExistingItem $destinationDir)) {
    [System.IO.Directory]::CreateDirectory($destinationDir) | Out-Null
  }

  Assert-SafeWritePath $DestinationPath
  Assert-PathInsideTarget $DestinationPath

  $tempPath = $DestinationPath + '.' + [System.IO.Path]::GetRandomFileName() + '.tmp'
  Assert-SafeWritePath $tempPath
  Assert-PathInsideTarget $tempPath

  $bytes = Read-Bytes $SourcePath
  $stream = $null
  try {
    $stream = New-Object System.IO.FileStream($tempPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    $stream.Write($bytes, 0, $bytes.Length)
  } finally {
    if ($null -ne $stream) {
      $stream.Dispose()
    }
  }

  Move-Item -LiteralPath $tempPath -Destination $DestinationPath -Force
}

function Write-VendoredCopy {
  param(
    [string]$SourcePath,
    [string]$DestinationPath,
    [string]$ItemLabel,
    [switch]$Update,
    [switch]$Force
  )

  $existingItem = Get-ExistingItem $DestinationPath
  if ($null -ne $existingItem) {
    Assert-SafeWritePath $DestinationPath
    Assert-PathInsideTarget $DestinationPath
    $sameBytes = Compare-Bytes $SourcePath $DestinationPath
    if (-not $sameBytes -and -not ($Update -or $Force)) {
      [Console]::Error.WriteLine((Show-Usage))
      [Console]::Error.WriteLine(("error: existing {0} differs from source: {1}" -f $ItemLabel, $DestinationPath))
      [Console]::Error.WriteLine('hint: rerun with -Update to replace the panel and refresh scripts')
      throw ("refusing to overwrite locally modified {0}: {1}" -f $ItemLabel, $DestinationPath)
    }
    if ($Force -and -not $sameBytes) {
      [Console]::Error.WriteLine(("WARNING: -Force is overwriting a locally modified {0}: {1}" -f $ItemLabel, $DestinationPath))
    }
  }

  Write-BytesAtomic $SourcePath $DestinationPath
}

function Ensure-DirectoryPath {
  param(
    [string]$RootPath,
    [string]$RelativePath
  )

  $current = Normalize-AbsolutePath $RootPath
  if ([string]::IsNullOrWhiteSpace($RelativePath) -or $RelativePath -eq '.') {
    Assert-SafeWritePath $current
    Assert-PathInsideTarget $current
    return $current
  }

  $parts = $RelativePath -split '[\\/]+'
  foreach ($part in $parts) {
    if ([string]::IsNullOrEmpty($part) -or $part -eq '.') {
      continue
    }
    if ($part -eq '..') {
      throw "refusing path traversal in -Dir: $RelativePath"
    }
    if ($part -ieq '.git') {
      throw "refusing to write inside a .git directory: $RelativePath"
    }

    $current = Join-Path $current $part
    Assert-PathInsideTarget $current
    $item = Get-ExistingItem $current
    if ($null -ne $item) {
      Assert-SafeWritePath $current
      if (-not $item.PSIsContainer) {
        throw "path exists and is not a directory: $current"
      }
    } else {
      [System.IO.Directory]::CreateDirectory($current) | Out-Null
    }
  }

  Assert-SafeWritePath $current
  Assert-PathInsideTarget $current
  return $current
}

function Compare-Bytes {
  param(
    [string]$LeftPath,
    [string]$RightPath
  )

  $left = Read-Bytes $LeftPath
  $right = Read-Bytes $RightPath
  if ($left.Length -ne $right.Length) {
    return $false
  }

  for ($index = 0; $index -lt $left.Length; $index++) {
    if ($left[$index] -ne $right[$index]) {
      return $false
    }
  }

  return $true
}

function Get-PanelVersion {
  param([string]$PathValue)
  $text = Read-Utf8Text $PathValue
  $match = [regex]::Match($text, 'MISSION CONTROL HUD v([0-9]+(?:\.[0-9]+)+)')
  if (-not $match.Success) {
    throw "could not read version stamp from panel: $PathValue"
  }
  return $match.Groups[1].Value
}

function Write-ConfigStub {
  param(
    [string]$ConfigPath,
    [string]$TargetBaseName
  )

  $existingItem = Get-ExistingItem $ConfigPath
  if ($null -ne $existingItem) {
    Assert-SafeWritePath $ConfigPath
    return
  }

  $configDir = Split-Path -Path $ConfigPath -Parent
  if (-not [string]::IsNullOrEmpty($configDir) -and -not (Get-ExistingItem $configDir)) {
    [System.IO.Directory]::CreateDirectory($configDir) | Out-Null
  }

  Assert-SafeWritePath $ConfigPath
  Assert-PathInsideTarget $ConfigPath

  $tempPath = $ConfigPath + '.' + [System.IO.Path]::GetRandomFileName() + '.tmp'
  Assert-SafeWritePath $tempPath
  Assert-PathInsideTarget $tempPath

  $stub = @(
    'window.BMC_CONFIG = {'
    '  title: "' + $TargetBaseName + ' mission control",'
    '  dataPath: "../.beads/issues.jsonl",'
    '  // accent: "#00f0ff",'
    '  // strings: {'
    '  //   title: "Controllo missione",'
    '  //   footer_text: "Esempio italiano",'
    '  // },'
    '  // refreshInterval: 15000,'
    '  // metaPath: "./orchestration.meta.json"'
    '};'
  ) -join "`n"

  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  $stream = $null
  $writer = $null
  try {
    $stream = New-Object System.IO.FileStream($tempPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    $writer = New-Object System.IO.StreamWriter($stream, $utf8NoBom)
    $writer.Write($stub)
  } finally {
    if ($null -ne $writer) {
      $writer.Dispose()
    } elseif ($null -ne $stream) {
      $stream.Dispose()
    }
  }

  $existingItem = Get-ExistingItem $ConfigPath
  if ($null -ne $existingItem) {
    throw "refusing to overwrite existing config: $ConfigPath"
  }

  Move-Item -LiteralPath $tempPath -Destination $ConfigPath -Force
}

try {
  $scriptRoot = Normalize-AbsolutePath $PSScriptRoot
  $repoRoot = Normalize-AbsolutePath (Split-Path -Path $scriptRoot -Parent)
  $sourcePanel = Join-Path $repoRoot 'dist/orchestration.html'
  $sourceRefreshPs1 = Join-Path $scriptRoot 'refresh.ps1'
  $sourceRefreshSh = Join-Path $scriptRoot 'refresh.sh'

  if (-not (Get-ExistingItem $Target)) {
    [Console]::Error.WriteLine((Show-Usage))
    [Console]::Error.WriteLine("error: target does not exist: $Target")
    exit 1
  }

  $script:TargetRoot = Resolve-ExistingPath $Target
  Assert-SafeWritePath $script:TargetRoot
  Assert-PathSegments $script:TargetRoot

  if (-not (Get-ExistingItem $sourcePanel)) {
    [Console]::Error.WriteLine((Show-Usage))
    [Console]::Error.WriteLine("error: missing source panel: $sourcePanel")
    exit 1
  }
  if (-not (Get-ExistingItem $sourceRefreshPs1)) {
    [Console]::Error.WriteLine((Show-Usage))
    [Console]::Error.WriteLine("error: missing source refresh script: $sourceRefreshPs1")
    exit 1
  }
  if (-not (Get-ExistingItem $sourceRefreshSh)) {
    [Console]::Error.WriteLine((Show-Usage))
    [Console]::Error.WriteLine("error: missing source refresh script: $sourceRefreshSh")
    exit 1
  }

  Assert-PathInsideTarget $script:TargetRoot

  Assert-NoTraversal $Dir
  $panelDir = Ensure-DirectoryPath $script:TargetRoot $Dir
  $panelPath = Join-Path $panelDir 'orchestration.html'
  $configPath = Join-Path $panelDir 'orchestration.config.js'
  $metaPath = Join-Path $panelDir 'orchestration.meta.json'
  $scriptsDir = Ensure-DirectoryPath $script:TargetRoot 'scripts'
  $installedRefreshPs1 = Join-Path $scriptsDir 'refresh.ps1'
  $installedRefreshSh = Join-Path $scriptsDir 'refresh.sh'

  Write-VendoredCopy $sourcePanel $panelPath 'panel file' -Update:$Update -Force:$Force
  Write-VendoredCopy $sourceRefreshPs1 $installedRefreshPs1 'refresh.ps1' -Update:$Update -Force:$Force
  Write-VendoredCopy $sourceRefreshSh $installedRefreshSh 'refresh.sh' -Update:$Update -Force:$Force
  Write-ConfigStub $configPath ([System.IO.Path]::GetFileName($script:TargetRoot))

  $metaItem = Get-ExistingItem $metaPath
  if ($null -ne $metaItem) {
    Assert-SafeWritePath $metaPath
  }

  $version = Get-PanelVersion $panelPath
  [Console]::Out.WriteLine("JARVIS: mission control wired at $panelPath")
  [Console]::Out.WriteLine("JARVIS: refresh with $installedRefreshPs1 or $installedRefreshSh")
  [Console]::Out.WriteLine("JARVIS: serve the project over HTTP and open the panel in a browser")
  [Console]::Out.WriteLine("JARVIS: config lives at $configPath")
  [Console]::Out.WriteLine("JARVIS: panel version v$version")
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
