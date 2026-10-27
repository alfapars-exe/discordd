function Assert-GitHubHostedWindowsRunner {
    [CmdletBinding()]
    param(
        [AllowNull()][string] $GitHubActions,
        [AllowNull()][string] $RunnerEnvironment,
        [AllowNull()][string] $RunnerOS,
        [AllowNull()][string] $RunnerTemp,
        [Parameter(Mandatory = $true)][bool] $IsWindowsHost
    )

    if ($GitHubActions -cne 'true' -or
        $RunnerEnvironment -cne 'github-hosted' -or
        $RunnerOS -cne 'Windows' -or
        -not $IsWindowsHost -or
        [string]::IsNullOrWhiteSpace($RunnerTemp)) {
        throw 'The Windows install/upgrade smoke test is restricted to a GitHub-hosted Windows runner with RUNNER_TEMP.'
    }
}
