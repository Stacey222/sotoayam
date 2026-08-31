param(
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$output = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $output
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

Push-Location $projectRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed" }
  tar -czf $output dist/src public package.json package-lock.json
  if ($LASTEXITCODE -ne 0) { throw "Release packaging failed" }
} finally {
  Pop-Location
}

Write-Output $output
