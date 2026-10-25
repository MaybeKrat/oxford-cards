$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) {
    throw 'Node.js is required to generate the application icons. Install Node.js and run npm ci first.'
}

& $nodeCommand.Source (Join-Path $PSScriptRoot 'create-desktop-icon.mjs')
if ($LASTEXITCODE -ne 0) {
    throw "Application icon generation failed (exit code $LASTEXITCODE). Run npm ci to install the build dependencies."
}
