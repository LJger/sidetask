param(
  [Parameter(Mandatory=$true)][string]$Ffmpeg,
  [Parameter(Mandatory=$true)][string]$Output,
  [Parameter(Mandatory=$true)][string]$StopFile,
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][int]$Width,
  [Parameter(Mandatory=$true)][int]$Height,
  [ValidateRange(1,120)][int]$Fps = 60
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public class SideTaskRecording {
  public int frames;
  public double elapsedMs;
  public double maxGapMs;
  public double averageFps;
}

public static class SideTaskDesktopRecorder {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

  public static SideTaskRecording Record(string ffmpeg, string output, string stopFile, int x, int y, int width, int height, int fps) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var info = new ProcessStartInfo(ffmpeg,
      "-hide_banner -loglevel error -f image2pipe -r " + fps +
      " -c:v mjpeg -i pipe:0 -an -c:v libvpx -deadline realtime -cpu-used 5 -crf 8 -b:v 1500k -y \"" + output + "\"");
    info.UseShellExecute = false;
    info.CreateNoWindow = true;
    info.RedirectStandardInput = true;
    info.RedirectStandardError = true;
    var report = new SideTaskRecording();
    using (var encoder = Process.Start(info)) {
      var errors = encoder.StandardError.ReadToEndAsync();
      try {
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb))
        using (var graphics = Graphics.FromImage(bitmap))
        using (var jpeg = new MemoryStream())
        using (var timestamps = new StreamWriter(output + ".frames.csv")) {
          var clock = Stopwatch.StartNew();
          double previous = 0;
          timestamps.WriteLine("frame,elapsedMs");
          Console.WriteLine("SIDETASK_RECORD_READY");
          Console.Out.Flush();
          while (!File.Exists(stopFile) && clock.ElapsedMilliseconds < 900000) {
            if (encoder.HasExited) throw new Exception("Desktop video encoder exited: " + errors.Result);
            double now = clock.Elapsed.TotalMilliseconds;
            if (report.frames > 0) report.maxGapMs = Math.Max(report.maxGapMs, now - previous);
            previous = now;
            // Capture the composited desktop, including native non-client pixels.
            // WebDriver screenshots contain only the WebView and cannot show this bug.
            graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            jpeg.SetLength(0);
            bitmap.Save(jpeg, ImageFormat.Jpeg);
            encoder.StandardInput.BaseStream.Write(jpeg.GetBuffer(), 0, (int)jpeg.Length);
            timestamps.WriteLine(report.frames + "," + now.ToString("F3", CultureInfo.InvariantCulture));
            report.frames++;
            int wait = (int)(report.frames * 1000.0 / fps - clock.Elapsed.TotalMilliseconds);
            if (wait > 0) Thread.Sleep(wait);
          }
          report.elapsedMs = clock.Elapsed.TotalMilliseconds;
          report.averageFps = report.frames * 1000.0 / Math.Max(1, report.elapsedMs);
        }
      } finally {
        encoder.StandardInput.Close();
        if (!encoder.WaitForExit(15000)) { encoder.Kill(); throw new Exception("Desktop video encoder did not finish"); }
      }
      if (encoder.ExitCode != 0) throw new Exception(errors.Result);
    }
    return report;
  }
}
'@
$result = [SideTaskDesktopRecorder]::Record($Ffmpeg, $Output, $StopFile, $X, $Y, $Width, $Height, $Fps)
Write-Output ('SIDETASK_RECORD:' + ($result | ConvertTo-Json -Compress))
