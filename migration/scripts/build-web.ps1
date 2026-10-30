param([switch]$WorkerOnly, [switch]$SkipRust)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '../hichat_native_proof')).Path
$configPath = Join-Path $project '.dart_tool/package_config.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$package = $config.packages | Where-Object name -eq 'dart_webrtc'
if (-not $package) { throw 'Run flutter pub get first' }
$packageRoot = [Uri]::new([Uri]::new($configPath), [string]$package.rootUri).LocalPath
$source = Join-Path $packageRoot 'lib/src/e2ee.worker'
$keyHandler = Join-Path $source 'e2ee.keyhandler.dart'
$expected = '86472D6EE9D7B7C0FEC595EF870877209521D9EF28BAA3F0F3A24F0CB029EE4E'
if ((Get-FileHash -LiteralPath $keyHandler -Algorithm SHA256).Hash -ne $expected) {
    throw 'dart_webrtc worker changed: review compatibility patch before building'
}
# Build a copy, never modify the global dependency cache.
$buildSource = Join-Path (Split-Path $project -Parent) '.local/worker-source'
New-Item -ItemType Directory -Path $buildSource -Force | Out-Null
Get-ChildItem -LiteralPath $source -Filter '*.dart' | Copy-Item -Destination $buildSource -Force
$patched = Join-Path $buildSource 'e2ee.keyhandler.dart'
$content = Get-Content -LiteralPath $patched -Raw
$content = $content.Replace('keyOptions.keyRingSze > 255', 'keyOptions.keyRingSze > 256')
[IO.File]::WriteAllText($patched, $content)
Push-Location $project
try {
    & dart compile js "--packages=$configPath" (Join-Path $buildSource 'e2ee.worker.dart') -O2 -o web/e2ee.worker.dart.js
    if ($LASTEXITCODE -ne 0) { throw 'E2EE worker compilation failed' }
    Copy-Item -LiteralPath (Join-Path $packageRoot 'LICENSE') -Destination web/dart-webrtc-LICENSE.txt -Force
    if (-not $WorkerOnly) {
        if (-not $SkipRust) {
            & flutter_rust_bridge_codegen build-web --release
            if ($LASTEXITCODE -ne 0) { throw 'Rust WASM compilation failed' }
        }
        & flutter build web --release --no-pub
        if ($LASTEXITCODE -ne 0) { throw 'Flutter web compilation failed' }
    }
} finally { Pop-Location }
