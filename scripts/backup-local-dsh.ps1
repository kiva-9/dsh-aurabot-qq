#requires -Version 7.2
<#
.SYNOPSIS
Create a verified, independent, offline backup before replacing the Aurabot plugin.
.DESCRIPTION
Read-only access to every source. No package manager, process termination, replacement,
exclusions, size limits, hardlink creation, or recursive deletion. DataDir (including
modules, hidden files, media and earlier backups) and InstallDir are copied in full.
Only package.json, pnpm locks, YAML/config/patch entries and plugin-manager entries
are selected from ProfileDir; unrelated profile node_modules are not selected.

Directory junctions and symlinks are dereferenced; hardlinked files become independent
byte copies. Dangling links, directory cycles, unreadable files and any mismatch FAIL
the backup instead of silently skipping data. Named NTFS data streams are copied too.

OutputDir MUST NOT exist and its parent MUST exist. A failed output is left intact for
inspection. Only a valid SUCCESS.json plus its verified manifest denotes completion.
Requires Windows and PowerShell 7.2+. Run only after closing DSH and its child hosts.
The script checks DSH processes before, during and after copying; it does not stop them.

.EXAMPLE
pwsh -NoProfile -File .\scripts\backup-local-dsh.ps1 -OutputDir 'D:\Backups\aurabot-before-replace'
.EXAMPLE
pwsh -NoProfile -File .\scripts\backup-local-dsh.ps1 -ProfileDir 'C:\Users\Kiva\.dsh\profiles\desktop' -DataDir 'C:\Users\Kiva\.dsh\plugins-data\aurabot' -InstallDir 'C:\Users\Kiva\.dsh\profiles\desktop\node_modules\dsh-aurabot-qq' -OutputDir 'D:\Backups\aurabot-before-replace'
#>
[CmdletBinding()]
param(
    [string] $ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string] $DataDir = (Join-Path $env:USERPROFILE '.dsh\plugins-data\aurabot'),
    [string] $InstallDir,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string] $OutputDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:BackupRoot = $null
$script:CreatedOutput = $false
$script:ProcessCheck = [Diagnostics.Stopwatch]::StartNew()
$script:ManifestWriter = $null
$script:Watch = $null
$script:OutputId = $null
$script:WatchId = 'aurabot-backup-' + [Guid]::NewGuid().ToString('N')
$utf8 = [Text.UTF8Encoding]::new($false, $true)

# GetFinalPathNameByHandle resolves parent junctions, short-name aliases and pnpm links.
# File IDs verify that destination files do not share a hardlink with their source.
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace AurabotBackupV1 {
    public sealed class Info {
        public string Path, Id;
        public long Length, WriteTime, CreationTime;
        public uint Attributes, Links;
    }
    public sealed class DataStream { public string Suffix; public long Length; }
    public static class Native {
        [StructLayout(LayoutKind.Sequential)] struct Time { public uint Low, High; }
        [StructLayout(LayoutKind.Sequential)] struct FileInfo {
            public uint Attributes; public Time Creation, Access, Write;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StreamInfo {
            public long Length;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 296)] public string Name;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateDirectoryW(string path, IntPtr security);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr FindFirstStreamW(string path, int level, out StreamInfo info, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool FindNextStreamW(IntPtr handle, out StreamInfo info);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool FindClose(IntPtr handle);
        static long Ticks(Time t) { return ((long)t.High << 32) | t.Low; }
        static string Extended(string path) {
            if (path.StartsWith(@"\\?\")) return path;
            path = System.IO.Path.GetFullPath(path);
            return path.StartsWith(@"\\") ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path;
        }
        public static Info ReadInfo(string path) {
            using (var handle = CreateFileW(Extended(path), 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect: " + path);
                var buffer = new StringBuilder(32768);
                uint count = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
                if (count == 0 || count >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resolve: " + path);
                FileInfo data;
                if (!GetFileInformationByHandle(handle, out data)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot identify: " + path);
                string resolved = buffer.ToString();
                if (resolved.StartsWith(@"\\?\UNC\")) resolved = @"\\" + resolved.Substring(8);
                else if (resolved.StartsWith(@"\\?\")) resolved = resolved.Substring(4);
                return new Info { Path = resolved, Id = data.Volume.ToString("X8") + ":" + data.IndexHigh.ToString("X8") + data.IndexLow.ToString("X8"),
                    Length = ((long)data.SizeHigh << 32) | data.SizeLow, WriteTime = Ticks(data.Write), CreationTime = Ticks(data.Creation),
                    Attributes = data.Attributes, Links = data.Links };
            }
        }
        public static void CreateNewDirectory(string path) {
            if (!CreateDirectoryW(Extended(path), IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Output must be a new directory: " + path);
        }
        public static DataStream[] Streams(string path) {
            StreamInfo data;
            var handle = FindFirstStreamW(Extended(path), 0, out data, 0);
            if (handle == new IntPtr(-1)) {
                int error = Marshal.GetLastWin32Error();
                // Only EOF proves absence. Unsupported/inaccessible enumeration must
                // fail rather than silently omit potentially present user data.
                if (error == 38) return new DataStream[0];
                throw new Win32Exception(error, "Cannot enumerate data streams: " + path);
            }
            var result = new List<DataStream>();
            try {
                do {
                    if (data.Name != "::$DATA") {
                        if (!data.Name.StartsWith(":") || !data.Name.EndsWith(":$DATA")) throw new IOException("Unsupported stream: " + path + data.Name);
                        result.Add(new DataStream { Suffix = data.Name.Substring(0, data.Name.Length - 6), Length = data.Length });
                    }
                } while (FindNextStreamW(handle, out data));
                int error = Marshal.GetLastWin32Error();
                if (error != 38 && error != 18) throw new Win32Exception(error, "Incomplete stream enumeration: " + path);
            } finally { FindClose(handle); }
            return result.ToArray();
        }
    }
}
'@

function Get-FullDirectoryPath([string] $Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A directory parameter is empty.' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\.\') -or $full.StartsWith('\\?\')) { throw "Use a normal drive/UNC path: $Path" }
    $root = [IO.Path]::GetPathRoot($full)
    foreach ($part in $full.Substring($root.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
        if ($part.EndsWith('.') -or $part.EndsWith(' ') -or $part.Contains(':')) { throw "Ambiguous directory component: $Path" }
    }
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\') }
    return $full
}

function Test-Within([string] $Path, [string] $Root) {
    return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-OutsideSource([string] $SourcePhysical) {
    if ((Test-Within $script:OutputPhysical $SourcePhysical) -or (Test-Within $SourcePhysical $script:OutputPhysical)) {
        throw "Backup output overlaps a source (including a resolved link): $SourcePhysical"
    }
}

function Test-DshName([string] $Name) {
    return $Name -match '^(deepseek[ ._-]*harness|dsh(?:[ ._-]*(desktop|host|server|worker|cli))?)(\.exe)?$'
}

function Assert-Quiescent([switch] $Force) {
    if (-not $Force -and $script:ProcessCheck.ElapsedMilliseconds -lt 1000) { return }
    $script:ProcessCheck.Restart()
    # Catch a DSH/node host that started and exited between process snapshots too.
    foreach ($event in @(Get-Event -SourceIdentifier $script:WatchId -ErrorAction SilentlyContinue)) {
        $name = [string]$event.SourceEventArgs.NewEvent.ProcessName
        Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction Stop
        if ((Test-DshName $name) -or $name -match '^(node|electron|bun|deno)(\.exe)?$') {
            throw "A possible DSH runtime started during backup ($name). No consistent backup will be certified."
        }
    }
    foreach ($process in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
        if ($process.ProcessId -eq $PID) { continue }
        $name = [string]$process.Name
        $runtime = $name -match '^(node|electron|bun|deno)(\.exe)?$'
        $command = [string]$process.CommandLine
        $executable = [string]$process.ExecutablePath
        $isDsh = Test-DshName $name
        if ($runtime) {
            if (-not $command) { throw "Cannot inspect runtime PID $($process.ProcessId) ($name); cannot certify DSH is stopped." }
            $isDsh = $isDsh -or ($command -match '(?i)deepseek[ ._-]*harness|@deepseek-ai|[\\/]\.dsh[\\/]|[\\/]dsh(?:[.\\/\s"'']|$)')
            foreach ($source in @($ProfileDir, $DataDir, $InstallDir)) {
                $isDsh = $isDsh -or $command.Contains($source, [StringComparison]::OrdinalIgnoreCase)
            }
        }
        $isDsh = $isDsh -or ($executable -match '(?i)[\\/]DeepSeek[ ._-]*Harness[\\/]')
        if ($isDsh) { throw "DSH is still running: $name (PID $($process.ProcessId)). Close it and its child hosts before backing up." }
    }
}

function Get-Selections {
    foreach ($required in @('package.json', 'pnpm-lock.yaml')) {
        if (-not [IO.File]::Exists((Join-Path $ProfileDir $required))) { throw "Required profile file is missing: $required" }
    }
    [pscustomobject]@{ Source = $DataDir; Relative = 'data'; Recurse = $true }
    [pscustomobject]@{ Source = $InstallDir; Relative = 'install'; Recurse = $true }
    [pscustomobject]@{ Source = $ProfileDir; Relative = 'profile'; Recurse = $false }
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($ProfileDir)) {
        $name = [IO.Path]::GetFileName($entry)
        if ($name -eq 'package.json' -or $name -like 'pnpm-lock.*' -or $name -match '\.ya?ml$' -or
            $name -match '^\.?config' -or $name -match 'patch' -or $name -match '^\.?plugin[-_]?manager(?:\.|$)' -or
            $name -in @('.npmrc', '.pnpmfile.cjs') -or $name -match '^\.env(?:\.|$)') {
            [pscustomobject]@{ Source = $entry; Relative = (Join-Path 'profile' $name); Recurse = $true }
        }
    }
}

function Get-Inventory {
    $inventory = [Collections.Generic.List[object]]::new()
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $pending = [Collections.Generic.Stack[object]]::new()
    foreach ($selection in Get-Selections) {
        $pending.Push([pscustomobject]@{ Source = $selection.Source; Relative = $selection.Relative; Recurse = $selection.Recurse; Ancestors = @() })
    }
    while ($pending.Count) {
        Assert-Quiescent
        $next = $pending.Pop()
        $info = [AurabotBackupV1.Native]::ReadInfo($next.Source)
        Assert-OutsideSource $info.Path
        if (-not $paths.Add($next.Relative)) { throw "Duplicate backup path: $($next.Relative)" }
        $directory = ($info.Attributes -band 16) -ne 0
        $row = [pscustomobject]@{
            Kind = $(if ($directory) { 'directory' } else { 'file' }); Relative = $next.Relative
            Source = $next.Source; Physical = $info.Path; FileId = $info.Id; SourceLinks = $info.Links
            Length = $(if ($directory) { 0L } else { $info.Length }); WriteTime = $info.WriteTime; CreationTime = $info.CreationTime
            Attributes = [uint32][IO.File]::GetAttributes($next.Source); TargetAttributes = $info.Attributes; SHA256 = $null
        }
        $inventory.Add($row)
        foreach ($stream in [AurabotBackupV1.Native]::Streams($next.Source)) {
            $relative = $next.Relative + $stream.Suffix
            if (-not $paths.Add($relative)) { throw "Duplicate data stream: $relative" }
            $streamSource = $next.Source + $stream.Suffix
            $streamInfo = [AurabotBackupV1.Native]::ReadInfo($streamSource)
            $inventory.Add([pscustomobject]@{
                Kind = 'stream'; Relative = $relative; Source = $streamSource; Physical = $streamInfo.Path
                FileId = $streamInfo.Id; SourceLinks = $streamInfo.Links; Length = $stream.Length
                WriteTime = $streamInfo.WriteTime; CreationTime = $streamInfo.CreationTime
                Attributes = $row.Attributes; TargetAttributes = $streamInfo.Attributes; SHA256 = $null
            })
        }
        if ($directory -and $next.Recurse) {
            if ($next.Ancestors -contains $info.Id) { throw "Directory link cycle; refusing an incomplete backup: $($next.Source)" }
            $ancestors = @($next.Ancestors) + $info.Id
            foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($next.Source)) {
                $pending.Push([pscustomobject]@{
                    Source = $child; Relative = (Join-Path $next.Relative ([IO.Path]::GetFileName($child)))
                    Recurse = $true; Ancestors = $ancestors
                })
            }
        }
    }
    return ,$inventory
}

function Get-BackupPath([string] $Relative) {
    $rootInfo = [AurabotBackupV1.Native]::ReadInfo($script:BackupRoot)
    if ($rootInfo.Id -ne $script:OutputId -or $rootInfo.Path -cne $script:OutputPhysical) { throw 'Backup root was replaced or redirected.' }
    $path = [IO.Path]::GetFullPath([IO.Path]::Combine($script:BackupRoot, $Relative))
    if (-not (Test-Within $path $script:BackupRoot) -or $path -eq $script:BackupRoot) { throw "Invalid backup relative path: $Relative" }
    $parentPath = [IO.Path]::GetDirectoryName($path)
    if ([IO.Directory]::Exists($parentPath) -and -not (Test-Within ([AurabotBackupV1.Native]::ReadInfo($parentPath).Path) $script:OutputPhysical)) {
        throw "Backup parent was redirected: $Relative"
    }
    return $path
}

function Write-NewJson([string] $Path, $Value) {
    $bytes = $utf8.GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress) + "`n")
    $file = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}

function Get-StreamDigest([IO.Stream] $InputStream) {
    $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
    $buffer = [byte[]]::new(1048576)
    $length = 0L
    try {
        while (($read = $InputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $hash.AppendData($buffer, 0, $read); $length += $read
            Assert-Quiescent
        }
        return [pscustomobject]@{ Length = $length; SHA256 = [Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant() }
    } finally { $hash.Dispose() }
}

function Get-FileDigest([string] $Path) {
    $file = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 1048576, [IO.FileOptions]::SequentialScan)
    try { return Get-StreamDigest $file } finally { $file.Dispose() }
}

function Assert-SourceIdentity($Row) {
    $now = [AurabotBackupV1.Native]::ReadInfo($Row.Source)
    if ($now.Id -ne $Row.FileId -or $now.Path -cne $Row.Physical -or $now.WriteTime -ne $Row.WriteTime -or
        $now.CreationTime -ne $Row.CreationTime -or $now.Attributes -ne $Row.TargetAttributes -or
        ($Row.Kind -eq 'file' -and $now.Length -ne $Row.Length)) { throw "Source changed during backup: $($Row.Source)" }
}

function Copy-IndependentFile($Row) {
    Assert-SourceIdentity $Row
    $target = Get-BackupPath $Row.Relative
    $sourceFile = [IO.FileStream]::new($Row.Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 1048576, [IO.FileOptions]::SequentialScan)
    $targetFile = $null
    $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        if ($sourceFile.Length -ne $Row.Length) { throw "Source length changed: $($Row.Source)" }
        $targetFile = [IO.FileStream]::new($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 1048576, [IO.FileOptions]::SequentialScan)
        $buffer = [byte[]]::new(1048576)
        $length = 0L
        while (($read = $sourceFile.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $targetFile.Write($buffer, 0, $read); $hash.AppendData($buffer, 0, $read); $length += $read
            Assert-Quiescent
        }
        $targetFile.Flush($true); $targetFile.Dispose(); $targetFile = $null
        $digest = [Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant()
        $verified = Get-FileDigest $target
        $targetInfo = [AurabotBackupV1.Native]::ReadInfo($target)
        if ($length -ne $Row.Length -or $verified.Length -ne $Row.Length -or $verified.SHA256 -cne $digest -or
            $targetInfo.Id -eq $Row.FileId -or $targetInfo.Links -ne 1) { throw "Independent-copy verification failed: $($Row.Relative)" }
        Assert-SourceIdentity $Row
        $Row.SHA256 = $digest
    } finally {
        if ($null -ne $targetFile) { $targetFile.Dispose() }
        $sourceFile.Dispose(); $hash.Dispose()
    }
}

try {
    if (-not $IsWindows) { throw 'This backup script requires Windows.' }
    if (-not ('AurabotBackupV1.Native' -as [type])) { Add-Type -TypeDefinition $nativeSource -Language CSharp }
    $ProfileDir = Get-FullDirectoryPath $ProfileDir
    $DataDir = Get-FullDirectoryPath $DataDir
    if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $ProfileDir 'node_modules\dsh-aurabot-qq' }
    $InstallDir = Get-FullDirectoryPath $InstallDir
    $OutputDir = Get-FullDirectoryPath $OutputDir
    foreach ($source in @($ProfileDir, $DataDir, $InstallDir)) {
        if (-not [IO.Directory]::Exists($source)) { throw "Source directory does not exist: $source" }
    }
    if ([IO.File]::Exists($OutputDir) -or [IO.Directory]::Exists($OutputDir)) { throw "Output must not exist: $OutputDir" }
    $parent = [IO.Path]::GetDirectoryName($OutputDir)
    if (-not $parent -or -not [IO.Directory]::Exists($parent)) { throw 'The output parent directory must already exist.' }
    $script:OutputPhysical = Join-Path ([AurabotBackupV1.Native]::ReadInfo($parent).Path) ([IO.Path]::GetFileName($OutputDir))
    foreach ($source in @($ProfileDir, $DataDir, $InstallDir)) {
        if (Test-Within $OutputDir $source) { throw "Output is inside a source: $source" }
        Assert-OutsideSource ([AurabotBackupV1.Native]::ReadInfo($source).Path)
    }
    # Process-start tracing may require elevated WMI permissions. Periodic process
    # checks plus unchanged source inventory and full hash revalidation still apply.
    try { $script:Watch = Register-CimIndicationEvent -Namespace 'root/cimv2' -Query 'SELECT * FROM Win32_ProcessStartTrace' -SourceIdentifier $script:WatchId -ErrorAction Stop }
    catch { Write-Warning 'Process event subscription unavailable; using periodic process checks and complete source/hash revalidation.' }
    Assert-Quiescent -Force
    Write-Host 'Inventorying all selected files and link targets (no user-data exclusions)...'
    $inventory = Get-Inventory
    Assert-Quiescent -Force
    [AurabotBackupV1.Native]::CreateNewDirectory($OutputDir)
    $outputInfo = [AurabotBackupV1.Native]::ReadInfo($OutputDir)
    if ($outputInfo.Path -cne $script:OutputPhysical) { throw 'Output parent changed while preparing backup.' }
    $script:BackupRoot = $OutputDir; $script:OutputId = $outputInfo.Id; $script:CreatedOutput = $true
    Write-NewJson (Get-BackupPath 'backup-plan.json') ([ordered]@{
        Schema = 'aurabot.local-backup'; Version = 1; StartedAt = [DateTime]::UtcNow.ToString('O')
        ProfileDir = $ProfileDir; DataDir = $DataDir; InstallDir = $InstallDir; OutputDir = $OutputDir
        Complete = $false; SuccessMarker = 'SUCCESS.json'; Manifest = 'manifest.jsonl'
        Policy = 'Full data/install; selected profile metadata; dereferenced independent copies; SHA256 and length verified; no deletion.'
    })
    $directories = @($inventory | Where-Object Kind -EQ 'directory' | Sort-Object { $_.Relative.Length })
    foreach ($row in $directories) { [void][IO.Directory]::CreateDirectory((Get-BackupPath $row.Relative)) }
    $files = @($inventory | Where-Object Kind -EQ 'file') + @($inventory | Where-Object Kind -EQ 'stream')
    $copied = 0L
    foreach ($row in $files) {
        Copy-IndependentFile $row
        $copied++
        Write-Progress -Activity 'Copying and verifying independent files' -Status "$copied / $($files.Count)" -PercentComplete (100 * $copied / [Math]::Max(1, $files.Count))
    }
    Write-Progress -Activity 'Copying and verifying independent files' -Completed
    # Apply ordinary attributes only: compression/reparse/sparse/encryption flags are
    # recorded, while the backup is deliberately ordinary independent byte storage.
    foreach ($row in @($files | Where-Object Kind -EQ 'file') + @($directories | Sort-Object { $_.Relative.Length } -Descending)) {
        $target = Get-BackupPath $row.Relative
        if ($row.Kind -eq 'directory') {
            [IO.Directory]::SetCreationTimeUtc($target, [DateTime]::FromFileTimeUtc($row.CreationTime))
            [IO.Directory]::SetLastWriteTimeUtc($target, [DateTime]::FromFileTimeUtc($row.WriteTime))
        } else {
            [IO.File]::SetCreationTimeUtc($target, [DateTime]::FromFileTimeUtc($row.CreationTime))
            [IO.File]::SetLastWriteTimeUtc($target, [DateTime]::FromFileTimeUtc($row.WriteTime))
        }
        $attributes = $row.TargetAttributes -band (1 -bor 2 -bor 4 -bor 32 -bor 8192)
        if ($attributes -eq 0) { $attributes = 128 }
        [IO.File]::SetAttributes($target, [IO.FileAttributes]$attributes)
    }
    $manifestPath = Get-BackupPath 'manifest.jsonl'
    $manifestStream = [IO.FileStream]::new($manifestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $script:ManifestWriter = [IO.StreamWriter]::new($manifestStream, $utf8, 65536, $true)
    try {
        foreach ($row in $inventory) { $script:ManifestWriter.WriteLine(($row | ConvertTo-Json -Depth 5 -Compress)) }
        $script:ManifestWriter.Flush(); $manifestStream.Flush($true)
    } finally { $script:ManifestWriter.Dispose(); $script:ManifestWriter = $null; $manifestStream.Dispose() }
    Write-Host 'Rechecking source inventory and verifying every manifest hash against source and backup...'
    $current = Get-Inventory
    $byPath = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($row in $current) { $byPath.Add($row.Relative, $row) }
    if ($current.Count -ne $inventory.Count) { throw 'Source inventory changed during backup.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $fileCount = 0L; $directoryCount = 0L; $totalBytes = 0L
    foreach ($line in [IO.File]::ReadLines($manifestPath, $utf8)) {
        $row = $line | ConvertFrom-Json
        if (-not $seen.Add($row.Relative) -or -not $byPath.ContainsKey($row.Relative)) { throw 'Manifest contains a duplicate or missing source.' }
        $now = $byPath[$row.Relative]
        foreach ($field in @('Kind', 'Source', 'Physical', 'FileId', 'SourceLinks', 'Length', 'WriteTime', 'CreationTime', 'Attributes', 'TargetAttributes')) {
            if ($row.$field -cne $now.$field) { throw "Source/manifest mismatch ($field): $($row.Relative)" }
        }
        $target = Get-BackupPath $row.Relative
        $targetInfo = [AurabotBackupV1.Native]::ReadInfo($target)
        $targetAttributes = if ($row.Kind -eq 'stream') { $targetInfo.Attributes } else { [IO.File]::GetAttributes($target) }
        if (-not (Test-Within $targetInfo.Path $script:OutputPhysical) -or $targetInfo.Id -eq $row.FileId -or
            ($targetAttributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Destination is not independent: $($row.Relative)" }
        if ($row.Kind -eq 'directory') { $directoryCount++; continue }
        if ($row.SHA256 -cnotmatch '^[a-f0-9]{64}$' -or $targetInfo.Links -ne 1) { throw "Invalid file manifest: $($row.Relative)" }
        Assert-SourceIdentity $row
        foreach ($path in @($row.Source, $target)) {
            $verified = Get-FileDigest $path
            if ($verified.Length -ne $row.Length -or $verified.SHA256 -cne $row.SHA256) { throw "SHA256/length verification failed: $path" }
        }
        Assert-SourceIdentity $row
        $fileCount++; $totalBytes += $row.Length
    }
    if ($seen.Count -ne $inventory.Count) { throw 'Manifest verification did not cover every source entry.' }
    # Detect additions/removals/link swaps during the (potentially long) hashing pass.
    $finalInventory = Get-Inventory
    if ($finalInventory.Count -ne $current.Count) { throw 'Source inventory changed during final verification.' }
    foreach ($row in $finalInventory) {
        if (-not $byPath.ContainsKey($row.Relative)) { throw "New source entry during verification: $($row.Relative)" }
        $previous = $byPath[$row.Relative]
        foreach ($field in @('Kind', 'Source', 'Physical', 'FileId', 'SourceLinks', 'Length', 'WriteTime', 'CreationTime', 'Attributes', 'TargetAttributes')) {
            if ($row.$field -cne $previous.$field) { throw "Source changed during verification ($field): $($row.Relative)" }
        }
    }
    Assert-Quiescent -Force
    $manifestDigest = Get-FileDigest $manifestPath
    $success = [ordered]@{
        Schema = 'aurabot.local-backup'; Version = 1; Complete = $true; FinishedAt = [DateTime]::UtcNow.ToString('O')
        Manifest = 'manifest.jsonl'; ManifestSHA256 = $manifestDigest.SHA256; ManifestLength = $manifestDigest.Length
        FilesAndStreams = $fileCount; Directories = $directoryCount; TotalBytes = $totalBytes
        DshStoppedChecksPassed = $true; IndependentCopiesVerified = $true
        ProcessWatch = $(if ($null -ne $script:Watch) { 'events-and-periodic' } else { 'periodic-and-source-hash-revalidation' })
    }
    $pendingSuccess = Get-BackupPath 'SUCCESS.pending.json'
    Write-NewJson $pendingSuccess $success
    Assert-Quiescent -Force
    [IO.File]::Move($pendingSuccess, (Get-BackupPath 'SUCCESS.json'))
    try { Write-Host "VERIFIED BACKUP: $OutputDir ($fileCount files/streams, $totalBytes bytes)." } catch { }
} catch {
    $backupFailure = $_.Exception.Message
    if ($null -ne $script:ManifestWriter) { $script:ManifestWriter.Dispose(); $script:ManifestWriter = $null }
    if ($script:CreatedOutput -and $script:BackupRoot) {
        try { Write-NewJson (Get-BackupPath 'FAILED.json') ([ordered]@{ Complete = $false; FailedAt = [DateTime]::UtcNow.ToString('O'); Error = $backupFailure }) } catch {}
    }
    [Console]::Error.WriteLine('BACKUP FAILED; no successful backup is certified. ' + $backupFailure)
    [Console]::Error.WriteLine($_.ScriptStackTrace)
    exit 1
} finally {
    if ($null -ne $script:Watch) { Unregister-Event -SourceIdentifier $script:WatchId -ErrorAction SilentlyContinue }
    Get-Event -SourceIdentifier $script:WatchId -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
}
