$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Установите Node.js 24 LTS с nodejs.org, затем повторите запуск.'
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host 'Oxford Cards: http://127.0.0.1:5173/' -ForegroundColor Green
Write-Host 'Оставьте это окно открытым во время работы приложения. Остановка: Ctrl+C.'
& npm.cmd run dev
