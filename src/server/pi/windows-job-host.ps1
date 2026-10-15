$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AgentMeldPiJob {
  public static string Stage = "initialize";
  static void At(string stage) {
    Stage = stage;
    Console.Out.WriteLine("{\"type\":\"agentmeld_host_stage\",\"stage\":\"" + stage + "\"}");
    Console.Out.Flush();
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size;
    public string Reserved, Desktop, Title;
    public uint X,Y,Width,Height,CharsX,CharsY,Fill,Flags;
    public short Show, ReservedBytes;
    public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool PeekNamedPipe(IntPtr handle, IntPtr buffer, uint size, IntPtr read, out uint available, IntPtr left);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var text = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { text.Append('\\', slashes * 2 + 1); text.Append(c); }
      else { text.Append('\\', slashes); text.Append(c); }
      slashes = 0;
    }
    text.Append('\\', slashes * 2); text.Append('"');
    return text.ToString();
  }
  static void DrainJob(IntPtr job) {
    Check(TerminateJobObject(job, 1));
    for (int n = 0; n < 500; n++) {
      Accounting info;
      Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      if (info.Active == 0) return;
      Thread.Sleep(10);
    }
    throw new Exception("Native job exit could not be confirmed.");
  }
  public static void Run(string node, string[] args, string cwd, string[] names, string[] values) {
    At("create_job");
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Check(job != IntPtr.Zero);
    ProcessInfo child = new ProcessInfo();
    bool assigned = false;
    try {
      At("configure_job");
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      var startup = new Startup();
      startup.Size = Marshal.SizeOf(typeof(Startup));
      startup.Flags = 0x100;
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      At("inherit_handles");
      Check(SetHandleInformation(startup.Input, 1, 1));
      Check(SetHandleInformation(startup.Output, 1, 1));
      Check(SetHandleInformation(startup.Error, 1, 1));
      var command = new StringBuilder(Quote(node));
      foreach (string arg in args) command.Append(" ").Append(Quote(arg));
      At("create_child");
      var environment = new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      for (int n = 0; n < names.Length; n++) environment[names[n]] = values[n];
      var block = new StringBuilder();
      foreach (var entry in environment) block.Append(entry.Key).Append("=").Append(entry.Value).Append('\0');
      block.Append('\0');
      IntPtr environmentBlock = Marshal.StringToHGlobalUni(block.ToString());
      try {
        // CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED.
        Check(CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000404, environmentBlock, cwd, ref startup, out child));
      } finally { Marshal.FreeHGlobal(environmentBlock); }
      At("assign_job");
      Check(AssignProcessToJobObject(job, child.Process));
      assigned = true;
      Check(ResumeThread(child.Thread) != UInt32.MaxValue);
      At("running");
      DateTime? eof = null;
      while (WaitForSingleObject(child.Process, 50) == 258) {
        uint available;
        if (!PeekNamedPipe(startup.Input, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero)) {
          int error = Marshal.GetLastWin32Error();
          if (error != 109 && error != 232) throw new Win32Exception(error);
          if (!eof.HasValue) eof = DateTime.UtcNow;
          // Give Pi a brief opportunity to flush its native session on EOF.
          if ((DateTime.UtcNow - eof.Value).TotalMilliseconds >= 500) break;
        }
      }
      uint code;
      Check(GetExitCodeProcess(child.Process, out code));
      At("drain_job");
      DrainJob(job);
      Console.Out.WriteLine("{\"type\":\"agentmeld_process_exit\",\"code\":" + code + "}");
      Console.Out.Flush();
    } finally {
      if (child.Process != IntPtr.Zero && !assigned) { TerminateProcess(child.Process, 1); WaitForSingleObject(child.Process, 5000); }
      CloseHandle(job);
      if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
      if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
    }
  }
}
'@
try {
  Add-Type -TypeDefinition $source -ErrorAction Stop
  $environment = $env:AGENTMELD_PI_NODE_ENV | ConvertFrom-Json
  $names = [string[]]@($environment.PSObject.Properties.Name)
  $values = [string[]]@($environment.PSObject.Properties.Value)
  [AgentMeldPiJob]::Run($env:AGENTMELD_PI_NODE_BINARY, [string[]]($env:AGENTMELD_PI_NODE_ARGV | ConvertFrom-Json), (Get-Location).Path, $names, $values)
  exit 0
} catch {
  $stage = 'compile'
  if ('AgentMeldPiJob' -as [type]) { $stage = [AgentMeldPiJob]::Stage }
  $failure = $_.Exception
  while ($failure.InnerException) { $failure = $failure.InnerException }
  $code = 0
  if ($failure -is [System.ComponentModel.Win32Exception]) { $code = $failure.NativeErrorCode }
  [Console]::Out.WriteLine('{"type":"agentmeld_host_error","stage":"' + $stage + '","code":' + $code + '}')
  [Console]::Error.WriteLine('AgentMeld Windows Pi job startup or cleanup failed.')
  exit 126
}
