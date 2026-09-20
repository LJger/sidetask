param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [ValidateSet('Info','Focus','Other','FocusCycle','AltF4','WatchFrame')][string]$Action = 'Info',
  [ValidateRange(1,900000)][int]$WatchMilliseconds = 30000,
  [string]$StopFile,
  [string]$StartFile
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SideTaskWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] public static extern uint GetWindowLongW(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowRgnBox(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
}
'@
[void][SideTaskWindowProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$processName = [System.IO.Path]::GetFileNameWithoutExtension($Executable)
$target = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Executable -and $_.MainWindowHandle -ne 0 })
if ($target.Length -ne 1) { throw ('Expected one visible test window; found ' + $target.Length) }
$handle = $target[0].MainWindowHandle
$focusCycle = $null
function Read-FrameStyle {
  $style = [SideTaskWindowProbe]::GetWindowLongW($handle, -16)
  $exStyle = [SideTaskWindowProbe]::GetWindowLongW($handle, -20)
  # Caption (including WS_BORDER/WS_DLGFRAME), resize frame, and extended edges.
  return @{ style=$style; exStyle=$exStyle; decorated=(($style -band 0x00C40000) -ne 0 -or ($exStyle -band 0x00020301) -ne 0) }
}
if ($Action -eq 'WatchFrame') {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $samples = 0; $violations = 0; $firstViolation = $null
  $observed = [System.Collections.Generic.HashSet[string]]::new()
  Write-Output 'SIDETASK_FRAME_WATCH_READY'
  while ($clock.ElapsedMilliseconds -lt $WatchMilliseconds -and (-not $StopFile -or -not (Test-Path -LiteralPath $StopFile))) {
    if (-not [SideTaskWindowProbe]::IsWindow($handle)) { throw 'The watched window closed before frame verification completed' }
    $frame = Read-FrameStyle
    $samples += 1
    [void]$observed.Add(('{0:X8}/{1:X8}' -f $frame.style,$frame.exStyle))
    if ($frame.decorated) {
      $violations += 1
      if (-not $firstViolation) { $firstViolation = @{elapsedMs=$clock.ElapsedMilliseconds; frame=$frame} }
    }
    Start-Sleep -Milliseconds 5
  }
  $result = @{samples=$samples; violations=$violations; firstViolation=$firstViolation; styles=@($observed); elapsedMs=$clock.ElapsedMilliseconds} | ConvertTo-Json -Depth 4 -Compress
  Write-Output ('SIDETASK_FRAME_WATCH:' + $result)
  exit 0
}
if ($Action -eq 'Other' -or $Action -eq 'FocusCycle') {
  Add-Type -AssemblyName System.Windows.Forms
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'SideTask desktop verification'
  $form.Width = 260; $form.Height = 140; $form.TopMost = $true
  if ($Action -eq 'FocusCycle') {
    if (-not $StartFile) { throw 'FocusCycle requires a StartFile' }
    # Initialize WinForms before the animation starts; process startup must not
    # consume the opening animation's 240 ms or the controller's 800 ms timeout.
    [void]$form.Handle
    Write-Output 'SIDETASK_FOCUS_READY'
    $readyClock = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $StartFile)) {
      if ($readyClock.ElapsedMilliseconds -gt 15000) { throw 'Timed out waiting for the focus cycle trigger' }
      Start-Sleep -Milliseconds 5
    }
  }
  $form.Show(); $form.Activate()
  $awayAccepted = [SideTaskWindowProbe]::SetForegroundWindow($form.Handle)
  $awayWindow = [SideTaskWindowProbe]::GetForegroundWindow().ToInt64()
  $awayMilliseconds = if ($Action -eq 'FocusCycle') { 60 } else { 1600 }
  $until = [DateTime]::UtcNow.AddMilliseconds($awayMilliseconds)
  while ([DateTime]::UtcNow -lt $until) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }
  if ($Action -eq 'FocusCycle') {
    $returnAccepted = [SideTaskWindowProbe]::SetForegroundWindow($handle)
    $focusCycle = @{awayAccepted=$awayAccepted; awayWindow=$awayWindow; returnAccepted=$returnAccepted; returnWindow=[SideTaskWindowProbe]::GetForegroundWindow().ToInt64()}
  }
  $form.Close(); $form.Dispose()
  if ($focusCycle) { $focusCycle.afterCloseWindow = [SideTaskWindowProbe]::GetForegroundWindow().ToInt64() }
} elseif ($Action -eq 'AltF4') {
  Add-Type -AssemblyName System.Windows.Forms
  [void][SideTaskWindowProbe]::SetForegroundWindow($handle)
  if ([SideTaskWindowProbe]::GetForegroundWindow() -ne $handle) { throw 'Refusing to send Alt+F4 to a different window' }
  [System.Windows.Forms.SendKeys]::SendWait('%{F4}')
} elseif ($Action -eq 'Focus') {
  # Activate without changing the application's topmost policy under test.
  [void][SideTaskWindowProbe]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, 0, 0, 71)
  [void][SideTaskWindowProbe]::SetForegroundWindow($handle)
}
$rect = New-Object SideTaskWindowProbe+RECT
[void][SideTaskWindowProbe]::GetWindowRect($handle, [ref]$rect)
$region = New-Object SideTaskWindowProbe+RECT
$regionType = [SideTaskWindowProbe]::GetWindowRgnBox($handle, [ref]$region)
$visibleBounds = @{x=$rect.Left;y=$rect.Top;width=$rect.Right-$rect.Left;height=$rect.Bottom-$rect.Top}
if ($regionType -gt 0) {
  $visibleBounds = @{x=$rect.Left+$region.Left;y=$rect.Top+$region.Top;width=$region.Right-$region.Left;height=$region.Bottom-$region.Top}
}
Add-Type -AssemblyName System.Windows.Forms
$displays = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ id=$_.DeviceName; primary=$_.Primary; workArea=@{x=$_.WorkingArea.X;y=$_.WorkingArea.Y;width=$_.WorkingArea.Width;height=$_.WorkingArea.Height} } })
$client = New-Object SideTaskWindowProbe+RECT
$origin = New-Object SideTaskWindowProbe+POINT
[void][SideTaskWindowProbe]::GetClientRect($handle, [ref]$client)
[void][SideTaskWindowProbe]::ClientToScreen($handle, [ref]$origin)
$result = @{ handle=$handle.ToInt64().ToString(); pid=$target[0].Id; dpi=[SideTaskWindowProbe]::GetDpiForWindow($handle); bounds=@{x=$rect.Left;y=$rect.Top;width=$rect.Right-$rect.Left;height=$rect.Bottom-$rect.Top}; visibleBounds=$visibleBounds; regionType=$regionType; displays=$displays;
  frame=(Read-FrameStyle); clientBounds=@{x=$origin.X;y=$origin.Y;width=$client.Right-$client.Left;height=$client.Bottom-$client.Top}
  focusCycle=$focusCycle
} | ConvertTo-Json -Depth 4 -Compress
Write-Output ('SIDETASK_PROBE:' + $result)
