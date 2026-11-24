param([ValidateSet('pokercoaching', 'youtube', 'bilibili')][string]$Platform = 'pokercoaching')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $projectRoot '.local\manual-chrome-profile'
$chromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chromePath)) { throw 'Chrome was not found.' }
New-Item -ItemType Directory -Force -Path $profilePath | Out-Null
$courseUrl = switch ($Platform) {
    'youtube' { 'https://www.youtube.com/' }
    'bilibili' { 'https://www.bilibili.com/' }
    default { 'https://pokercoaching.com/' }
}
# This is a user-operated login window. Do not attach automation until login is complete.
$chromeArgs = @(
    '--remote-debugging-address=127.0.0.1'
    '--remote-debugging-port=9223'
    ('--user-data-dir="' + $profilePath + '"')
    '--no-first-run'
    '--no-default-browser-check'
    '--new-window'
    $courseUrl
)
Start-Process -FilePath $chromePath -ArgumentList $chromeArgs
Write-Output 'Manual Chrome window opened. Complete Google sign-in and check course playback before attaching.'
