$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$locations = @("${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application", "$env:LOCALAPPDATA\Microsoft\EdgeWebView\Application", "$env:ProgramFiles\Microsoft\EdgeWebView\Application")
$versions = @($locations | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Directory } | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } | Sort-Object { [Version]$_.Name } -Descending)
if ($versions.Length -eq 0) { throw 'WebView2 is required for desktop testing. Install the Evergreen WebView2 Runtime first.' }
$version = $versions[0].Name
$destination = Join-Path $root ".cache\webdriver\$version"
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$executable = Join-Path $destination 'msedgedriver.exe'
if (-not (Test-Path $executable)) {
  $archive = Join-Path $destination 'edgedriver.zip'
  Invoke-WebRequest -UseBasicParsing "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip" -OutFile $archive
  Expand-Archive -Path $archive -DestinationPath $destination -Force
  Remove-Item $archive
}
Write-Output $executable
