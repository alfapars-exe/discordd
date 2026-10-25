param(
    [string]$GoBinary = "C:\Program Files\Go\bin\go.exe",
    [string[]]$Toolchains = @("go1.26.10", "go1.27.3")
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker is required to run the isolated PostgreSQL TLS integration test."
}
if (-not (Test-Path -LiteralPath $GoBinary)) {
    throw "Go executable not found: $GoBinary"
}

$databaseDir = $PSScriptRoot
$serverDir = (Resolve-Path (Join-Path $databaseDir "..")).Path
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("hichat-pg-tls-test-" + [guid]::NewGuid().ToString("N"))
$containerName = "hichat-pg-tls-test-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
$imageName = "hichat-pg-tls-test:" + [guid]::NewGuid().ToString("N").Substring(0, 12)
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$previousGoToolchain = $env:GOTOOLCHAIN
$previousTestDSN = $env:HICHAT_TEST_POSTGRES_TLS_DSN
$previousCA = $env:HICHAT_PG_CA_PEM
$previousCert = $env:HICHAT_PG_CERT_PEM
$previousKey = $env:HICHAT_PG_KEY_PEM
$previousCGO = $env:CGO_ENABLED

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

try {
    New-Item -ItemType Directory -Path $tempDir | Out-Null

    $certScript = @'
set -eu
cd /tls
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=HiChat-Test-CA >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=127.0.0.1 >/dev/null 2>&1
# Use one explicit RSA PEM format and validate it inside the database image.
openssl rsa -in server.key -traditional -out server-rsa.key >/dev/null 2>&1
mv server-rsa.key server.key
openssl rsa -in server.key -check -noout >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -sha256 -extfile server.ext >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr -subj /CN=hichat_tls_test >/dev/null 2>&1
printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 2 -sha256 -extfile client.ext >/dev/null 2>&1
'@ -replace "`r`n", "`n"

    Write-Utf8NoBom (Join-Path $tempDir "generate-certs.sh") $certScript

    $hba = @'
local all all trust
hostssl all all 0.0.0.0/0 cert
hostssl all all ::/0 cert
'@ -replace "`r`n", "`n"
    Write-Utf8NoBom (Join-Path $tempDir "pg_hba.conf") $hba
    $dockerfile = @'
FROM postgres:18.6-bookworm@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc
COPY --chmod=0700 generate-certs.sh /generate-certs.sh
RUN mkdir /tls && bash /generate-certs.sh && chown -R postgres:postgres /tls && chmod 0600 /tls/*.key && openssl rsa -in /tls/server.key -check -noout
COPY --chown=postgres:postgres --chmod=0644 pg_hba.conf /tls/pg_hba.conf
'@ -replace "`r`n", "`n"
    Write-Utf8NoBom (Join-Path $tempDir "Dockerfile") $dockerfile
    docker build --tag $imageName $tempDir | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not build the disposable PostgreSQL TLS image." }

    $randomBytes = [byte[]]::new(24)
    $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    $randomGenerator.GetBytes($randomBytes)
    $randomGenerator.Dispose()
    $testPassword = ($randomBytes | ForEach-Object { $_.ToString("x2") }) -join ""
    docker run --detach --name $containerName `
        --publish "127.0.0.1:${port}:5432" `
        --env "POSTGRES_USER=hichat_tls_test" `
        --env "POSTGRES_PASSWORD=$testPassword" `
        --env "POSTGRES_DB=postgres" `
        $imageName postgres `
        -c ssl=on `
        -c ssl_ca_file=/tls/ca.crt `
        -c ssl_cert_file=/tls/server.crt `
        -c ssl_key_file=/tls/server.key `
        -c hba_file=/tls/pg_hba.conf | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not start the disposable PostgreSQL container." }

    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        docker exec $containerName pg_isready -U hichat_tls_test -d postgres *> $null
        if ($LASTEXITCODE -eq 0) { break }
        $containerStatus = docker inspect --format '{{.State.Status}}' $containerName 2>$null
        if ($LASTEXITCODE -eq 0 -and $containerStatus -ne "running") {
            docker logs $containerName
            throw "Disposable PostgreSQL exited during startup."
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($LASTEXITCODE -ne 0) { throw "Disposable PostgreSQL did not become ready within 90 seconds." }

    # Export only the client credentials needed by Go. The server private key
    # stays inside the disposable image; no bind-mount/host conversion is used.
    foreach ($certificate in @("ca.crt", "client.crt", "client.key")) {
        docker cp "${containerName}:/tls/$certificate" (Join-Path $tempDir $certificate)
        if ($LASTEXITCODE -ne 0) { throw "Could not export disposable TLS client credential." }
    }

    $env:HICHAT_TEST_POSTGRES_TLS_DSN = "postgres://hichat_tls_test:${testPassword}@127.0.0.1:${port}/postgres?sslmode=verify-full"
    $env:HICHAT_PG_CA_PEM = Get-Content -Raw -LiteralPath (Join-Path $tempDir "ca.crt")
    $env:HICHAT_PG_CERT_PEM = Get-Content -Raw -LiteralPath (Join-Path $tempDir "client.crt")
    $env:HICHAT_PG_KEY_PEM = Get-Content -Raw -LiteralPath (Join-Path $tempDir "client.key")
    $env:CGO_ENABLED = "0"

    Push-Location $serverDir
    try {
        foreach ($toolchain in $Toolchains) {
            $env:GOTOOLCHAIN = $toolchain
            & $GoBinary version
            if ($LASTEXITCODE -ne 0) { throw "Could not select Go toolchain $toolchain." }
            & $GoBinary test ./database -run '^TestOpenPostgresInlinePEMReconnect$' -count=1 -timeout=60s -v
            if ($LASTEXITCODE -ne 0) { throw "PostgreSQL inline-PEM integration test failed under $toolchain." }
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    try {
        docker rm --force --volumes $containerName *> $null
        docker image rm --force $imageName *> $null
        if (Test-Path -LiteralPath $tempDir) {
            $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
            $cleanupTarget = [IO.Path]::GetFullPath($tempDir)
            if (-not $cleanupTarget.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or
                [IO.Path]::GetFileName($cleanupTarget) -notmatch '^hichat-pg-tls-test-[0-9a-f]{32}$') {
                throw "Refusing cleanup outside the exact generated PostgreSQL test directory."
            }
            Remove-Item -LiteralPath $cleanupTarget -Recurse -Force
        }
    }
    finally {
        $env:GOTOOLCHAIN = $previousGoToolchain
        $env:HICHAT_TEST_POSTGRES_TLS_DSN = $previousTestDSN
        $env:HICHAT_PG_CA_PEM = $previousCA
        $env:HICHAT_PG_CERT_PEM = $previousCert
        $env:HICHAT_PG_KEY_PEM = $previousKey
        $env:CGO_ENABLED = $previousCGO
    }
}
