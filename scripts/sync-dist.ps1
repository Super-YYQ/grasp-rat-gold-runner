# Phase 1 起,dist 由 esbuild 确定性构建生成,不再手工拷贝 src→dist。
# 本脚本保留为兼容入口,内部委托给 npm run build。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Push-Location $root
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

Write-Host "dist rebuilt by esbuild pipeline (deterministic)."