$ErrorActionPreference = 'Stop'

# Builds the actual production image and exercises its entrypoint, generated
# Nginx config, and response CSP. Requires Docker and a reachable base image.
$clientDir = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $clientDir
$image = "hichat-nginx-csp-test:$PID"
$container = "hichat-nginx-csp-test-$PID"

function Assert-Contains([string] $Text, [string] $Needle, [string] $Message) {
    if (-not $Text.Contains($Needle)) {
        throw $Message
    }
}

function Start-TestContainer([string[]] $Arguments = @()) {
    $dockerArguments = @('--add-host', 'server:127.0.0.1') + $Arguments + @($image)
    $output = & docker run --detach --name $container @dockerArguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "docker run failed: $($output -join "`n")"
    }
}

function Wait-Nginx {
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        & docker exec $container nginx -t *> $null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    $logs = (& docker logs $container 2>&1) -join "`n"
    throw "nginx did not start with a valid config: $logs"
}

try {
    & docker build --file (Join-Path $clientDir 'Dockerfile') --target production --tag $image $repoRoot
    if ($LASTEXITCODE -ne 0) { throw 'production Docker build failed' }

    # Default: baseline CSP remains valid and keeps the existing wss:/https: paths.
    Start-TestContainer
    Wait-Nginx
    $defaultConfig = (& docker exec $container nginx -T 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "default nginx -T failed: $defaultConfig" }
    Assert-Contains $defaultConfig "connect-src 'self' wss: https: ;" 'default CSP lost wss:/https: or has an unexpected source'
    Assert-Contains $defaultConfig 'proxy_set_header Host $host;' 'envsubst modified an Nginx $host variable'
    Assert-Contains $defaultConfig 'proxy_set_header X-Forwarded-Proto $scheme;' 'envsubst modified an Nginx $scheme variable'
    $defaultResponse = (& docker exec $container sh -c 'wget -qSO- http://127.0.0.1/ 2>&1') -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'default container did not serve the SPA' }
    Assert-Contains $defaultResponse "connect-src 'self' wss: https: ;" 'default HTTP CSP header is missing baseline sources'
    if ($defaultResponse.Contains("connect-src") -and $defaultResponse.Contains('ws://')) {
        throw 'default CSP unexpectedly allows a ws:// origin'
    }
    & docker rm --force $container | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'could not remove default test container' }

    # Exact operator-configured origin: included alongside baseline sources.
    Start-TestContainer -Arguments @('--env', 'LIVEKIT_CSP_WS_ORIGIN=ws://voice.example.test:7880')
    Wait-Nginx
    $configuredResponse = (& docker exec $container sh -c 'wget -qSO- http://127.0.0.1/ 2>&1') -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'configured-origin container did not serve the SPA' }
    Assert-Contains $configuredResponse "connect-src 'self' wss: https: ws://voice.example.test:7880;" 'response CSP lacks the exact configured origin or baseline sources'
    & docker rm --force $container | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'could not remove configured-origin test container' }

    # Malformed origins and CSP/token injection are rejected before nginx starts.
    $invalidOrigins = @(
        'ws://voice.example.test:7880; add_header X-Injected yes;',
        "ws://voice.example.test:7880`nws://attacker.example.test:7880",
        'wss://voice.example.test:7880',
        'ws://voice.example.test/path',
        'ws://voice.example.test:65536'
    )
    foreach ($invalidOrigin in $invalidOrigins) {
        $injection = "LIVEKIT_CSP_WS_ORIGIN=$invalidOrigin"
        $runOutput = & docker run --name $container --env $injection $image 2>&1
        if ($LASTEXITCODE -eq 0) { throw "invalid CSP origin was accepted: $invalidOrigin" }
        $injectionLog = (& docker logs $container 2>&1) -join "`n"
        Assert-Contains $injectionLog 'Invalid LIVEKIT_CSP_WS_ORIGIN' 'invalid origin rejection did not fail closed with a diagnostic'
        & docker rm --force $container 2>$null | Out-Null
    }

    Write-Output 'PASS: production nginx default, exact ws:// origin, Nginx variable preservation, response CSP, malformed-origin rejection, and newline/token injection rejection.'
}
finally {
    & docker rm --force $container 2>$null | Out-Null
    & docker image rm $image 2>$null | Out-Null
}
