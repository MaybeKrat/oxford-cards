$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$exePath = Join-Path $projectDirectory 'release\Oxford Cards.exe'
if (-not (Test-Path -LiteralPath $exePath)) { throw 'Сначала выполните npm run build:exe.' }
$desktopDirectory = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopDirectory 'Oxford Cards.lnk'
$shell = New-Object -ComObject WScript.Shell
$scratchDirectory = Join-Path $projectDirectory 'work'
New-Item -ItemType Directory -Force -Path $scratchDirectory | Out-Null
$scratchShortcut = Join-Path $scratchDirectory ('shortcut-' + [Guid]::NewGuid().ToString('N') + '.lnk')
# WScript can fail to save directly in a redirected Desktop with Cyrillic names.
# Build the shortcut locally, then let .NET copy it to the actual Desktop.
if (Test-Path -LiteralPath $shortcutPath) {
    Copy-Item -LiteralPath $shortcutPath -Destination $scratchShortcut
    $existing = $shell.CreateShortcut($scratchShortcut)
    if ($existing.TargetPath -ne $exePath) { throw 'Ярлык Oxford Cards уже существует и указывает на другой файл. Он не изменён.' }
}
$shortcut = $shell.CreateShortcut($scratchShortcut)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = Split-Path -Parent $exePath
$shortcut.Description = 'Oxford Cards — 3000 английских карточек с интервальным повторением'
$shortcut.IconLocation = "$exePath,0"
$shortcut.WindowStyle = 1
$shortcut.Save()
Copy-Item -LiteralPath $scratchShortcut -Destination $shortcutPath -Force
Remove-Item -LiteralPath $scratchShortcut
# Refresh this shortcut and executable after a new icon is embedded in the EXE.
if (-not ('OxfordCardsShellNotification' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OxfordCardsShellNotification {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern void SHChangeNotify(uint eventId, uint flags, string item1, IntPtr item2);
}
'@
}
[OxfordCardsShellNotification]::SHChangeNotify(0x2000, 0x3005, $exePath, [IntPtr]::Zero)
[OxfordCardsShellNotification]::SHChangeNotify(0x2000, 0x3005, $shortcutPath, [IntPtr]::Zero)
Write-Output $shortcutPath
