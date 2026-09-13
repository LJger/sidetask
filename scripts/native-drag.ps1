param([long]$WindowHandle, [double]$OffsetX, [double]$OffsetY, [double]$ViewportWidth, [double]$ViewportHeight, [double]$DeltaX, [double]$DeltaY, [double]$LogicalWidth, [double]$LogicalHeight)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SideTaskNativeMouse {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr handle, ref POINT point);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION input; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static bool SendMouse(int x, int y, uint flags) {
    INPUT value = new INPUT(); value.type = 0; value.input.mouse.dx = x; value.input.mouse.dy = y; value.input.mouse.flags = flags;
    return SendInput(1, new INPUT[] { value }, Marshal.SizeOf(typeof(INPUT))) == 1;
  }
}
'@
[void][SideTaskNativeMouse]::SetThreadDpiAwarenessContext([IntPtr](-4))
$handle = [IntPtr]$WindowHandle
$swapped = [SideTaskNativeMouse]::GetSystemMetrics(23) -ne 0
$downFlag = $(if ($swapped) { 8 } else { 2 })
$upFlag = $(if ($swapped) { 16 } else { 4 })
$primaryKey = $(if ($swapped) { 2 } else { 1 })
$original = New-Object SideTaskNativeMouse+POINT
$origin = New-Object SideTaskNativeMouse+POINT
$client = New-Object SideTaskNativeMouse+RECT
$before = New-Object SideTaskNativeMouse+RECT
[void][SideTaskNativeMouse]::GetCursorPos([ref]$original)
[void][SideTaskNativeMouse]::GetClientRect($handle, [ref]$client)
[void][SideTaskNativeMouse]::GetWindowRect($handle, [ref]$before)
[void][SideTaskNativeMouse]::ClientToScreen($handle, [ref]$origin)
$startX = [int]($origin.X + $OffsetX * ($client.Right - $client.Left) / $ViewportWidth)
$startY = [int]($origin.Y + $OffsetY * ($client.Bottom - $client.Top) / $ViewportHeight)
$endX = [int]($startX + $DeltaX * ($before.Right - $before.Left) / $LogicalWidth)
$endY = [int]($startY + $DeltaY * ($before.Bottom - $before.Top) / $LogicalHeight)
$virtualX = [SideTaskNativeMouse]::GetSystemMetrics(76)
$virtualY = [SideTaskNativeMouse]::GetSystemMetrics(77)
$virtualWidth = [SideTaskNativeMouse]::GetSystemMetrics(78)
$virtualHeight = [SideTaskNativeMouse]::GetSystemMetrics(79)
function Send-PointerMove([int]$x, [int]$y, [uint32]$flags = 49153) {
  $normalizedX = [uint32][Math]::Round(($x - $virtualX) * 65535.0 / ($virtualWidth - 1))
  $normalizedY = [uint32][Math]::Round(($y - $virtualY) * 65535.0 / ($virtualHeight - 1))
  if (-not [SideTaskNativeMouse]::SendMouse($normalizedX, $normalizedY, $flags)) { throw 'Windows rejected pointer input' }
}
$pressed = $false
try {
  [void][SideTaskNativeMouse]::SetWindowPos($handle, [IntPtr](-1), 0, 0, 0, 0, 67)
  $focused = [SideTaskNativeMouse]::SetForegroundWindow($handle)
  $positioned = [SideTaskNativeMouse]::SetCursorPos($startX, $startY)
  Send-PointerMove ($startX - 1) $startY
  Send-PointerMove $startX $startY
  Start-Sleep -Milliseconds 150
  $actualStart = New-Object SideTaskNativeMouse+POINT
  $cursorRead = [SideTaskNativeMouse]::GetCursorPos([ref]$actualStart)
  $clip = New-Object SideTaskNativeMouse+RECT
  [void][SideTaskNativeMouse]::GetClipCursor([ref]$clip)
  $hitWindow = [SideTaskNativeMouse]::WindowFromPoint($actualStart).ToInt64()
  $hitRoot = [SideTaskNativeMouse]::GetAncestor([IntPtr]$hitWindow, 2).ToInt64()
  if ($hitRoot -ne $WindowHandle) { throw ('Target window is covered: expected ' + $WindowHandle + ', actual root ' + $hitRoot + ', child ' + $hitWindow) }
  $packed = ($startY -shl 16) -bor ($startX -band 65535)
  $hitTest = [SideTaskNativeMouse]::SendMessage($handle, 132, [IntPtr]::Zero, [IntPtr]$packed).ToInt64()
  Start-Sleep -Milliseconds 150
  Send-PointerMove $startX $startY (49153 -bor $downFlag)
  $pressed = $true
  Start-Sleep -Milliseconds 80
  $leftPressed = [SideTaskNativeMouse]::GetAsyncKeyState($primaryKey)
  # Engage the caption drag before crossing any neighbouring no-drag controls.
  $distance = [Math]::Sqrt(($endX - $startX) * ($endX - $startX) + ($endY - $startY) * ($endY - $startY))
  $engageX = $(if ($distance -gt 24) { ($endX - $startX) * 12 / $distance } else { 0 })
  $engageY = $(if ($distance -gt 24) { ($endY - $startY) * 12 / $distance } else { 0 })
  for ($i = 1; $i -le 6; $i++) {
    Send-PointerMove ([int]($startX + $engageX * $i / 6)) ([int]($startY + $engageY * $i / 6))
    Start-Sleep -Milliseconds 25
  }
  for ($i = 1; $i -le 20; $i++) {
    Send-PointerMove ([int]($startX + $engageX + ($endX - $startX - $engageX) * $i / 20)) ([int]($startY + $engageY + ($endY - $startY - $engageY) * $i / 20))
    Start-Sleep -Milliseconds 20
  }
} finally {
  if ($pressed) { [void][SideTaskNativeMouse]::SendMouse(0, 0, $upFlag) }
  Start-Sleep -Milliseconds 120
  [void][SideTaskNativeMouse]::SetCursorPos($original.X, $original.Y)
}
$after = New-Object SideTaskNativeMouse+RECT
[void][SideTaskNativeMouse]::GetWindowRect($handle, [ref]$after)
@{ swapped=$swapped; leftPressed=$leftPressed; positioned=$positioned; cursorRead=$cursorRead; actualStart=$actualStart; clip=$clip; hitWindow=$hitWindow; hitRoot=$hitRoot; handle=$WindowHandle; hitTest=$hitTest; focused=$focused; startX=$startX; startY=$startY; endX=$endX; endY=$endY; before=$before; after=$after } | ConvertTo-Json -Compress
