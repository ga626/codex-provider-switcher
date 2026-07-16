param()

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$assetRoot = Join-Path $projectRoot 'src-tauri\installer'
$iconPath = Join-Path $projectRoot 'src-tauri\icons\icon.png'

New-Item -ItemType Directory -Path $assetRoot -Force | Out-Null
Add-Type -AssemblyName System.Drawing

function New-Canvas {
    param([int]$Width, [int]$Height)
    $bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
    $bitmap.SetResolution(96, 96)
    return $bitmap
}

function Save-Header {
    param([System.Drawing.Image]$Icon, [string]$Path)
    $bitmap = New-Canvas -Width 150 -Height 57
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([System.Drawing.Color]::White)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.DrawImage($Icon, 10, 10, 36, 36)
        $graphics.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(93, 197, 180))), 0, 55, 150, 2)
        $font = New-Object System.Drawing.Font('Segoe UI', 7.2, [System.Drawing.FontStyle]::Bold)
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(14, 23, 38))
        try {
            $graphics.DrawString('CodeX Provider', $font, $brush, 53, 15)
            $graphics.DrawString('Switcher', $font, $brush, 53, 29)
        } finally {
            $font.Dispose()
            $brush.Dispose()
        }
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Save-Sidebar {
    param([System.Drawing.Image]$Icon, [string]$Path)
    $bitmap = New-Canvas -Width 164 -Height 314
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([System.Drawing.Color]::FromArgb(14, 23, 38))
        $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(93, 197, 180))
        try {
            $graphics.FillRectangle($accent, 0, 0, 6, 314)
        } finally {
            $accent.Dispose()
        }
        $graphics.DrawImage($Icon, 46, 72, 72, 72)
        $font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
        try {
            $graphics.DrawString('CodeX Provider', $font, $brush, 16, 177)
            $graphics.DrawString('Switcher', $font, $brush, 16, 198)
        } finally {
            $font.Dispose()
            $brush.Dispose()
        }
        $line = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 88, 108), 1)
        try {
            $graphics.DrawLine($line, 16, 235, 148, 235)
        } finally {
            $line.Dispose()
        }
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$icon = [System.Drawing.Image]::FromFile($iconPath)
try {
    Save-Header -Icon $icon -Path (Join-Path $assetRoot 'header.bmp')
    Save-Sidebar -Icon $icon -Path (Join-Path $assetRoot 'sidebar.bmp')
} finally {
    $icon.Dispose()
}

Write-Host "[PASS] Installer assets generated in $assetRoot"
