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
$checksumOutput = "${output}.sha256"
$checksumPartial = "${checksumOutput}.partial.${PID}"
$published = $false

if (Test-Path -LiteralPath $metadataPath) {
  throw "Refusing to overwrite existing release-metadata.json"
}
if (Test-Path -LiteralPath $output) {
  throw "Refusing to overwrite an existing release archive"
}
if (Test-Path -LiteralPath $partial) {
  throw "Refusing to overwrite an existing partial release archive"
}
if (Test-Path -LiteralPath $checksumOutput) {
  throw "Refusing to overwrite an existing release checksum"
}
if (Test-Path -LiteralPath $checksumPartial) {
  throw "Refusing to overwrite an existing partial release checksum"
}

Push-Location $projectRoot
try {
  $dirty = @(git status --porcelain --untracked-files=all)
  if ($LASTEXITCODE -ne 0) { throw "Unable to verify the release Git worktree" }
  if ($dirty.Count -ne 0) { throw "Refusing to package an uncommitted Git worktree" }
  $commit = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw "Unable to resolve release Git commit" }
  $manifest = Get-Content package.json -Raw | ConvertFrom-Json
  $expectedName = "sotoayam-v$($manifest.version)-$($commit.Substring(0, 12)).tar.gz"
  if ((Split-Path -Leaf $output) -cne $expectedName) {
    throw "Release archive must be named $expectedName"
  }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed" }
  $migrationCount = @(Get-ChildItem -LiteralPath "supabase/migrations" -File -Filter "*.sql").Count
  $metadata = [ordered]@{
    format = "SOTOAYAM_RELEASE_V1"
    application_version = $manifest.version
    git_commit = $commit
    node_version = (Get-Content .node-version -Raw).Trim()
    migration_count = $migrationCount
    created_at = [DateTimeOffset]::UtcNow.ToString("o")
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText($metadataPath, $metadata, [System.Text.UTF8Encoding]::new($false))
  # The deploy flow creates link state from protected environment variables; never ship a developer project identity.
  # Migration and recovery tooling ships compiled so customer commands never require the devDependency runtime
  # (tsx) in a production-only install. Internal ADRs, reviews, tests, and development database tools never ship.
  tar -czf $partial dist/src dist/scripts/migrate.js dist/scripts/backup-create.js dist/scripts/backup-verify.js dist/scripts/backup-restore.js dist/scripts/backup-recovery.js dist/scripts/postgres-tools.js public package.json package-lock.json .node-version .env.example release-metadata.json docs/customer-release-notes-v1.0.0.md docs/customer-operator-guide.md docs/customer-acceptance-checklist.md docs/customer-handoff-runbook.md docs/customer-onboarding.md docs/deployment/clean-install.md docs/deployment/vps-production.md docs/deployment/production-checklist.md docs/deployment/backup-restore.md docs/deployment/sotoayam.service docs/deployment/nginx-sotoayam.conf scripts/deploy/bootstrap-vps.sh scripts/deploy/install-env.sh scripts/deploy/deploy-release.sh scripts/deploy/rollback.sh scripts/deploy/deployment-config.sh scripts/deploy/check-vps-runtime.mjs scripts/deploy/smoke-production.mjs supabase/migrations
  if ($LASTEXITCODE -ne 0) { throw "Release packaging failed" }
  $checksum = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
  $checksumLine = "$checksum  $expectedName`n"
  [System.IO.File]::WriteAllText($checksumPartial, $checksumLine, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::Move($partial, $output)
  try {
    [System.IO.File]::Move($checksumPartial, $checksumOutput)
  } catch {
    Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
    throw
  }
  $published = $true
} finally {
  Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $checksumPartial -Force -ErrorAction SilentlyContinue
  if (-not $published) {
    Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $checksumOutput -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $metadataPath -Force -ErrorAction SilentlyContinue
  Pop-Location
}

Write-Output $output
Write-Output $checksumOutput
