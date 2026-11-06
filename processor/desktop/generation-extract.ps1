param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$package = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $archiveRoot = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    foreach ($entry in $package.Entries) {
        $entryTarget = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($archiveRoot, $entry.FullName))
        if (-not $entryTarget.StartsWith($archiveRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Archive path escapes destination'
        }
        if ($entry.FullName.Contains(':')) { throw 'Invalid archive path' }
        $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
        if ($unixType -eq 0xA000) { throw 'Archive symlinks are not supported' }
    }
} finally { $package.Dispose() }
Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
