$ErrorActionPreference = 'Stop'
$versions = @()
foreach ($key in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Account Manager',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Account Manager',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Codex Account Manager'
)) {
    if (Test-Path -LiteralPath $key) {
        $entry = Get-ItemProperty -LiteralPath $key
        if ($entry.Publisher -eq 'duiwei996' -and $entry.DisplayVersion) { $versions += [string]$entry.DisplayVersion }
    }
}
ConvertTo-Json -InputObject @($versions) -Compress
