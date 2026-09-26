param(
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$output = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $output
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$metadataPath = Join-Path $projectRoot "release-metadata.json"
$partial = "${output}.partial.${PID}"

if (Test-Path -LiteralPath $metadataPath) {
  throw "Refusing to overwrite existing release-metadata.json"
}
if (Test-Path -LiteralPath $output) {
  throw "Refusing to overwrite an existing release archive"
}
if (Test-Path -LiteralPath $partial) {
  throw "Refusing to overwrite an existing partial release archive"
}

Push-Location $projectRoot
try {
  $dirty = @(git status --porcelain --untracked-files=all)
  if ($LASTEXITCODE -ne 0) { throw "Unable to verify the release Git worktree" }
  if ($dirty.Count -ne 0) { throw "Refusing to package an uncommitted Git worktree" }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed" }
  $commit = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw "Unable to resolve release Git commit" }
  $manifest = Get-Content package.json -Raw | ConvertFrom-Json
  $metadata = [ordered]@{
    format = "SOTOAYAM_RELEASE_V1"
    application_version = $manifest.version
    git_commit = $commit
    node_version = (Get-Content .node-version -Raw).Trim()
    created_at = [DateTimeOffset]::UtcNow.ToString("o")
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText($metadataPath, $metadata, [System.Text.UTF8Encoding]::new($false))
  # The deploy flow creates link state from protected environment variables; never ship a developer project identity.
  # The migration runner ships compiled so `npm run migrate` never requires a devDependency runtime (tsx) in a
  # production-only install. Only customer/operator documentation ships; internal ADRs and reviews never do.
  tar -czf $partial dist/src dist/scripts/migrate.js public package.json package-lock.json .node-version .env.example release-metadata.json docs/deployment/clean-install.md docs/deployment/vps-production.md docs/deployment/production-checklist.md docs/deployment/backup-restore.md docs/deployment/sotoayam.service docs/deployment/nginx-sotoayam.conf scripts/deploy/deployment-config.sh scripts/deploy/check-vps-runtime.mjs scripts/deploy/smoke-production.mjs supabase/migrations
  if ($LASTEXITCODE -ne 0) { throw "Release packaging failed" }
  [System.IO.File]::Move($partial, $output)
} finally {
  Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $metadataPath -Force -ErrorAction SilentlyContinue
  Pop-Location
}

Write-Output $output
