# Without -Install or -Remove this only shows the planned change.
param([switch]$Install, [switch]$Remove, [switch]$Classic, [string]$Root = (Split-Path $PSScriptRoot -Parent))
if ($Install -and $Remove) { throw 'Choose -Install or -Remove, not both.' }
$startup = [Environment]::GetFolderPath('Startup')
. (Join-Path $PSScriptRoot 'public\autostart.ps1')
$entry = Get-TaviEntry $startup $Root
$launcher = Join-Path (Join-Path $Root 'scripts') 'tavi-start-hidden.vbs'
if ($Remove) {
  Remove-Item -LiteralPath $entry -ErrorAction SilentlyContinue
  "Removed $entry"
} elseif ($Install) {
  $entry = Join-Path $startup 'Tavi.vbs'
  "CreateObject(""WScript.Shell"").Run ""wscript.exe """"$launcher"""""", 0, False" | Set-Content -LiteralPath $entry -Encoding Unicode
  Remove-TaviEarlierEntry $startup $Root
  "Windows sign-in will start $launcher"
} else {
  "Would point $entry at $launcher. Use -Install to do this, or -Remove to remove it."
}
