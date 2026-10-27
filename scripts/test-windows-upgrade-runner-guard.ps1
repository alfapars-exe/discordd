$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-upgrade-runner-guard.ps1')

$cases = @(
    @{
        Name = 'GitHub-hosted Windows runner is accepted'
        Environment = @{ GitHubActions = 'true'; RunnerEnvironment = 'github-hosted'; RunnerOS = 'Windows'; RunnerTemp = 'C:\actions\_temp'; IsWindowsHost = $true }
        ShouldReject = $false
    },
    @{
        Name = 'self-hosted Windows runner is rejected'
        Environment = @{ GitHubActions = 'true'; RunnerEnvironment = 'self-hosted'; RunnerOS = 'Windows'; RunnerTemp = 'C:\actions\_temp'; IsWindowsHost = $true }
        ShouldReject = $true
    },
    @{
        Name = 'missing runner environment is rejected'
        Environment = @{ GitHubActions = 'true'; RunnerEnvironment = ''; RunnerOS = 'Windows'; RunnerTemp = 'C:\actions\_temp'; IsWindowsHost = $true }
        ShouldReject = $true
    },
    @{
        Name = 'non-Windows runner is rejected'
        Environment = @{ GitHubActions = 'true'; RunnerEnvironment = 'github-hosted'; RunnerOS = 'Linux'; RunnerTemp = '/tmp'; IsWindowsHost = $false }
        ShouldReject = $true
    },
    @{
        Name = 'PowerShell non-Windows platform is rejected even with Windows runner metadata'
        Environment = @{ GitHubActions = 'true'; RunnerEnvironment = 'github-hosted'; RunnerOS = 'Windows'; RunnerTemp = 'C:\actions\_temp'; IsWindowsHost = $false }
        ShouldReject = $true
    },
    @{
        Name = 'missing GitHub Actions context is rejected'
        Environment = @{ GitHubActions = ''; RunnerEnvironment = 'github-hosted'; RunnerOS = 'Windows'; RunnerTemp = 'C:\actions\_temp'; IsWindowsHost = $true }
        ShouldReject = $true
    },
    @{
        Name = 'missing runner temp path is rejected'
        Environment = @{ GitHubActions = 'true'; RunnerEnvironment = 'github-hosted'; RunnerOS = 'Windows'; RunnerTemp = ''; IsWindowsHost = $true }
        ShouldReject = $true
    }
)

foreach ($case in $cases) {
    $rejected = $false
    try {
        $arguments = $case.Environment
        Assert-GitHubHostedWindowsRunner @arguments
    }
    catch {
        $rejected = $true
    }

    if ($rejected -ne $case.ShouldReject) {
        throw "Runner guard test failed: $($case.Name)"
    }
    Write-Host "PASS: $($case.Name)"
}
