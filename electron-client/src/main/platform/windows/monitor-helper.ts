import path from 'node:path'

/**
 * Windows 显示器控制组件：与 macOS 原生组件 ZToolsMacDisplay 使用同一 JSON 协议（list / set / sleep）。
 * 由系统自带的 Windows PowerShell 5.1 运行，C# 源码随请求经标准输入传入，命令行只带一个很短的引导脚本，
 * 不受命令行长度限制，也不在磁盘上落地临时脚本。
 *
 * 规则与 macOS 一致：
 * - 逐台枚举显示器，标识取显示器设备接口路径的 SHA-256，不用序号拼假标识；
 * - 只返回真实读到的亮度/对比度，读不到就不返回并说明原因；
 * - 调节前核对拓扑与原值，写入后读回，失败时仅在状态未被其他程序改变的情况下恢复原值；
 * - 复制（镜像）模式下无法确认独立控制目标，拒绝调节。
 */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

const BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Management, System.Web.Extensions
  $refs = @([System.Management.ManagementObject].Assembly.Location, [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location)
  Add-Type -TypeDefinition ([string]$payload.source) -ReferencedAssemblies $refs -IgnoreWarnings
  $r = $payload.request
  $ids = @(); $controls = @(); $values = @(); $expected = @()
  if ($r.action -eq 'set') { foreach ($c in @($r.changes)) { $ids += [string]$c.id; $controls += [string]$c.control; $values += [double]$c.value; $expected += [double]$c.expected } }
  [Console]::Out.Write([ZToolsWinDisplay.Helper]::Run([string]$r.action, [string]$r.topology, [string[]]$ids, [string[]]$controls, [double[]]$values, [double[]]$expected))
  exit 0
} catch {
  # 详细原因写到标准错误，便于手动运行排查；标准输出只给协议错误码
  [Console]::Error.Write(($_ | Out-String))
  $code = $_.Exception.GetBaseException().Message
  if ($code -notmatch '^DISPLAY_[A-Z_]+$') { $code = 'DISPLAY_HELPER_FAILED' }
  [Console]::Out.Write('{"version":1,"success":false,"code":"' + $code + '"}')
  exit 1
}
`

// C# 5 语法（Windows PowerShell 5.1 的 Add-Type 只支持到 C# 5）：不用 ?.、$""、out var 与表达式体成员；
// 只依赖 mscorlib、System、System.Management 与 System.Web.Extensions，不用 System.Core 里的 HashSet / Linq。
const SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace ZToolsWinDisplay {
  public static class Helper {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DISPLAY_DEVICE { public int cb; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString; public uint StateFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 1)]
    struct PHYSICAL_MONITOR { public IntPtr hPhysicalMonitor; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription; }
    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE dd, uint flags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint count);
    [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint size, [Out] PHYSICAL_MONITOR[] monitors);
    [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint size, PHYSICAL_MONITOR[] monitors);
    [DllImport("dxva2.dll")] static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr monitor, byte code, IntPtr type, out uint current, out uint maximum);
    [DllImport("dxva2.dll")] static extern bool SetVCPFeature(IntPtr monitor, byte code, uint value);

    class Display {
      public string Id, Name, Device, WmiInstance;
      public bool Primary, Mirror;
      public int Width, Height, WmiStep;
      public IntPtr Physical;
    }
    class Change { public Display Target; public string Control; public byte Code; public double Expected, Value, Tolerance; public int Maximum; }

    static void Require(bool ok, string code) { if (!ok) throw new Exception(code); }
    static string Hex(byte[] bytes) { var sb = new StringBuilder(); foreach (var b in bytes) sb.Append(b.ToString("x2")); return sb.ToString(); }
    static string Sha(string text) { using (var sha = SHA256.Create()) return Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(text))); }
    static string IdOf(string key) { var h = Sha(key.ToUpperInvariant()); return "win:" + h.Substring(0, 8) + "-" + h.Substring(8, 4) + "-" + h.Substring(12, 4) + "-" + h.Substring(16, 4) + "-" + h.Substring(20, 12); }

    static List<IntPtr> Monitors() {
      var list = new List<IntPtr>();
      MonitorEnumProc proc = delegate (IntPtr h, IntPtr hdc, IntPtr r, IntPtr d) { list.Add(h); return true; };
      Require(EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero), "DISPLAY_LIST_FAILED");
      GC.KeepAlive(proc);
      Require(list.Count < 32, "DISPLAY_LIST_FAILED");
      return list;
    }
    static MONITORINFOEX Info(IntPtr h) {
      var info = new MONITORINFOEX(); info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      Require(GetMonitorInfo(h, ref info), "DISPLAY_READ_FAILED");
      return info;
    }
    // 该显示输出上处于活动状态的显示器（接口路径）；多于一台即复制模式
    static List<DISPLAY_DEVICE> Attached(string device) {
      var result = new List<DISPLAY_DEVICE>();
      for (uint i = 0; i < 16; i++) {
        var dd = new DISPLAY_DEVICE(); dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
        if (!EnumDisplayDevices(device, i, ref dd, 1)) break;
        if ((dd.StateFlags & 1) != 0) result.Add(dd);
      }
      return result;
    }
    static uint PhysicalCount(IntPtr h) { uint count; return GetNumberOfPhysicalMonitorsFromHMONITOR(h, out count) ? count : 0; }

    public static string Topology() {
      var parts = new List<string>();
      foreach (var h in Monitors()) {
        var info = Info(h);
        var paths = new List<string>();
        foreach (var dd in Attached(info.szDevice)) paths.Add(dd.DeviceID.ToUpperInvariant());
        parts.Add(info.szDevice + "|" + string.Join(",", paths.ToArray()) + "|" + info.rcMonitor.Left + "," + info.rcMonitor.Top + "," + info.rcMonitor.Right + "," + info.rcMonitor.Bottom + "|" + info.dwFlags + "|" + PhysicalCount(h));
      }
      parts.Sort(StringComparer.Ordinal);
      return Sha(string.Join("\n", parts.ToArray()));
    }

    // \\?\DISPLAY#DEL41A6#5&1d8f&0&UID4357#{guid} 与 WMI 实例名 DISPLAY\DEL41A6\5&1d8f&0&UID4357_0 指向同一台显示器
    static string DeviceKey(string interfacePath) {
      var p = interfacePath.ToUpperInvariant();
      if (p.StartsWith("\\\\?\\")) p = p.Substring(4);
      var brace = p.LastIndexOf("#{");
      if (brace > 0) p = p.Substring(0, brace);
      return p.Replace('#', '\\');
    }
    static string InstanceKey(string instance) {
      var s = (instance ?? "").ToUpperInvariant();
      var cut = s.LastIndexOf('_');
      if (cut > 0) { var digits = true; for (var i = cut + 1; i < s.Length; i++) if (!char.IsDigit(s[i])) digits = false; if (digits && cut < s.Length - 1) s = s.Substring(0, cut); }
      return s;
    }
    // 没有该 WMI 类（台式机无内置背光）时系统报“不支持”，按没有内置屏处理；其他错误照常报告
    static ManagementObjectCollection Wmi(string query) {
      try { var c = new ManagementObjectSearcher("root\\WMI", query).Get(); return c.Count >= 0 ? c : null; }
      catch (ManagementException e) { if (e.ErrorCode == ManagementStatus.NotSupported || e.ErrorCode == ManagementStatus.InvalidClass || e.ErrorCode == ManagementStatus.NotFound) return null; throw; }
    }
    // 背光档位必须是 0..100 的等距档位，才能把百分比换算成可读回核验的档位
    static int WmiStep(byte[] levels) {
      if (levels == null || levels.Length < 2) return 0;
      var sorted = new List<int>();
      foreach (var l in levels) if (!sorted.Contains(l)) sorted.Add(l);
      sorted.Sort();
      if (sorted[0] != 0 || sorted[sorted.Count - 1] != 100) return 0;
      var step = sorted[1];
      if (step <= 0 || 100 % step != 0 || sorted.Count != 100 / step + 1) return 0;
      for (var i = 0; i < sorted.Count; i++) if (sorted[i] != i * step) return 0;
      return step;
    }

    static List<Display> Displays(List<PHYSICAL_MONITOR[]> opened) {
      var names = new Dictionary<string, string>();
      var friendly = Wmi("SELECT InstanceName, UserFriendlyName FROM WmiMonitorID");
      if (friendly != null) foreach (ManagementObject m in friendly) {
        var chars = m["UserFriendlyName"] as ushort[]; if (chars == null) continue;
        var sb = new StringBuilder(); foreach (var c in chars) { if (c == 0) break; sb.Append((char)c); }
        var name = sb.ToString().Trim(); if (name.Length > 0) names[InstanceKey((string)m["InstanceName"])] = name;
      }
      var backlight = new Dictionary<string, KeyValuePair<string, int>>();
      var brightness = Wmi("SELECT InstanceName, Level, Active FROM WmiMonitorBrightness");
      if (brightness != null) foreach (ManagementObject m in brightness) {
        if (m["Active"] is bool && !(bool)m["Active"]) continue;
        var instance = (string)m["InstanceName"];
        backlight[InstanceKey(instance)] = new KeyValuePair<string, int>(instance, WmiStep(m["Level"] as byte[]));
      }
      var result = new List<Display>(); var ids = new Dictionary<string, bool>(); var index = 0;
      foreach (var h in Monitors()) {
        index++;
        var info = Info(h); var attached = Attached(info.szDevice); var physical = PhysicalCount(h);
        var path = attached.Count > 0 ? attached[0].DeviceID : "";
        var d = new Display();
        d.Device = info.szDevice; d.Primary = (info.dwFlags & 1) != 0;
        d.Width = info.rcMonitor.Right - info.rcMonitor.Left; d.Height = info.rcMonitor.Bottom - info.rcMonitor.Top;
        d.Id = IdOf(path.Length > 0 ? path : info.szDevice);
        Require(!ids.ContainsKey(d.Id), "DISPLAY_ID_AMBIGUOUS"); ids[d.Id] = true;
        d.Mirror = attached.Count > 1 || physical > 1;
        var key = path.Length > 0 ? DeviceKey(path) : "";
        string name;
        d.Name = key.Length > 0 && names.TryGetValue(key, out name) ? name : (attached.Count > 0 && attached[0].DeviceString.Trim().Length > 0 ? attached[0].DeviceString.Trim() : "显示器 " + index);
        KeyValuePair<string, int> wmi;
        if (key.Length > 0 && backlight.TryGetValue(key, out wmi)) { d.WmiInstance = wmi.Key; d.WmiStep = wmi.Value; }
        if (!d.Mirror && d.WmiInstance == null && physical == 1) {
          var arr = new PHYSICAL_MONITOR[1];
          if (GetPhysicalMonitorsFromHMONITOR(h, 1, arr)) { opened.Add(arr); d.Physical = arr[0].hPhysicalMonitor; }
        }
        result.Add(d);
      }
      return result;
    }

    static bool Vcp(IntPtr monitor, byte code, out uint current, out uint maximum) {
      current = 0; maximum = 0;
      if (monitor == IntPtr.Zero) return false;
      // DDC/CI 偶发无应答，短暂重试后仍失败才判定不可读
      for (var attempt = 0; attempt < 3; attempt++) {
        if (GetVCPFeatureAndVCPFeatureReply(monitor, code, IntPtr.Zero, out current, out maximum) && maximum > 0 && maximum <= 65535 && current <= maximum) return true;
        Thread.Sleep(50);
      }
      return false;
    }
    static int WmiCurrent(string instance) {
      var rows = Wmi("SELECT InstanceName, CurrentBrightness FROM WmiMonitorBrightness");
      Require(rows != null, "DISPLAY_DISCONNECTED");
      foreach (ManagementObject m in rows) if (string.Equals((string)m["InstanceName"], instance, StringComparison.OrdinalIgnoreCase)) return Convert.ToInt32(m["CurrentBrightness"]);
      throw new Exception("DISPLAY_DISCONNECTED");
    }
    static double Read(Change c) {
      if (c.Target.WmiInstance != null) return WmiCurrent(c.Target.WmiInstance);
      uint current, maximum;
      Require(Vcp(c.Target.Physical, c.Code, out current, out maximum), "DISPLAY_READ_FAILED");
      Require((int)maximum == c.Maximum, "DISPLAY_STATE_CHANGED");
      return 100.0 * current / maximum;
    }
    static void Write(Change c, double percent) {
      if (c.Target.WmiInstance != null) {
        var rows = new ManagementObjectSearcher("root\\WMI", "SELECT * FROM WmiMonitorBrightnessMethods").Get(); var found = false;
        foreach (ManagementObject m in rows) {
          if (!string.Equals((string)m["InstanceName"], c.Target.WmiInstance, StringComparison.OrdinalIgnoreCase)) continue;
          var args = m.GetMethodParameters("WmiSetBrightness"); args["Timeout"] = (uint)1; args["Brightness"] = (byte)Math.Round(percent);
          m.InvokeMethod("WmiSetBrightness", args, null); found = true;
        }
        Require(found, "DISPLAY_DISCONNECTED");
      } else {
        Require(SetVCPFeature(c.Target.Physical, c.Code, (uint)Math.Round(percent * c.Maximum / 100)), "DISPLAY_WRITE_FAILED");
      }
      // 显示器需要时间应用新值：最多等 1.5 秒，读回一致即返回，仍不一致交给调用方判定
      for (var i = 0; i < 15; i++) {
        Thread.Sleep(100);
        try { if (Math.Abs(Read(c) - percent) <= c.Tolerance) return; } catch (Exception) { }
      }
    }

    static Dictionary<string, object> Describe(Display d) {
      var o = new Dictionary<string, object>();
      o["id"] = d.Id; o["name"] = d.Name; o["isPrimary"] = d.Primary; o["builtIn"] = d.WmiInstance != null;
      o["width"] = d.Width; o["height"] = d.Height;
      var canBrightness = false; var canContrast = false; string reason = null;
      if (d.Mirror) { reason = "复制模式下无法确认独立控制目标，请改为扩展模式后重新扫描"; }
      else if (d.WmiInstance != null) {
        if (d.WmiStep > 0) { o["brightness"] = (double)WmiCurrent(d.WmiInstance); canBrightness = true; }
        else reason = "系统背光档位不规则，无法核验调节结果";
      } else {
        uint current, maximum;
        if (Vcp(d.Physical, 0x10, out current, out maximum)) { o["brightness"] = 100.0 * current / maximum; canBrightness = true; }
        if (Vcp(d.Physical, 0x12, out current, out maximum)) { o["contrast"] = 100.0 * current / maximum; canContrast = true; }
        if (!canBrightness) reason = "未能读取硬件亮度；显示器可能未开启 DDC/CI，或转接线、扩展坞不支持";
      }
      o["protocol"] = canBrightness || canContrast ? (d.WmiInstance != null ? "wmi" : "ddcci") : "unsupported";
      o["canBrightness"] = canBrightness; o["canContrast"] = canContrast;
      if (reason != null) o["reason"] = reason;
      return o;
    }

    static List<double> Apply(List<Change> changes, string topology) {
      var before = new List<double>(); var after = new List<double>();
      foreach (var c in changes) { var v = Read(c); Require(Math.Abs(v - c.Expected) <= c.Tolerance, "DISPLAY_STATE_CHANGED"); before.Add(v); }
      var touched = 0;
      try {
        for (var i = 0; i < changes.Count; i++) {
          Require(Topology() == topology, "DISPLAY_STATE_CHANGED");
          Require(Math.Abs(Read(changes[i]) - before[i]) <= changes[i].Tolerance, "DISPLAY_STATE_CHANGED");
          touched = i + 1; // 写入失败也可能已经生效，仍须尝试恢复这一台
          Write(changes[i], changes[i].Value);
          var v = Read(changes[i]);
          Require(Math.Abs(v - changes[i].Value) <= changes[i].Tolerance, "DISPLAY_READBACK_MISMATCH");
          after.Add(v);
        }
        return after;
      } catch (Exception) {
        if (touched == 0) throw;
        var restored = true;
        while (touched > 0) {
          var i = --touched; var c = changes[i];
          try {
            var current = Read(c);
            if (Math.Abs(current - before[i]) <= c.Tolerance) continue;
            // 已被用户、系统自动亮度或其他程序改动时不覆盖，交给重新扫描确认
            if (Math.Abs(current - c.Value) > c.Tolerance) { restored = false; continue; }
            Write(c, before[i]);
            restored = restored && Math.Abs(Read(c) - before[i]) <= c.Tolerance;
          } catch (Exception) { restored = false; }
        }
        throw new Exception(restored ? "DISPLAY_WRITE_FAILED_RESTORED" : "DISPLAY_WRITE_OUTCOME_UNKNOWN");
      }
    }

    public static string Run(string action, string topology, string[] ids, string[] controls, double[] values, double[] expected) {
      var json = new JavaScriptSerializer();
      var output = new Dictionary<string, object>(); output["version"] = 1; output["success"] = true;
      if (action == "sleep") {
        // SC_MONITORPOWER=2 关闭显示器；系统只回报是否接受了请求，不能确认屏幕已熄灭
        Require(PostMessage(new IntPtr(0xffff), 0x0112, new IntPtr(0xF170), new IntPtr(2)), "DISPLAY_SLEEP_REJECTED");
        output["requested"] = true;
        return json.Serialize(output);
      }
      Require(action == "list" || action == "set", "DISPLAY_REQUEST_INVALID");
      var opened = new List<PHYSICAL_MONITOR[]>();
      try {
        var current = Topology();
        if (action == "list") {
          var list = new List<object>();
          foreach (var d in Displays(opened)) list.Add(Describe(d));
          Require(current == Topology(), "DISPLAY_STATE_CHANGED");
          output["displays"] = list; output["topology"] = current;
          return json.Serialize(output);
        }
        Require(current == topology, "DISPLAY_STATE_CHANGED");
        Require(ids.Length >= 1 && ids.Length <= 16 && controls.Length == ids.Length && values.Length == ids.Length && expected.Length == ids.Length, "DISPLAY_REQUEST_INVALID");
        var displays = Displays(opened); var changes = new List<Change>(); var seen = new Dictionary<string, bool>();
        for (var i = 0; i < ids.Length; i++) {
          Require(!seen.ContainsKey(ids[i] + ":" + controls[i]) && (controls[i] == "brightness" || controls[i] == "contrast") && values[i] >= 0 && values[i] <= 100 && expected[i] >= 0 && expected[i] <= 100, "DISPLAY_REQUEST_INVALID");
          seen[ids[i] + ":" + controls[i]] = true;
          Display target = null; foreach (var d in displays) if (d.Id == ids[i]) target = d;
          Require(target != null, "DISPLAY_DISCONNECTED");
          Require(!target.Mirror, "DISPLAY_MIRROR_UNSUPPORTED");
          var c = new Change(); c.Target = target; c.Control = controls[i]; c.Code = (byte)(controls[i] == "brightness" ? 0x10 : 0x12); c.Expected = expected[i];
          if (target.WmiInstance != null) {
            Require(c.Code == 0x10 && target.WmiStep > 0, "DISPLAY_CONTROL_UNAVAILABLE");
            c.Maximum = 100 / target.WmiStep;
          } else {
            uint cur, max;
            Require(Vcp(target.Physical, c.Code, out cur, out max), "DISPLAY_CONTROL_UNAVAILABLE");
            c.Maximum = (int)max;
          }
          c.Tolerance = Math.Min(2.0, 10.0 / c.Maximum);
          c.Value = Math.Round(values[i] * c.Maximum / 100) * 100 / c.Maximum;
          changes.Add(c);
        }
        var applied = Apply(changes, current);
        var changed = new List<object>();
        for (var i = 0; i < changes.Count; i++) {
          var o = new Dictionary<string, object>(); o["id"] = changes[i].Target.Id; o["control"] = changes[i].Control; o["value"] = applied[i]; o["maximum"] = changes[i].Maximum;
          changed.Add(o);
        }
        output["changed"] = changed;
        return json.Serialize(output);
      } finally {
        foreach (var arr in opened) DestroyPhysicalMonitors((uint)arr.Length, arr);
      }
    }
  }
}
`

export function windowsMonitorInvocation(request: Record<string, unknown>) {
  return {
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(BOOTSTRAP, 'utf16le').toString('base64')],
    input: JSON.stringify({ request, source: SOURCE })
  }
}
