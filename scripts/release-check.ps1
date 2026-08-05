# Windows 包装:真正的发布门禁逻辑在跨平台 node 入口 scripts/release-check.mjs。
$ErrorActionPreference = "Stop"
$nodeEntry = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts\release-check.mjs"
& node $nodeEntry
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }