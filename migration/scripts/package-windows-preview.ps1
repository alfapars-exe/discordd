param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$project=Join-Path $root 'migration/hichat_native_proof'
$manifest=Get-Content -LiteralPath (Join-Path $project 'pubspec.yaml') -Raw
if($manifest -notmatch '(?m)^version: (\d+\.\d+\.\d+)\+(\d+)\s*$'){throw 'Missing preview version'}
$version=$Matches[1]
$source=(git -C $root rev-parse HEAD).Trim()
if(git -C $root status --porcelain --untracked-files=no){throw 'Commit tracked source changes before packaging'}
Push-Location $project
try {
  if(-not $SkipBuild){
    & flutter build windows --release --no-pub
    if($LASTEXITCODE -ne 0){throw 'Windows preview build failed'}
  }
  $bundle=Join-Path $project 'build/windows/x64/runner/Release'
  $exe=Get-Item -LiteralPath (Join-Path $bundle 'hichat_native_proof.exe')
  if(-not $exe.VersionInfo.ProductVersion.StartsWith($version)){throw 'Built executable version mismatch'}
  Copy-Item -LiteralPath (Join-Path $root 'migration/RELEASE_PREVIEW.md') -Destination (Join-Path $bundle 'README-PREVIEW.md') -Force
  $output=Join-Path $root "migration/.local/distribution/$version"
  New-Item -ItemType Directory -Path $output -Force|Out-Null
  $zip=Join-Path $output "hichat-rust-flutter-preview-$version-windows-x64.zip"
  Compress-Archive -Path (Join-Path $bundle '*') -DestinationPath $zip -Force
  $files=@(Get-ChildItem -LiteralPath $bundle -File -Recurse|ForEach-Object {
    @{path=[IO.Path]::GetRelativePath($bundle,$_.FullName).Replace('\','/');size=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  })
  $receipt=@{version=$version;channel='preview';source=$source;automaticStableReplacement=$false;physicalDeviceAcceptance=$false;archive=(Split-Path $zip -Leaf);size=(Get-Item $zip).Length;sha256=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant();files=$files}
  $receipt|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $output 'windows-preview-manifest.json') -Encoding utf8NoBOM
  Write-Output "Preview package: $zip (source $source)"
} finally {Pop-Location}
