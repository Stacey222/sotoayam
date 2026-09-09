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
  # The deploy flow creates link state from protected environment variables; never ship a developer project identity.
  # The migration runner ships compiled so `npm run migrate` never requires a devDependency runtime (tsx) in a
  # production-only install. Only customer/operator documentation ships; internal ADRs and reviews never do.
  tar -czf $output dist/src dist/scripts/migrate.js public package.json package-lock.json .node-version .env.example docs/deployment/clean-install.md docs/database-recovery.md scripts/deploy/deployment-config.sh scripts/deploy/check-vps-runtime.mjs supabase/migrations
  if ($LASTEXITCODE -ne 0) { throw "Release packaging failed" }
} finally {
  Pop-Location
}

Write-Output $output
