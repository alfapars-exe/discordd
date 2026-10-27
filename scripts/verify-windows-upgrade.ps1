param(
    [Parameter(Mandatory = $true)]
    [string] $CurrentInstaller,

    [Parameter(Mandatory = $true)]
    [string] $PreviousVersion
)

$ErrorActionPreference = 'Stop'

function Get-ManifestValue {
    param(
        [Parameter(Mandatory = $true)][string] $Text,
        [Parameter(Mandatory = $true)][string] $Key
    )

    $match = [regex]::Match($Text, "(?m)^$([regex]::Escape($Key)):\s*([^\r\n]+)\s*$")
    if (-not $match.Success) {
        throw "Update manifest is missing '$Key'."
    }
    return $match.Groups[1].Value.Trim().Trim("'").Trim('"')
}

function Assert-UnderRunnerTemp {
    param([Parameter(Mandatory = $true)][string] $Path)

    $runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $prefix = $runnerTemp + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside RUNNER_TEMP: $fullPath"
    }
    return $fullPath
}

function Invoke-SilentInstaller {
    param(
        [Parameter(Mandatory = $true)][string] $InstallerPath,
        [Parameter(Mandatory = $true)][string] $InstallPath,
        [Parameter(Mandatory = $true)][string] $Label
    )

    $resolvedInstaller = [IO.Path]::GetFullPath($InstallerPath)
    $resolvedInstallPath = Assert-UnderRunnerTemp -Path $InstallPath
    if (-not (Test-Path -LiteralPath $resolvedInstaller -PathType Leaf)) {
        throw "$Label installer not found: $resolvedInstaller"
    }

    # NSIS requires /D= to be the final argument. Keep it last so the custom
    # install directory is honored by the silent installer.
    $process = Start-Process -FilePath $resolvedInstaller `
        -ArgumentList @('/S', "/D=$resolvedInstallPath") `
        -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(180000)) {
        $process.Kill($true)
        throw "$Label installer exceeded the 180-second timeout."
    }
    if ($process.ExitCode -ne 0) {
        throw "$Label installer exited with code $($process.ExitCode)."
    }
    Write-Host "$Label installer completed with exit code 0."
}

function Assert-InstalledVersion {
    param(
        [Parameter(Mandatory = $true)][string] $InstallPath,
        [Parameter(Mandatory = $true)][string] $ExpectedVersion
    )

    $exePath = Join-Path $InstallPath 'HiChat.exe'
    if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
        throw "Installed application executable is missing: $exePath"
    }
    $actualVersion = (Get-Item -LiteralPath $exePath).VersionInfo.ProductVersion
    if ($actualVersion -ne $ExpectedVersion) {
        throw "Expected installed version $ExpectedVersion, got '$actualVersion'."
    }
    Write-Host "Installed HiChat.exe version verified: $actualVersion"
}

function Assert-CurrentPackage {
    param([Parameter(Mandatory = $true)][string] $InstallPath)

    $expectedCopyright = [string][char]0x00A9 + ' 2026 HiChat!'
    $actualCopyright = (Get-Item -LiteralPath (Join-Path $InstallPath 'HiChat.exe')).VersionInfo.LegalCopyright
    if ($actualCopyright -ne $expectedCopyright) {
        throw 'Installed executable copyright metadata is not valid UTF-8 source text.'
    }
    Write-Host 'Installed copyright metadata verified.'

    $resourceRoot = Join-Path $InstallPath 'resources'
    $updateConfig = Join-Path $resourceRoot 'app-update.yml'
    if (-not (Test-Path -LiteralPath $updateConfig -PathType Leaf)) {
        throw "Installed updater configuration is missing: $updateConfig"
    }
    $configText = Get-Content -LiteralPath $updateConfig -Raw
    if ($configText -notmatch '(?m)^provider:\s*generic\s*$' -or
        $configText -notmatch '(?m)^url:\s*https://huggingface\.co/datasets/infinayazilim/hichat-releases/resolve/main/\s*$') {
        throw 'Installed updater configuration does not point to the expected Hugging Face Dataset feed.'
    }

    foreach ($helper in @('audio-capture.exe', 'game-window.exe')) {
        $helperPath = Join-Path $resourceRoot "native\$helper"
        if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf) -or (Get-Item -LiteralPath $helperPath).Length -le 0) {
            throw "Installed native helper is missing or empty: $helperPath"
        }
        Write-Host "Installed native helper verified: $helper"
    }
}

. (Join-Path $PSScriptRoot 'windows-upgrade-runner-guard.ps1')
Assert-GitHubHostedWindowsRunner `
    -GitHubActions $env:GITHUB_ACTIONS `
    -RunnerEnvironment $env:RUNNER_ENVIRONMENT `
    -RunnerOS $env:RUNNER_OS `
    -RunnerTemp $env:RUNNER_TEMP `
    -IsWindowsHost $IsWindows

$currentVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
if ($currentVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw 'Current desktop package version is invalid.'
}

$resolvedTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
$workRoot = Assert-UnderRunnerTemp -Path (Join-Path $resolvedTemp ("hichat-upgrade-smoke-" + [guid]::NewGuid().ToString('N')))
$installRoot = Assert-UnderRunnerTemp -Path (Join-Path $workRoot 'install')
$oldInstaller = Assert-UnderRunnerTemp -Path (Join-Path $workRoot 'hichat-previous.exe')
$oldManifestPath = Assert-UnderRunnerTemp -Path (Join-Path $workRoot 'latest-previous.yml')

New-Item -ItemType Directory -Path $workRoot | Out-Null

$releaseBase = $env:GITHUB_SERVER_URL
if ([string]::IsNullOrWhiteSpace($releaseBase)) {
    $releaseBase = 'https://github.com'
}
$releaseBase = $releaseBase.TrimEnd('/')
$previousTag = "v$PreviousVersion"
$previousReleaseUrl = "$releaseBase/$env:GITHUB_REPOSITORY/releases/download/$previousTag"

Write-Host "Downloading pinned legacy installer $previousTag from the public GitHub release."
Invoke-WebRequest -Uri "$previousReleaseUrl/hichat-setup.exe" -OutFile $oldInstaller -TimeoutSec 120 -MaximumRetryCount 2 -RetryIntervalSec 3
Invoke-WebRequest -Uri "$previousReleaseUrl/latest.yml" -OutFile $oldManifestPath -TimeoutSec 120 -MaximumRetryCount 2 -RetryIntervalSec 3

$oldManifest = Get-Content -LiteralPath $oldManifestPath -Raw
$manifestVersion = Get-ManifestValue -Text $oldManifest -Key 'version'
if ($manifestVersion -ne $PreviousVersion) {
    throw "Previous release manifest version mismatch: expected $PreviousVersion, got '$manifestVersion'."
}
$expectedOldHash = Get-ManifestValue -Text $oldManifest -Key 'sha512'
$actualOldHash = [Convert]::ToBase64String([Security.Cryptography.SHA512]::HashData([IO.File]::ReadAllBytes($oldInstaller)))
if ($actualOldHash -ne $expectedOldHash) {
    throw 'Downloaded legacy installer SHA-512 does not match latest.yml.'
}
$sizeMatch = [regex]::Match($oldManifest, '(?m)^\s+size:\s*(\d+)\s*$')
if (-not $sizeMatch.Success) {
    throw 'Previous release manifest is missing the installer size.'
}
if ([int64]$sizeMatch.Groups[1].Value -ne (Get-Item -LiteralPath $oldInstaller).Length) {
    throw 'Downloaded legacy installer size does not match latest.yml.'
}
Write-Host "Legacy installer integrity verified: version $PreviousVersion, SHA-512 and size match."

if (Test-Path -LiteralPath $installRoot) {
    throw "Install target unexpectedly exists; refusing to reuse it: $installRoot"
}
Invoke-SilentInstaller -InstallerPath $oldInstaller -InstallPath $installRoot -Label 'Legacy clean install'
Assert-InstalledVersion -InstallPath $installRoot -ExpectedVersion $PreviousVersion

$resolvedCurrentInstaller = [IO.Path]::GetFullPath($CurrentInstaller)
Invoke-SilentInstaller -InstallerPath $resolvedCurrentInstaller -InstallPath $installRoot -Label 'Current in-place upgrade'
Assert-InstalledVersion -InstallPath $installRoot -ExpectedVersion $currentVersion
Assert-CurrentPackage -InstallPath $installRoot

Write-Host 'Windows clean install and in-place upgrade smoke test passed.'
