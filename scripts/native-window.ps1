param([Parameter(Mandatory=$true)][string]$Executable, [ValidateSet('Info','Focus','Other')][string]$Action = 'Info')
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SideTaskWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
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
if ($Action -eq 'Other') {
  Add-Type -AssemblyName System.Windows.Forms
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'SideTask desktop verification'
  $form.Width = 260; $form.Height = 140; $form.TopMost = $true
  $form.Show(); $form.Activate()
  [void][SideTaskWindowProbe]::SetForegroundWindow($form.Handle)
  $until = [DateTime]::UtcNow.AddMilliseconds(1600)
  while ([DateTime]::UtcNow -lt $until) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }
  $form.Close(); $form.Dispose()
} elseif ($Action -eq 'Focus') {
  [void][SideTaskWindowProbe]::SetWindowPos($handle, [IntPtr](-1), 0, 0, 0, 0, 67)
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
$result = @{ handle=$handle.ToInt64().ToString(); pid=$target[0].Id; dpi=[SideTaskWindowProbe]::GetDpiForWindow($handle); bounds=@{x=$rect.Left;y=$rect.Top;width=$rect.Right-$rect.Left;height=$rect.Bottom-$rect.Top}; visibleBounds=$visibleBounds; regionType=$regionType; displays=$displays } | ConvertTo-Json -Depth 4 -Compress
Write-Output ('SIDETASK_PROBE:' + $result)
