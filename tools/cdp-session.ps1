param(
  [switch]$StartIfAbsent,
  [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'
$profilePath = 'C:\jtmp\xfollower-cdp-profile'
$chromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$endpoint = "http://127.0.0.1:$Port"

function Get-ProfileChrome {
  @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object {
    $_.CommandLine -and
    $_.CommandLine -notmatch '(?i)(?:^|\s)--type=' -and
    $_.CommandLine.IndexOf($profilePath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
}

function Get-PortOwners {
  @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
}

$chrome = @(Get-ProfileChrome)
if ($chrome.Count -gt 1) {
  throw "发现多个使用 $profilePath 的 Chrome 主进程；先核对实例，不继续连接。"
}

$started = $false
if ($chrome.Count -eq 0) {
  if (-not $StartIfAbsent) {
    throw "未发现 $profilePath 对应的 Chrome。需要启动时重新运行并加 -StartIfAbsent。"
  }
  if ((Get-PortOwners).Count -gt 0) {
    throw "端口 $Port 已被其他进程占用，不启动第二个 Chrome。"
  }
  if (-not (Test-Path -LiteralPath $chromePath)) {
    throw "未找到 Chrome：$chromePath"
  }
  if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
    throw "未找到已有登录资料目录：$profilePath；不创建空白 profile。"
  }
  Start-Process -FilePath $chromePath -WindowStyle Hidden -ArgumentList @(
    "--user-data-dir=$profilePath",
    "--remote-debugging-port=$Port",
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check'
  ) | Out-Null
  $started = $true
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    $chrome = @(Get-ProfileChrome)
    if ($chrome.Count -eq 1 -and (Get-PortOwners).Count -gt 0) { break }
  }
}

if ($chrome.Count -ne 1) {
  throw "无法唯一确认 $profilePath 的 Chrome 主进程。"
}
$owners = Get-PortOwners
if ($owners.Count -eq 0 -or $chrome[0].ProcessId -notin $owners) {
  throw "端口 $Port 未由该 profile 的 Chrome 主进程监听；不连接其他实例。"
}

$version = Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 5
if ($version.Browser -notmatch '^Chrome/') {
  throw "端口 $Port 不是 Chrome CDP：$($version.Browser)"
}
$targets = Invoke-RestMethod -Uri "$endpoint/json/list" -TimeoutSec 5
$panels = @($targets | Where-Object {
  $_.type -eq 'page' -and $_.url -match '^chrome-extension://[^/]+/panel\.html$' -and
  $_.title -like '*XFollower*'
})
$xPages = @($targets | Where-Object {
  $_.type -eq 'page' -and $_.url -match '^https://(?:www\.)?x\.com/'
})

[pscustomobject]@{
  result = if ($started) { 'started' } else { 'attached' }
  chromePid = $chrome[0].ProcessId
  profile = $profilePath
  endpoint = $endpoint
  browser = $version.Browser
  panelTargets = @($panels | Select-Object id, title, url, webSocketDebuggerUrl)
  xTargets = @($xPages | Select-Object id, title, url, webSocketDebuggerUrl)
} | ConvertTo-Json -Depth 5
