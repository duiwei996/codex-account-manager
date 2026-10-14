param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot '.tmp\installer-upgrade-regression' }
$testRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $testRoot.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Tests must stay inside the project.' }
$compiler = Join-Path $projectRoot 'src-tauri\target\.tauri\NSIS\makensis.exe'
if (-not $testRoot.StartsWith((Join-Path $projectRoot '.tmp') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Test artifacts must stay inside project .tmp.' }
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$parts = $version.Split('.')
$older = if ([int]$parts[2] -gt 0) { "$($parts[0]).$($parts[1]).$([int]$parts[2] - 1)" } else { '0.0.0' }
$newer = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
$testName = 'CodexInstallerRegression-' + [Guid]::NewGuid().ToString('N')
$registryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $testName
$manufacturerKey = 'HKCU:\Software\duiwei996\' + $testName
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$testDesktop = Join-Path $testRoot 'desktop'
New-Item -ItemType Directory -Path $testDesktop -Force | Out-Null
$testHooks = Join-Path $testRoot 'installer-hooks.nsh'
$hooks = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri\windows\installer-hooks.nsh') -Raw
$hooks.Replace('$DESKTOP', $testDesktop) | Set-Content -LiteralPath $testHooks -Encoding utf8
$testInstaller = Join-Path $testRoot 'test-setup.exe'
Push-Location $projectRoot
try {
    & node scripts/prepare-windows-install-test.mjs $testName $testRoot $testHooks
    if ($LASTEXITCODE -ne 0) { throw 'Official fixture bundling failed.' }
} finally { Pop-Location }
& $compiler /V2 /INPUTCHARSET UTF8 "/DAPP_VERSION=$version" "/DPRODUCT_NAME=$testName" '/DMAIN_BINARY=fixture-manager' "/DPAYLOAD_FILE=$testRoot\official-test-setup.exe" "/DOUTPUT_FILE=$testInstaller" (Join-Path $projectRoot 'src-tauri\windows\setup-launcher.nsi')
if ($LASTEXITCODE -ne 0) { throw 'Project launcher compilation failed.' }

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
    @{ Name = 'updater-upgrade-without-uninstall'; Installed = $older; Exit = 0; Update = $true },
    @{ Name = 'same-version-reinstall-without-uninstall'; Installed = $version; Exit = 0 },
    @{ Name = 'unknown-version-update-without-uninstall'; Installed = ''; Exit = 0 },
    @{ Name = 'reject-downgrade-without-uninstall'; Installed = $newer; Exit = 1 },
    @{ Name = 'reject-inconsistent-installation'; Installed = $older; Exit = 2; Invalid = $true }
)
try {
    foreach ($case in $cases) {
        Clear-TestRegistry
        $unicodeLabel = [string][char]0x4E2D + [char]0x6587
        $installDirectory = Join-Path $testRoot ($case.Name + ' ' + $unicodeLabel + ' path with spaces')
        New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
        $sentinel = Join-Path $installDirectory 'settings-preserved.txt'
        [IO.File]::WriteAllText($sentinel, 'synthetic user settings')
        $binary = Join-Path $installDirectory 'fixture-manager.exe'
        [IO.File]::WriteAllText($binary, 'synthetic old app')
        $beforeHash = (Get-FileHash -LiteralPath $binary).Hash
        Copy-Item -LiteralPath $legacyUninstaller -Destination (Join-Path $installDirectory 'uninstall.exe')
        if ($null -ne $case.Installed) {
            New-Item -Path $registryKey -Value $testName -Force | Out-Null
            New-ItemProperty -LiteralPath $registryKey -Name Publisher -Value 'duiwei996' -PropertyType String | Out-Null
            New-ItemProperty -LiteralPath $registryKey -Name DisplayVersion -Value $case.Installed -PropertyType String | Out-Null
            New-ItemProperty -LiteralPath $registryKey -Name MainBinaryName -Value 'fixture-manager.exe' -PropertyType String | Out-Null
            $uninstallerValue = if ($case.Invalid) { 'unrelated.exe' } else { '"' + $installDirectory + '\uninstall.exe"' }
            New-ItemProperty -LiteralPath $registryKey -Name UninstallString -Value $uninstallerValue -PropertyType String | Out-Null
            New-Item -Path $manufacturerKey -Value $installDirectory -Force | Out-Null
        }
        # Exercise the generated production installer against isolated paths and registry keys.
        # /NS prevents shortcuts, and omitting /R prevents launching the application.
        $installerArguments = @('/S', '/NS')
        if ($case.Update) { $installerArguments += '/UPDATE' }
        $requestedDirectory = if ($null -ne $case.Installed) { Join-Path $testRoot 'must-not-install-here' } else { $installDirectory }
        $installerArguments += '/D=' + $requestedDirectory
        $process = Start-Process -FilePath $testInstaller -ArgumentList $installerArguments -PassThru -WindowStyle Hidden
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Isolated installer timed out.' }
        if ($process.ExitCode -ne $case.Exit) { throw "Wrong installer exit code: $($case.Name), $($process.ExitCode)" }
        if (Test-Path (Join-Path $testRoot 'must-not-install-here')) { throw 'Upgrade changed the install directory.' }
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
Write-Output "$($cases.Count) production-installer scenarios passed; existing settings preserved and old uninstaller never invoked. Evidence: $testRoot"
