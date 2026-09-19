param([long]$WindowHandle, [int]$X, [int]$Y)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @'
using System;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class SideTaskInputProbe : Form {
  public int Clicks, Wheels, AltMessages, MenuClicks;
  public ContextMenuStrip Popup = new ContextMenuStrip();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION input; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  public static void Mouse(uint flags, uint data) {
    INPUT value = new INPUT(); value.input.mouse.flags = flags; value.input.mouse.data = data;
    if (SendInput(1, new INPUT[] { value }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("Mouse input was rejected");
  }
  public SideTaskInputProbe() {
    Text = "SideTask input verification";
    StartPosition = FormStartPosition.Manual;
    ClientSize = new Size(260, 180);
    MouseClick += (sender, args) => { Clicks++; };
    MouseWheel += (sender, args) => { Wheels++; };
    Popup.Items.Add("Verify menu", null, (sender, args) => { MenuClicks++; });
    ContextMenuStrip = Popup;
  }
  protected override void WndProc(ref Message message) {
    if ((message.Msg == 0x104 || message.Msg == 0x105) && message.WParam.ToInt32() == 0x12) AltMessages++;
    base.WndProc(ref message);
  }
}
'@
[void][SideTaskInputProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
function Pump([int]$milliseconds) {
  $until = [DateTime]::UtcNow.AddMilliseconds($milliseconds)
  while ([DateTime]::UtcNow -lt $until) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10 }
}
$original = New-Object SideTaskInputProbe+POINT
[void][SideTaskInputProbe]::GetCursorPos([ref]$original)
$form = New-Object SideTaskInputProbe
$swapped = [SideTaskInputProbe]::GetSystemMetrics(23) -ne 0
$leftDown = $(if ($swapped) { 8 } else { 2 }); $leftUp = $(if ($swapped) { 16 } else { 4 })
$rightDown = $(if ($swapped) { 2 } else { 8 }); $rightUp = $(if ($swapped) { 4 } else { 16 })
try {
  $form.Location = New-Object System.Drawing.Point(($X - 80),($Y - 80))
  $form.Show(); Pump 150
  $point = New-Object SideTaskInputProbe+POINT; $point.X = $X; $point.Y = $Y
  $hit = [SideTaskInputProbe]::GetAncestor([SideTaskInputProbe]::WindowFromPoint($point), 2)
  if ($hit -eq [IntPtr]$WindowHandle) { throw 'SideTask intercepted a point outside its visible surface' }
  if ($hit -ne $form.Handle) { throw 'The probe is covered by another window; rerun on an unobstructed desktop' }
  [void][SideTaskInputProbe]::SetCursorPos($X,$Y)
  [SideTaskInputProbe]::Mouse($leftDown,0); [SideTaskInputProbe]::Mouse($leftUp,0); Pump 100
  [SideTaskInputProbe]::Mouse(0x0800,120); Pump 100
  [SideTaskInputProbe]::Mouse($rightDown,0); [SideTaskInputProbe]::Mouse($rightUp,0); Pump 200
  if (!$form.Popup.Visible) { throw 'The underlying window context menu did not open' }
  Pump 500
  if (!$form.Popup.Visible) { throw 'The underlying window context menu was dismissed unexpectedly' }
  $item = $form.Popup.PointToScreen((New-Object System.Drawing.Point(30,12)))
  [void][SideTaskInputProbe]::SetCursorPos($item.X,$item.Y)
  [SideTaskInputProbe]::Mouse($leftDown,0); [SideTaskInputProbe]::Mouse($leftUp,0); Pump 100
  if ($form.Clicks -lt 1 -or $form.Wheels -lt 1 -or $form.MenuClicks -ne 1 -or $form.AltMessages -ne 0) {
    throw "Input failure: clicks=$($form.Clicks) wheels=$($form.Wheels) menus=$($form.MenuClicks) alt=$($form.AltMessages)"
  }
  if ([SideTaskInputProbe]::GetForegroundWindow() -ne $form.Handle) { throw 'SideTask stole foreground activation' }
  @{clicks=$form.Clicks;wheels=$form.Wheels;menus=$form.MenuClicks;alt=$form.AltMessages} | ConvertTo-Json -Compress
} finally {
  $form.Close(); $form.Dispose()
  [void][SideTaskInputProbe]::SetCursorPos($original.X,$original.Y)
}
