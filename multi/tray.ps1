# Mission Control - icona nell'area di notifica (Windows PowerShell 5.1, WinForms, nessuna dipendenza).
# - avvia il server Node se non risponde;
# - notifica di Windows quando una sessione Claude passa in "attende input";
# - clic sinistro: riepilogo nativo (progetti, sessioni, bead); doppio clic su una riga apre quella scheda nel browser;
# - menu: apri Mission Control, riepilogo, notifiche on/off, esci.
# Porta: -Port, altrimenti "port" di mission-control.config.json, altrimenti 4747 (come server.mjs).
param([int]$Port = 0, [int]$PollMs = 5000)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$here = $PSScriptRoot
if (-not $Port) {
  $Port = 4747
  $cfgFile = Join-Path $here 'mission-control.config.json'
  if (Test-Path -LiteralPath $cfgFile) { try { $c = Get-Content -LiteralPath $cfgFile -Raw | ConvertFrom-Json; if ($c.port) { $Port = [int]$c.port } } catch {} }
}
# Istanza unica per porta.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\MissionControlTray-$Port", [ref]$created)
if (-not $created) { exit 0 }

$base = "http://127.0.0.1:$Port"
$script:notify = $true
$script:state = $null
$script:prevWaiting = @{}   # chiave sessione -> $true
$script:firstPoll = $true
$script:summary = $null

function Test-Server {
  try { Invoke-RestMethod -Uri "$base/api/state" -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}
function Start-Server {
  if (Test-Server) { return }
  Start-Process -WindowStyle Hidden -FilePath node -ArgumentList ('"' + (Join-Path $here 'server.mjs') + '"') -WorkingDirectory $here
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 300; if (Test-Server) { break } }
}
function Open-Panel([string]$slug) {
  $url = "$base/"
  if ($slug) { $url += '#' + [Uri]::EscapeDataString($slug) }
  Start-Process $url
}

# Icone: base e variante con pallino ambra (qualcuno attende input) o grigio (server giu').
# Disegnate al volo (radar: tondo scuro, anello e centro ciano): nessun file di icona da distribuire.
function New-TrayBitmap {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $cyan = [System.Drawing.Color]::FromArgb(255, 0, 240, 255)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 8, 18, 36))), 1, 1, 30, 30)
  $g.DrawEllipse((New-Object System.Drawing.Pen $cyan, 2.5), 2, 2, 27, 27)
  $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150, 0, 240, 255)), 1.2), 9, 9, 14, 14)
  $g.DrawLine((New-Object System.Drawing.Pen $cyan, 2), 16, 16, 26, 10)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $cyan), 13.5, 13.5, 5, 5)
  $g.Dispose()
  return $bmp
}
$baseIcon = [System.Drawing.Icon]::FromHandle((New-TrayBitmap).GetHicon())
function New-DotIcon([System.Drawing.Color]$color) {
  $bmp = New-TrayBitmap
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 3, 7, 18))), 15, 15, 17, 17)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $color), 17, 17, 13, 13)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$waitIcon = New-DotIcon ([System.Drawing.Color]::FromArgb(255, 255, 184, 0))
$downIcon = New-DotIcon ([System.Drawing.Color]::FromArgb(255, 120, 120, 120))

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $baseIcon
$tray.Text = 'Mission Control'
$tray.Visible = $true

# --- Riepilogo nativo -------------------------------------------------------
$statusText = @{ busy = 'al lavoro'; waiting = 'ATTENDE INPUT'; shell = 'shell'; idle = 'inattiva' }
$statusRank = @{ waiting = 4; busy = 3; shell = 2; idle = 1 }

function Get-TopStatus($p) {
  $best = ''; $rank = -1
  foreach ($s in @($p.sessions)) { $r = $statusRank[[string]$s.status]; if ($null -eq $r) { $r = 0 }; if ($r -gt $rank) { $rank = $r; $best = [string]$s.status } }
  return $best
}

function Show-Summary {
  if ($script:summary -and -not $script:summary.IsDisposed) { Update-Summary; $script:summary.Activate(); return }
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Mission Control'
  $f.Icon = $baseIcon
  $f.Size = New-Object System.Drawing.Size(760, 360)
  $f.StartPosition = 'Manual'
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $f.Location = New-Object System.Drawing.Point(($wa.Right - 770), ($wa.Bottom - 370))
  $f.TopMost = $true
  $f.BackColor = [System.Drawing.Color]::FromArgb(255, 10, 16, 28)
  $f.ForeColor = [System.Drawing.Color]::FromArgb(255, 220, 235, 245)
  $f.Font = New-Object System.Drawing.Font('Segoe UI', 9)

  $lv = New-Object System.Windows.Forms.ListView
  $lv.Dock = 'Fill'; $lv.View = 'Details'; $lv.FullRowSelect = $true; $lv.HeaderStyle = 'Nonclickable'
  $lv.BackColor = $f.BackColor; $lv.ForeColor = $f.ForeColor; $lv.BorderStyle = 'None'
  foreach ($c in @(@('Progetto', 150), @('Stato', 110), @('Sessioni', 230), @('In corso', 65), @('Aperti', 60), @('Bloccati', 65), @('Chiusi', 55))) {
    [void]$lv.Columns.Add($c[0], $c[1])
  }
  $lv.Add_DoubleClick({ $it = $this.SelectedItems | Select-Object -First 1; if ($it -and $it.Tag) { Open-Panel ([string]$it.Tag) } })

  $bar = New-Object System.Windows.Forms.Label
  $bar.Dock = 'Bottom'; $bar.Height = 22; $bar.TextAlign = 'MiddleLeft'
  $bar.ForeColor = [System.Drawing.Color]::FromArgb(255, 120, 160, 180)
  $bar.Text = '  Doppio clic su un progetto per aprirne il pannello nel browser. Esc per chiudere.'

  $f.Controls.Add($lv); $f.Controls.Add($bar)
  $f.KeyPreview = $true
  $f.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $this.Close() } })
  $f.Tag = $lv
  $script:summary = $f
  Update-Summary
  $f.Show()
  $f.Activate()
}

function Update-Summary {
  $f = $script:summary
  if (-not $f -or $f.IsDisposed) { return }
  $lv = $f.Tag
  $lv.BeginUpdate()
  $lv.Items.Clear()
  if (-not $script:state) {
    [void]$lv.Items.Add((New-Object System.Windows.Forms.ListViewItem('server non raggiungibile')))
  } else {
    $rows = @($script:state.projects) | Sort-Object @{ Expression = { $r = $statusRank[(Get-TopStatus $_)]; if ($null -eq $r) { 0 } else { $r } }; Descending = $true }, label
    foreach ($p in $rows) {
      $top = Get-TopStatus $p
      $st = if ($top) { $statusText[$top] } else { 'nessuna sessione' }
      $sess = (@($p.sessions) | ForEach-Object {
          $t = $statusText[[string]$_.status]; if (-not $t) { $t = [string]$_.status }
          if ($_.status -eq 'waiting' -and $_.waitingFor) { $t = 'attende: ' + $_.waitingFor }
          "$($_.name) ($t)"
        }) -join '; '
      $c = $p.counts
      $it = New-Object System.Windows.Forms.ListViewItem([string]$p.label)
      foreach ($v in @($st, $sess, $(if ($c) { $c.in_progress } else { '' }), $(if ($c) { $c.open } else { '' }), $(if ($c) { $c.blocked } else { '' }), $(if ($c) { $c.closed } else { '' }))) {
        [void]$it.SubItems.Add([string]$v)
      }
      if ($p.hasBeads) { $it.Tag = [string]$p.slug }
      if ($top -eq 'waiting') { $it.ForeColor = [System.Drawing.Color]::FromArgb(255, 255, 184, 0) }
      elseif (-not $p.hasBeads) { $it.ForeColor = [System.Drawing.Color]::FromArgb(255, 120, 140, 155) }
      $it.ToolTipText = [string]$p.root
      [void]$lv.Items.Add($it)
    }
  }
  $lv.EndUpdate()
}

# --- Polling ------------------------------------------------------------------
function Invoke-Poll {
  try {
    $script:state = Invoke-RestMethod -Uri "$base/api/state" -TimeoutSec 3
  } catch {
    $script:state = $null
    $tray.Icon = $downIcon
    $tray.Text = 'Mission Control - server non raggiungibile'
    Update-Summary
    return
  }
  $now = @{}
  $fresh = @()
  foreach ($p in @($script:state.projects)) {
    foreach ($s in @($p.sessions)) {
      if ($s.status -ne 'waiting') { continue }
      $key = if ($s.pid) { "$($s.pid)" } else { "$($p.slug)|$($s.name)" }
      $now[$key] = $true
      if (-not $script:prevWaiting.ContainsKey($key)) { $fresh += [pscustomobject]@{ Project = $p.label; Name = $s.name; For = $s.waitingFor; Slug = $p.slug; HasBeads = $p.hasBeads } }
    }
  }
  $script:prevWaiting = $now
  $n = $now.Count
  $tray.Icon = if ($n) { $waitIcon } else { $baseIcon }
  $t = if ($n) { "Mission Control - $n in attesa" } else { 'Mission Control - nessuna attesa' }
  $tray.Text = $t.Substring(0, [Math]::Min(63, $t.Length))

  if ($fresh.Count -and $script:notify -and -not $script:firstPoll) {
    $first = $fresh[0]
    $title = if ($fresh.Count -eq 1) { "$($first.Project): attende input" } else { "$($fresh.Count) sessioni attendono input" }
    $body = ($fresh | ForEach-Object { $x = "$($_.Project) - $($_.Name)"; if ($_.For) { $x += ": $($_.For)" }; $x }) -join "`n"
    $script:balloonSlug = if ($first.HasBeads) { [string]$first.Slug } else { '' }
    $tray.ShowBalloonTip(8000, $title, $body.Substring(0, [Math]::Min(250, $body.Length)), [System.Windows.Forms.ToolTipIcon]::Info)
  }
  $script:firstPoll = $false
  Update-Summary
}

# --- Menu ---------------------------------------------------------------------
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('Apri Mission Control')
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miOpen.Add_Click({ Open-Panel '' })
$menu.Items.Add('Riepilogo').Add_Click({ Show-Summary }) | Out-Null
$miNotify = New-Object System.Windows.Forms.ToolStripMenuItem('Notifiche')
$miNotify.Checked = $true
$miNotify.Add_Click({ $script:notify = -not $script:notify; $this.Checked = $script:notify })
[void]$menu.Items.Add($miNotify)
[void]$menu.Items.Add('-')
$menu.Items.Add('Esci (il server resta attivo)').Add_Click({ [System.Windows.Forms.Application]::Exit() }) | Out-Null
$menu.Items.Add('Esci e ferma il server').Add_Click({
    try {
      $line = netstat -ano -p tcp | Select-String "127\.0\.0\.1:$Port\s+\S+\s+LISTENING" | Select-Object -First 1
      if ($line) { Stop-Process -Id ([int](($line.Line -split '\s+')[-1])) -Force }
    } catch {}
    [System.Windows.Forms.Application]::Exit()
  }) | Out-Null
$tray.ContextMenuStrip = $menu

$tray.Add_MouseClick({ if ($_.Button -eq 'Left') { Show-Summary } })
$tray.Add_BalloonTipClicked({ Open-Panel $script:balloonSlug })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $PollMs
$timer.Add_Tick({ Invoke-Poll })

Start-Server
Invoke-Poll
$timer.Start()
try { [System.Windows.Forms.Application]::Run() }
finally {
  $timer.Stop(); $tray.Visible = $false; $tray.Dispose()
  $mutex.ReleaseMutex()
}
