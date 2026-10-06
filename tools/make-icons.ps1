# Renders the extension icons (three overlapping "camera frames" with a play
# mark) at every size Chrome needs. Usage: powershell -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'icons'
New-Item -ItemType Directory -Force $out | Out-Null

function RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

foreach ($size in 16, 32, 48, 128) {
  $s = $size / 128.0
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)

  # Background tile.
  $bg = RoundedRect (4 * $s) (4 * $s) (120 * $s) (120 * $s) (26 * $s)
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 18, 18, 24))), $bg)

  # Two angled frames behind (other cameras), one front frame (the active one).
  $back = [System.Drawing.Color]::FromArgb(255, 62, 166, 255)
  $mid = [System.Drawing.Color]::FromArgb(255, 140, 110, 255)
  $front = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
  $stroke = [Math]::Max(1.5, 7 * $s)
  if ($size -ge 32) {
    $g.DrawPath((New-Object System.Drawing.Pen $back, $stroke), (RoundedRect (22 * $s) (24 * $s) (70 * $s) (48 * $s) (8 * $s)))
    $g.DrawPath((New-Object System.Drawing.Pen $mid, $stroke), (RoundedRect (30 * $s) (36 * $s) (70 * $s) (48 * $s) (8 * $s)))
  } else {
    $g.DrawPath((New-Object System.Drawing.Pen $back, $stroke), (RoundedRect (26 * $s) (28 * $s) (70 * $s) (48 * $s) (8 * $s)))
  }
  $frontRect = RoundedRect (38 * $s) (50 * $s) (70 * $s) (50 * $s) (9 * $s)
  $g.FillPath((New-Object System.Drawing.SolidBrush $front), $frontRect)

  # Play mark in the front frame.
  $tri = @(
    (New-Object System.Drawing.PointF ((64 * $s), (63 * $s))),
    (New-Object System.Drawing.PointF ((64 * $s), (87 * $s))),
    (New-Object System.Drawing.PointF ((86 * $s), (75 * $s)))
  )
  $g.FillPolygon((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 18, 18, 24))), $tri)

  $file = Join-Path $out "icon$size.png"
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output $file
}
