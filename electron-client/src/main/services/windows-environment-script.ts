/** 请求只从标准输入读取；变量值不会进入 PowerShell 命令文本。 */
export const WINDOWS_ENVIRONMENT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.source -ne 'user' -and $request.source -ne 'system') { throw 'Invalid source' }
$hive = if ($request.source -eq 'user') { [Microsoft.Win32.Registry]::CurrentUser } else { [Microsoft.Win32.Registry]::LocalMachine }
$subkey = if ($request.source -eq 'user') { 'Environment' } else { 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' }
$key = $null
function Read-Entries($opened) {
  $items = @()
  if ($null -ne $opened) {
    foreach ($name in $opened.GetValueNames()) {
      $kind = $opened.GetValueKind($name).ToString()
      if ($kind -ne 'String' -and $kind -ne 'ExpandString') { throw 'Unsupported environment value type' }
      $items += @{key=$name;value=$opened.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=$kind}
    }
  }
  return $items
}
try {
  if ($request.action -eq 'read') {
    $key = $hive.OpenSubKey($subkey,$false)
    @{success=$true;entries=@(Read-Entries $key)} | ConvertTo-Json -Depth 8 -Compress
  } elseif ($request.action -eq 'write') {
    $key = $hive.CreateSubKey($subkey,$true)
    $current = @(Read-Entries $key)
    if ($current.Count -ne $request.expected.Count) { throw 'Environment changed' }
    foreach ($item in $current) {
      $match = @($request.expected | Where-Object { $_.key -ieq $item.key })
      if ($match.Count -ne 1 -or $match[0].value -cne $item.value -or $match[0].kind -ne $item.kind) { throw 'Environment changed' }
    }
    foreach ($item in $current) {
      if (-not @($request.entries | Where-Object { $_.key -ieq $item.key }).Count) { $key.DeleteValue($item.key,$true) }
    }
    foreach ($item in $request.entries) {
      if ($item.kind -ne 'String' -and $item.kind -ne 'ExpandString') { throw 'Invalid type' }
      $previous = @($request.expected | Where-Object { $_.key -ieq $item.key })
      if ($previous.Count -eq 0 -or $previous[0].value -cne $item.value -or $previous[0].kind -ne $item.kind) {
        $kind = [System.Enum]::Parse([Microsoft.Win32.RegistryValueKind],[string]$item.kind)
        $key.SetValue($item.key,[string]$item.value,$kind)
      }
    }
    $key.Flush()
    @{success=$true} | ConvertTo-Json -Compress
  } else { throw 'Invalid operation' }
} finally { if ($null -ne $key) { $key.Dispose() } }
`
