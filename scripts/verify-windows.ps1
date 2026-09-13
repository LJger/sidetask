param([Parameter(Mandatory=$true)][string]$Executable, [switch]$NativeDrag, [switch]$AllScales, [switch]$Portable)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  $env:SIDETASK_TEST_EXECUTABLE = (Resolve-Path $Executable).Path
  if ($Portable) {
    node scripts/portable-smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Portable smoke test failed' }
  } else {
    node scripts/check.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Syntax check failed' }
    $files = @(Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object { $_.FullName })
    node --test @files
    if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed' }
    $env:SIDETASK_TEST_NATIVE_DRAG = $(if ($NativeDrag) { '1' } else { '0' })
    $scales = $(if ($AllScales) { @(1, 1.25, 1.5, 2) } else { @(1) })
    foreach ($scale in $scales) {
      $env:SIDETASK_TEST_SCALE = [string]$scale
      Write-Output ('Desktop scale: ' + $scale)
      node scripts/desktop-smoke.mjs
      if ($LASTEXITCODE -ne 0) { throw ('Desktop smoke failed at scale ' + $scale) }
    }
  }
} finally {
  Remove-Item Env:SIDETASK_TEST_EXECUTABLE -ErrorAction SilentlyContinue
  Remove-Item Env:SIDETASK_TEST_NATIVE_DRAG -ErrorAction SilentlyContinue
  Remove-Item Env:SIDETASK_TEST_SCALE -ErrorAction SilentlyContinue
  Pop-Location
}
