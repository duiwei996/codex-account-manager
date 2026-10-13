param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot '.tmp\shortcut-regression' }
$testRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $testRoot.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Shortcut tests must use a directory inside the project.'
}
$compiler = Join-Path $projectRoot 'src-tauri\target\.tauri\NSIS\makensis.exe'
$utils = Join-Path $projectRoot 'src-tauri\target\release\nsis\x64\utils.nsh'
if (-not (Test-Path -LiteralPath $compiler) -or -not (Test-Path -LiteralPath $utils)) {
    throw 'Build the Windows NSIS installer first to provision its compiler and shortcut helpers.'
}
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$hook = Get-Content (Join-Path $projectRoot 'src-tauri\windows\installer-hooks.nsh') -Raw
# Substitute only the desktop location; run the actual production hooks against real .lnk files.
$hook.Replace('$DESKTOP', '$TestDesktop') | Set-Content (Join-Path $testRoot 'hooks.nsh') -Encoding utf8
$template = @'
Unicode true
Name "Shortcut regression"
OutFile "__OUTPUT__"
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
!include "Win\COM.nsh"
!include "__UTILS__"
!define PRODUCTNAME "Codex Account Manager"
!define MAINBINARYNAME "codex-account-manager"
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName
Var TestDesktop
!include "__HOOKS__"
Section
  StrCpy $INSTDIR "__ROOT__\app"
  StrCpy $TestDesktop "__ROOT__\desktop"
  StrCpy $OldMainBinaryName "old-manager.exe"
  StrCpy $WixMode 1
  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  !insertmacro NSIS_HOOK_PREINSTALL
  ; Same shortcut creation gate used by Tauri's installer, including MSI migration.
  ${If} $WixMode = 1
    CreateShortcut "$TestDesktop\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  ${ElseIf} $UpdateMode != 1
  ${AndIf} $NoShortcutMode != 1
    CreateShortcut "$TestDesktop\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  ${EndIf}
  !insertmacro NSIS_HOOK_POSTINSTALL
SectionEnd
'@
$exe = Join-Path $testRoot 'shortcut-test.exe'
$nsi = $template.Replace('__OUTPUT__', $exe).Replace('__UTILS__', $utils).Replace('__HOOKS__', (Join-Path $testRoot 'hooks.nsh')).Replace('__ROOT__', $testRoot)
$nsi | Set-Content (Join-Path $testRoot 'test.nsi') -Encoding utf8
& $compiler /V2 (Join-Path $testRoot 'test.nsi')
if ($LASTEXITCODE -ne 0) { throw 'NSIS shortcut test compilation failed.' }
$desktop = Join-Path $testRoot 'desktop'
$appDirectory = Join-Path $testRoot 'app'
New-Item -ItemType Directory -Path $desktop, $appDirectory -Force | Out-Null
$target = Join-Path $appDirectory 'codex-account-manager.exe'
$oldTarget = Join-Path $appDirectory 'old-manager.exe'
$unrelatedTarget = Join-Path $appDirectory 'unrelated.exe'
foreach ($path in @($target, $oldTarget, $unrelatedTarget)) { [IO.File]::WriteAllText($path, 'synthetic executable target') }
$shellObject = New-Object -ComObject WScript.Shell
function Add-TestShortcut([string]$Name, [string]$Target) {
    $link = $shellObject.CreateShortcut((Join-Path $desktop $Name))
    $link.TargetPath = $Target
    $link.Save()
}
$cases = @(
    @{ Name = 'fresh-install'; Flags = '/S'; Links = @(); Expected = @('Codex Account Manager.lnk') },
    @{ Name = 'update-without-shortcut'; Flags = '/S /UPDATE'; Links = @(); Expected = @() },
    @{ Name = 'update-keeps-canonical'; Flags = '/S /UPDATE'; Links = @('Codex Account Manager.lnk'); Expected = @('Codex Account Manager.lnk') },
    @{ Name = 'update-keeps-renamed'; Flags = '/S /UPDATE'; Links = @('我的账号管理器.lnk'); Expected = @('我的账号管理器.lnk') },
    @{ Name = 'legacy-updater-keeps-renamed'; Flags = '/S /UPDATER'; Links = @('我的账号管理器.lnk'); Expected = @('我的账号管理器.lnk') },
    @{ Name = 'reinstall-keeps-renamed'; Flags = '/S'; Links = @('我的账号管理器.lnk'); Expected = @('我的账号管理器.lnk') },
    @{ Name = 'duplicate-cleanup'; Flags = '/S /UPDATE'; Links = @('我的账号管理器.lnk', 'Codex Account Manager.lnk'); Expected = @('我的账号管理器.lnk') },
    @{ Name = 'old-binary-migration'; Flags = '/S /UPDATE'; Links = @('我的账号管理器.lnk'); Old = $true; Expected = @('我的账号管理器.lnk') }
)
foreach ($case in $cases) {
    # Verified test directory only; never enumerate or modify the user's desktop.
    $resolvedDesktop = [IO.Path]::GetFullPath($desktop)
    if (-not $resolvedDesktop.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test desktop' }
    Get-ChildItem -LiteralPath $resolvedDesktop -Filter '*.lnk' | ForEach-Object { Remove-Item -LiteralPath $_.FullName }
    foreach ($name in $case.Links) { Add-TestShortcut $name $(if ($case.Old) { $oldTarget } else { $target }) }
    Add-TestShortcut 'Unrelated.lnk' $unrelatedTarget
    $process = Start-Process -FilePath $exe -ArgumentList $case.Flags -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "Shortcut scenario failed: $($case.Name)" }
    $expected = @($case.Expected) + @('Unrelated.lnk')
    $actual = @(Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' | Select-Object -ExpandProperty Name)
    if (@(Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)).Count -ne 0) { throw "Unexpected shortcuts: $($case.Name)" }
    foreach ($name in $case.Expected) {
        $link = $shellObject.CreateShortcut((Join-Path $desktop $name))
        if ($link.TargetPath -ne $target) { throw "Incorrect migrated target: $($case.Name)" }
    }
    if ($shellObject.CreateShortcut((Join-Path $desktop 'Unrelated.lnk')).TargetPath -ne $unrelatedTarget) { throw 'Unrelated shortcut was modified' }
    Write-Output "PASS $($case.Name)"
}
Write-Output "8 shortcut scenarios passed. Evidence: $testRoot"
