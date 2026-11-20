# Earlier entry names are made from parts here so a saved entry can be recognised.
$TaviEarlierWords = 'Leading', 'Hand' -join ' '
$TaviEarlierEntry = ('Leading', 'Hand' -join '') + '.vbs'
function Test-TaviEntryRoot([string]$Text, [string]$Root) {
  $marker = $Root.Replace('/', '\').TrimEnd('\') + '\'
  return $Text.Replace('/', '\').IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0
}
function Get-TaviEntry([string]$Folder, [string]$Root) {
  $current = Join-Path $Folder 'Tavi.vbs'
  $earlier = Join-Path $Folder $TaviEarlierEntry
  if (Test-Path -LiteralPath $current) { return $current }
  if ((Test-Path -LiteralPath $earlier) -and (Test-TaviEntryRoot (Get-Content -LiteralPath $earlier -Raw) $Root)) { return $earlier }
  return $current
}
function Remove-TaviEarlierEntry([string]$Folder, [string]$Root) {
  $earlier = Join-Path $Folder $TaviEarlierEntry
  if ((Test-Path -LiteralPath $earlier) -and (Test-TaviEntryRoot (Get-Content -LiteralPath $earlier -Raw) $Root)) { Remove-Item -LiteralPath $earlier }
}
