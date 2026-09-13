param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$DialogTitle, [string]$FilePath, [string]$ButtonName)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class SideTaskDialogWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint type);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd, EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wparam, string text);
  [DllImport("user32.dll", EntryPoint="SendMessageW")] public static extern IntPtr SendCommand(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
  public static bool SetFileName(IntPtr dialog, string path) {
    IntPtr edit = IntPtr.Zero;
    EnumChildWindows(dialog, (hwnd, data) => {
      var name = new StringBuilder(128); GetClassName(hwnd, name, name.Capacity);
      if (name.ToString() == "Edit" && (GetDlgCtrlID(hwnd) == 1152 || GetDlgCtrlID(hwnd) == 1001)) edit = hwnd;
      return true;
    }, IntPtr.Zero);
    if (edit == IntPtr.Zero) return false;
    SendMessage(edit, 12, IntPtr.Zero, path);
    return true;
  }
  public static string DescribeControls(IntPtr dialog) {
    var names = new List<string>();
    EnumChildWindows(dialog, (hwnd, data) => { var name=new StringBuilder(128); GetClassName(hwnd,name,name.Capacity);
      if (name.ToString().Contains("Edit") || name.ToString().Contains("Combo")) names.Add(GetDlgCtrlID(hwnd)+":"+name);
      return true; }, IntPtr.Zero);
    return String.Join("; ",names);
  }
  public static IntPtr FindDialog(int pid, IntPtr owner, string title) {
    IntPtr result = IntPtr.Zero;
    EnumWindows((hwnd, data) => {
      uint actual; GetWindowThreadProcessId(hwnd, out actual);
      if (actual != pid && GetWindow(hwnd, 4) != owner) return true;
      var text = new StringBuilder(512); GetWindowText(hwnd, text, text.Capacity);
      if (text.ToString() == title) { result = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return result;
  }
  public static string Describe(int pid) {
    var names = new List<string>();
    EnumWindows((hwnd, data) => { uint actual; GetWindowThreadProcessId(hwnd, out actual);
      if (actual == pid) { var text = new StringBuilder(512); GetWindowText(hwnd,text,text.Capacity); if (text.Length > 0) names.Add(text.ToString()); }
      return true; }, IntPtr.Zero);
    return String.Join("; ",names);
  }
}
'@
$processName = [System.IO.Path]::GetFileNameWithoutExtension($Executable)
$target = @(Get-Process -Name $processName | Where-Object { $_.Path -eq $Executable })[0]
if (-not $target) { throw 'Test application is not running' }
$conditions = [System.Windows.Automation.AndCondition]::new(
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$target.Id),
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $DialogTitle))
$root = [System.Windows.Automation.AutomationElement]::RootElement
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$dialog = $null
while ([DateTime]::UtcNow -lt $deadline) {
  $handle = [SideTaskDialogWindow]::FindDialog($target.Id, $target.MainWindowHandle, $DialogTitle)
  if ($handle -ne [IntPtr]::Zero) { $dialog = [System.Windows.Automation.AutomationElement]::FromHandle($handle) }
  if ($dialog) { break }
  Start-Sleep -Milliseconds 100
}
if (-not $dialog) { throw ('Native dialog did not open: ' + $DialogTitle + '; windows: ' + [SideTaskDialogWindow]::Describe($target.Id)) }
[void][SideTaskDialogWindow]::SetForegroundWindow([IntPtr]$dialog.Current.NativeWindowHandle)
if ($FilePath) {
  $set = $false
  $controlsDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not $set -and [DateTime]::UtcNow -lt $controlsDeadline) {
    if ([SideTaskDialogWindow]::SetFileName($handle, $FilePath)) {
      Start-Sleep -Milliseconds 150
      [void][SideTaskDialogWindow]::SendCommand($handle, 273, [IntPtr]1, [IntPtr]::Zero)
      Write-Output 'Native file dialog accepted'
      exit 0
    }
    foreach ($id in @('1001','1148','FileNameControlHost')) {
      $elements = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$id))
      foreach ($element in $elements) {
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
          $pattern.SetValue($FilePath); $set = $true; break
        }
      }
      if ($set) { break }
    }
    if (-not $set) { Start-Sleep -Milliseconds 100 }
  }
  if (-not $set) {
    $controls = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $descriptions = @($controls | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox } | ForEach-Object { $_.Current.AutomationId + ':' + $_.Current.ClassName + ':' + $_.Current.Name })
    throw ('Could not locate the file-name control: ' + ($descriptions -join '; ') + '; native: ' + [SideTaskDialogWindow]::DescribeControls($handle))
  }
}
$buttonCondition = $(if ($ButtonName) {
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$ButtonName)
} else {
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1')
})
$button = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
if (-not $button) { throw 'Could not locate the native confirmation button' }
$invoke = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
Write-Output 'Native dialog accepted'
