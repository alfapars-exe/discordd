param([string]$Project = (Join-Path $PSScriptRoot '../hichat_native_proof'))
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath $Project).Path
$spec = Get-Content -LiteralPath (Join-Path $projectRoot '.flutter-plugins-dependencies') -Raw | ConvertFrom-Json
foreach ($platform in @('windows', 'linux')) {
    $linkRoot = Join-Path $projectRoot "$platform/flutter/ephemeral/.plugin_symlinks"
    if (-not $linkRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar)) { throw 'Plugin directory outside project' }
    New-Item -ItemType Directory -Path $linkRoot -Force | Out-Null
    foreach ($plugin in $spec.plugins.$platform) {
        if ($plugin.name -notmatch '^[a-z0-9_]+$') { throw 'Invalid plugin name' }
        $target = (Resolve-Path -LiteralPath $plugin.path).Path
        $link = Join-Path $linkRoot $plugin.name
        if (Test-Path -LiteralPath $link) {
            $item = Get-Item -LiteralPath $link
            if ($item.LinkType -notin @('Junction', 'SymbolicLink')) { throw 'Existing plugin path is not a link' }
        } else {
            New-Item -ItemType Junction -Path $link -Target $target | Out-Null
        }
    }
}
Write-Output 'Project-local plugin junctions prepared; run flutter pub get again.'
