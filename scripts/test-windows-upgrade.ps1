param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot '.tmp\installer-upgrade-regression' }
$testRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $testRoot.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Tests must stay inside the project.' }
$generatedRoot = Join-Path $projectRoot 'src-tauri\target\release\nsis\x64'
$compiler = Join-Path $projectRoot 'src-tauri\target\.tauri\NSIS\makensis.exe'
$source = Get-Content -LiteralPath (Join-Path $generatedRoot 'installer.nsi') -Raw
if ($source -notmatch 'Call DetectExistingNsisInstallation') { throw 'Build the new Windows installer before running this test.' }
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$parts = $version.Split('.')
$older = if ([int]$parts[2] -gt 0) { "$($parts[0]).$($parts[1]).$([int]$parts[2] - 1)" } else { '0.0.0' }
$newer = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
$testName = 'CodexInstallerRegression-' + [Guid]::NewGuid().ToString('N')
$registryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $testName
$manufacturerKey = 'HKCU:\Software\duiwei996\' + $testName
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
foreach ($name in @('utils.nsh', 'FileAssociation.nsh', 'English.nsh', 'SimpChinese.nsh')) {
    Copy-Item -LiteralPath (Join-Path $generatedRoot $name) -Destination (Join-Path $testRoot $name)
}
$testDesktop = Join-Path $testRoot 'desktop'
New-Item -ItemType Directory -Path $testDesktop -Force | Out-Null
$testHooks = Join-Path $testRoot 'installer-hooks.nsh'
$hooks = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri\windows\installer-hooks.nsh') -Raw
$hooks.Replace('$DESKTOP', $testDesktop) | Set-Content -LiteralPath $testHooks -Encoding utf8
$testInstaller = Join-Path $testRoot 'test-setup.exe'
$mainSource = [regex]::Match($source, '(?m)^!define MAINBINARYSRCPATH "([^"]+)"').Groups[1].Value
$testPayload = Join-Path $testRoot 'fixture-manager.exe'
Copy-Item -LiteralPath $mainSource -Destination $testPayload
$source = [regex]::Replace($source, '(?m)^!define PRODUCTNAME ".*"', ('!define PRODUCTNAME "' + $testName + '"'))
$source = [regex]::Replace($source, '(?m)^!define MAINBINARYNAME ".*"', '!define MAINBINARYNAME "fixture-manager"')
$source = [regex]::Replace($source, '(?m)^!define MAINBINARYSRCPATH ".*"', ('!define MAINBINARYSRCPATH "' + $testPayload + '"'))
$source = [regex]::Replace($source, '(?m)^!define BUNDLEID ".*"', '!define BUNDLEID "com.duiwei996.codex-installer-regression"')
$source = [regex]::Replace($source, '(?m)^!define OUTFILE ".*"', ('!define OUTFILE "' + $testInstaller + '"'))
$source = [regex]::Replace($source, '(?m)^!include ".*installer-hooks.nsh"', ('!include "' + $testHooks + '"'))
$source = $source.Replace('$DESKTOP', $testDesktop)
$testScript = Join-Path $testRoot 'test-installer.nsi'
$source | Set-Content -LiteralPath $testScript -Encoding utf8
& $compiler /V2 /INPUTCHARSET UTF8 $testScript
if ($LASTEXITCODE -ne 0) { throw 'Isolated installer compilation failed.' }

$legacyUninstaller = Join-Path $testRoot 'legacy-uninstall.exe'
@'
Unicode true
Name "Legacy uninstaller sentinel"
OutFile "__OUTPUT__"
RequestExecutionLevel user
SilentInstall silent
!include FileFunc.nsh
Section
  ${GetExePath} $0
  FileOpen $1 "$0\old-uninstaller-was-called.txt" w
  FileWrite $1 "FAIL"
  FileClose $1
SectionEnd
'@.Replace('__OUTPUT__', $legacyUninstaller) | Set-Content -LiteralPath (Join-Path $testRoot 'legacy.nsi') -Encoding utf8
& $compiler /V2 /INPUTCHARSET UTF8 (Join-Path $testRoot 'legacy.nsi')
if ($LASTEXITCODE -ne 0) { throw 'Uninstaller sentinel compilation failed.' }

function Clear-TestRegistry {
    foreach ($key in @($registryKey, $manufacturerKey)) {
        if ($key.EndsWith('\' + $testName) -and (Test-Path -LiteralPath $key)) { Remove-Item -LiteralPath $key -Recurse }
    }
}
$cases = @(
    @{ Name = 'fresh-install'; Installed = $null; Exit = 0 },
    @{ Name = 'upgrade-without-uninstall'; Installed = $older; Exit = 0 },
    @{ Name = 'same-version-reinstall-without-uninstall'; Installed = $version; Exit = 0 },
    @{ Name = 'unknown-version-update-without-uninstall'; Installed = ''; Exit = 0 },
    @{ Name = 'reject-downgrade-without-uninstall'; Installed = $newer; Exit = 1 }
)
try {
    foreach ($case in $cases) {
        Clear-TestRegistry
        $installDirectory = Join-Path $testRoot ($case.Name + ' path with spaces')
        New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
        $sentinel = Join-Path $installDirectory 'settings-preserved.txt'
        [IO.File]::WriteAllText($sentinel, 'synthetic user settings')
        $binary = Join-Path $installDirectory 'fixture-manager.exe'
        [IO.File]::WriteAllText($binary, 'synthetic old app')
        $beforeHash = (Get-FileHash -LiteralPath $binary).Hash
        Copy-Item -LiteralPath $legacyUninstaller -Destination (Join-Path $installDirectory 'uninstall.exe')
        if ($null -ne $case.Installed) {
            New-Item -Path $registryKey -Force | Out-Null
            New-ItemProperty -LiteralPath $registryKey -Name Publisher -Value 'duiwei996' -PropertyType String | Out-Null
            New-ItemProperty -LiteralPath $registryKey -Name DisplayVersion -Value $case.Installed -PropertyType String | Out-Null
            New-ItemProperty -LiteralPath $registryKey -Name MainBinaryName -Value 'fixture-manager.exe' -PropertyType String | Out-Null
            New-ItemProperty -LiteralPath $registryKey -Name UninstallString -Value ('"' + $installDirectory + '\uninstall.exe"') -PropertyType String | Out-Null
            New-Item -Path $manufacturerKey -Value $installDirectory -Force | Out-Null
        }
        # Exercise the generated production installer against isolated paths and registry keys.
        # /NS prevents shortcuts, and omitting /R prevents launching the application.
        $process = Start-Process -FilePath $testInstaller -ArgumentList @('/S', '/NS', ('/D=' + $installDirectory)) -PassThru -WindowStyle Hidden
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Isolated installer timed out.' }
        if ($process.ExitCode -ne $case.Exit) { throw "Wrong installer exit code: $($case.Name), $($process.ExitCode)" }
        if ([IO.File]::ReadAllText($sentinel) -ne 'synthetic user settings') { throw 'Existing settings were changed.' }
        if (Test-Path -LiteralPath (Join-Path $installDirectory 'old-uninstaller-was-called.txt')) { throw 'The old uninstaller was invoked.' }
        $storedVersion = (Get-ItemProperty -LiteralPath $registryKey).DisplayVersion
        if ($case.Exit -eq 0) {
            if ($storedVersion -ne $version) { throw 'Installed version was not updated.' }
            if ((Get-Item -LiteralPath $binary).Length -lt 1000) { throw 'Application was not replaced.' }
        } else {
            if ($storedVersion -ne $case.Installed -or (Get-FileHash -LiteralPath $binary).Hash -ne $beforeHash) { throw 'Downgrade changed the installation.' }
        }
        Write-Output "PASS $($case.Name)"
    }
} finally {
    Clear-TestRegistry
}
Write-Output "5 production-installer scenarios passed; existing settings preserved and old uninstaller never invoked. Evidence: $testRoot"
