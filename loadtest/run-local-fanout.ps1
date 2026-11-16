# Windows-native bounded 20 healthy + 1 non-reading PostgreSQL profile.
param(
    [Parameter(Mandatory=$true)][string]$ArtifactRoot,
    [string]$K6Binary = 'k6',
    [string]$GoBinary = 'go',
    [string]$SourceRoot = (Split-Path $PSScriptRoot -Parent)
)
$ErrorActionPreference = 'Stop'
foreach ($tool in @('docker', 'git', 'tar', 'node')) {
    if (-not (Get-Command $tool -CommandType Application -ErrorAction SilentlyContinue)) { throw "Required executable not found: $tool" }
}
$GoBinary = (Get-Command $GoBinary -CommandType Application -ErrorAction Stop).Source
$K6Binary = (Get-Command $K6Binary -CommandType Application -ErrorAction Stop).Source
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$ArtifactRoot = [IO.Path]::GetFullPath($ArtifactRoot)
New-Item -ItemType Directory -Force -Path $ArtifactRoot | Out-Null
$sourceCommit = git -C $SourceRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'Cannot resolve source commit' }
$ownerLabel = 'local-fanout-' + [guid]::NewGuid().ToString('N')
$tempDir = Join-Path $ArtifactRoot $ownerLabel
$containerName = $ownerLabel
$imageName = 'hichat-local-fanout:' + [guid]::NewGuid().ToString('N')
$containerID = $null
$imageID = $null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$previousGoToolchain = $env:GOTOOLCHAIN
$previousTaskGoCache = $env:GOCACHE
$previousTaskGoTmp = $env:GOTMPDIR
$env:GOCACHE = Join-Path $ArtifactRoot 'go-build'
$env:GOTMPDIR = Join-Path $ArtifactRoot 'go-tmp'
$env:GOTOOLCHAIN = 'local'
New-Item -ItemType Directory -Force -Path $env:GOCACHE,$env:GOTMPDIR | Out-Null

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

$workloadFailure = $null
$cleanupFailures = @()
try {
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    Write-Utf8NoBom (Join-Path $tempDir 'owner.json') (@{label=$ownerLabel;sourceCommit=$sourceCommit}|ConvertTo-Json)
    $archive = Join-Path $tempDir 'source.tar'
    git -C $SourceRoot archive --format=tar --output=$archive $sourceCommit server e2e/scripts/pg-fixture.go loadtest
    if ($LASTEXITCODE -ne 0) { throw 'Cannot archive committed profile source' }
    $frozenSource = Join-Path $tempDir 'source'
    New-Item -ItemType Directory -Path $frozenSource | Out-Null
    tar -xf $archive -C $frozenSource
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract owned source archive' }
    if (-not (Test-Path -LiteralPath (Join-Path $frozenSource 'loadtest/local-fanout-runner.mjs'))) { throw 'Commit profile tooling before running this launcher' }
    # Preserve the original system/artifact volume disk gates.
    & node -e 'const fs=require("node:fs");for(const [p,n] of [[process.env.SystemDrive+"/",1024**3],[process.argv[1],4*1024**3]]){const s=fs.statfsSync(p);if(s.bavail*s.bsize<n)throw Error("Insufficient local profile disk headroom")}' $ArtifactRoot
    if ($LASTEXITCODE -ne 0) { throw 'Profile preflight disk gate failed' }

    $certScript = @'
set -eu
cd /tls
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=HiChat-Test-CA >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=127.0.0.1 >/dev/null 2>&1
openssl rsa -in server.key -traditional -out server-rsa.key >/dev/null 2>&1
mv server-rsa.key server.key
openssl rsa -in server.key -check -noout >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -sha256 -extfile server.ext >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr -subj /CN=hichat_tls_test >/dev/null 2>&1
printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 2 -sha256 -extfile client.ext >/dev/null 2>&1
'@ -replace "`r`n", "`n"
    Write-Utf8NoBom (Join-Path $tempDir 'generate-certs.sh') $certScript
    $hba = @'
local all all trust
hostssl all all 0.0.0.0/0 cert
hostssl all all ::/0 cert
'@ -replace "`r`n", "`n"
    Write-Utf8NoBom (Join-Path $tempDir 'pg_hba.conf') $hba
    $dockerfile = @'
FROM postgres:18.6-bookworm@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc
COPY --chmod=0700 generate-certs.sh /generate-certs.sh
RUN mkdir /tls && bash /generate-certs.sh && chown -R postgres:postgres /tls && chmod 0600 /tls/*.key && openssl rsa -in /tls/server.key -check -noout
COPY --chown=postgres:postgres --chmod=0644 pg_hba.conf /tls/pg_hba.conf
'@ -replace "`r`n", "`n"
    Write-Utf8NoBom (Join-Path $tempDir 'Dockerfile') $dockerfile
    Write-Utf8NoBom (Join-Path $tempDir '.dockerignore') "*`n!Dockerfile`n!generate-certs.sh`n!pg_hba.conf`n"
    # Generate fresh certificates rather than reusing an expired cached layer.
    docker build --no-cache --tag $imageName $tempDir | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Disposable TLS image build failed' }
    $imageID = docker image inspect --format '{{.Id}}' $imageName
    if ($LASTEXITCODE -ne 0) { throw 'Cannot capture owned image identity' }
    $randomBytes = [byte[]]::new(24)
    $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    $randomGenerator.GetBytes($randomBytes)
    $randomGenerator.Dispose()
    $testPassword = ($randomBytes | ForEach-Object { $_.ToString('x2') }) -join ''
    docker run --detach --name $containerName --label "hichat.task=$ownerLabel" `
        --publish "127.0.0.1:${port}:5432" --env 'POSTGRES_USER=hichat_tls_test' `
        --env "POSTGRES_PASSWORD=$testPassword" --env 'POSTGRES_DB=postgres' `
        $imageName postgres -c ssl=on -c ssl_ca_file=/tls/ca.crt -c ssl_cert_file=/tls/server.crt `
        -c ssl_key_file=/tls/server.key -c hba_file=/tls/pg_hba.conf | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL start failed' }
    $containerID = docker inspect --format '{{.Id}}' $containerName
    if ($LASTEXITCODE -ne 0) { throw 'Cannot capture owned container identity' }
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        docker exec $containerName pg_isready -U hichat_tls_test -d postgres *> $null
        if ($LASTEXITCODE -eq 0) { break }
        $containerStatus = docker inspect --format '{{.State.Status}}' $containerName 2>$null
        if ($LASTEXITCODE -eq 0 -and $containerStatus -ne 'running') { throw 'Disposable PostgreSQL exited during startup' }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL readiness timeout' }
    foreach ($certificate in @('ca.crt', 'client.crt', 'client.key')) {
        docker cp "${containerName}:/tls/$certificate" (Join-Path $tempDir $certificate)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot export disposable TLS client credential' }
    }
    docker exec $containerName psql -U hichat_tls_test -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE hichat_e2e_control' *> (Join-Path $tempDir 'control-init.log')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create private control database' }
    $controlURL = "postgres://hichat_tls_test:${testPassword}@127.0.0.1:${port}/hichat_e2e_control?sslmode=verify-full"
    foreach ($entry in @{sslrootcert='ca.crt';sslcert='client.crt';sslkey='client.key'}.GetEnumerator()) {
        $certPath = (Join-Path $tempDir $entry.Value).Replace('\','/')
        $controlURL += "&$($entry.Key)=$([Uri]::EscapeDataString($certPath))"
    }
    $privateConfig = Join-Path $tempDir 'capacity-private.json'
    Write-Utf8NoBom $privateConfig (@{tempDir=$tempDir;container=$containerName;containerID=$containerID;ownerLabel=$ownerLabel;controlDSN=$controlURL;goBinary=$GoBinary;source=$frozenSource;sourceCommit=$sourceCommit;k6=$K6Binary}|ConvertTo-Json)
    docker exec $containerName openssl x509 -in /tls/server.crt -noout -dates | Out-File -Encoding utf8 (Join-Path $tempDir 'server-cert-dates.log')
    Write-Output "Local profile evidence directory: $tempDir"
    & node (Join-Path $frozenSource 'loadtest/local-fanout-runner.mjs') $privateConfig
    if ($LASTEXITCODE -ne 0) { throw 'Local fanout profile failed; inspect owned evidence' }
} catch {
    $workloadFailure = $_.Exception
} finally {
    $env:GOCACHE = $previousTaskGoCache
    $env:GOTMPDIR = $previousTaskGoTmp
    $env:GOTOOLCHAIN = $previousGoToolchain
    try {
        $ownedContainer = docker inspect $containerName 2>$null | ConvertFrom-Json
        if ($ownedContainer) {
            if ($ownedContainer.Config.Labels.'hichat.task' -ne $ownerLabel -or ($containerID -and $ownedContainer.Id -ne $containerID)) { throw 'Owned container identity mismatch' }
            docker rm --force --volumes $ownedContainer.Id *> $null
            if ($LASTEXITCODE -ne 0) { throw 'Owned container cleanup failed' }
        }
    } catch { $cleanupFailures += 'container' }
    try {
        if ($imageID) {
            docker image rm $imageID *> $null
            if ($LASTEXITCODE -ne 0) { throw 'Owned image cleanup failed' }
        }
    } catch { $cleanupFailures += 'image' }
    # No recursive host deletion. Only exact credential files inside this owner directory.
    $privatePaths = @('capacity-private.json','client.key','client.crt','ca.crt') | ForEach-Object { Join-Path $tempDir $_ }
    if (Test-Path -LiteralPath $tempDir) {
        $privatePaths += @(Get-ChildItem -LiteralPath $tempDir -Directory -Filter 'run-*' | ForEach-Object { Join-Path $_.FullName 'hichat-e2e-postgres.json' })
    }
    foreach ($privatePath in $privatePaths) {
        try {
            $target = [IO.Path]::GetFullPath($privatePath)
            if (-not $target.StartsWith([IO.Path]::GetFullPath($tempDir)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Private cleanup escaped owned directory' }
            if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force -ErrorAction Stop }
        } catch { $cleanupFailures += 'credential file' }
    }
    try {
        Write-Utf8NoBom (Join-Path $tempDir 'launcher-cleanup.json') (@{containerID=$containerID;imageID=$imageID;failures=$cleanupFailures;finishedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json)
    } catch { $cleanupFailures += 'cleanup report' }
}
if ($workloadFailure -or $cleanupFailures.Count -gt 0) {
    $failures = [System.Collections.Generic.List[Exception]]::new()
    if ($workloadFailure) { $failures.Add($workloadFailure) }
    foreach ($phase in $cleanupFailures) { $failures.Add([Exception]::new("Local profile cleanup failed: $phase")) }
    throw [AggregateException]::new('Local fanout profile failed', $failures)
}
