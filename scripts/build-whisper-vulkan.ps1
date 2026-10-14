# Build whisper.cpp with the Vulkan backend (Windows x64) and copy whisper-cli
# into an Env engines folder. Official releases have no Windows Vulkan build.
#
# Needs: git, Visual Studio 2022 Build Tools (C++), Vulkan SDK.
#   powershell -ExecutionPolicy Bypass -File scripts\build-whisper-vulkan.ps1 [-Dest <folder>] [-Ref v1.9.5]
# Default destination: %APPDATA%\Env\engines\whisper-vulkan
param(
  [string]$Dest = (Join-Path $env:APPDATA 'Env\engines\whisper-vulkan'),
  [string]$Ref = 'v1.9.5',
  # short: the Vulkan shader tool builds in deep sub-folders (Windows 260-char paths)
  [string]$BuildDir = (Join-Path $env:SystemDrive 'envwb')
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $root '.build\whisper.cpp'

# cmake: on PATH, winget's link, or the one bundled with VS Build Tools
$cmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $cmake) { $l = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\cmake.exe'; if (Test-Path $l) { $cmake = $l } }
if (-not $cmake) {
  $vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -property installationPath
  $c = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
  if (Test-Path $c) { $cmake = $c }
}
if (-not $cmake) { throw 'cmake를 찾지 못했습니다' }

# Vulkan SDK (glslc compiles the shaders)
if (-not $env:VULKAN_SDK) { $env:VULKAN_SDK = [Environment]::GetEnvironmentVariable('VULKAN_SDK', 'Machine') }
if (-not $env:VULKAN_SDK) { $env:VULKAN_SDK = (Get-ChildItem C:\VulkanSDK -Directory | Sort-Object Name | Select-Object -Last 1).FullName }
if (-not $env:VULKAN_SDK) { throw 'Vulkan SDK를 찾지 못했습니다' }
$env:PATH = "$env:VULKAN_SDK\Bin;$env:PATH"
Write-Host "cmake: $cmake"
Write-Host "Vulkan SDK: $env:VULKAN_SDK"

if (-not (Test-Path (Join-Path $work '.git'))) {
  New-Item -ItemType Directory -Force -Path (Split-Path $work) | Out-Null
  git clone --depth 1 --branch $Ref https://github.com/ggml-org/whisper.cpp $work
} else {
  git -C $work fetch --depth 1 origin tag $Ref
  git -C $work checkout -f $Ref
}

$build = $BuildDir
& $cmake -S $work -B $build -G 'Visual Studio 17 2022' -A x64 -DGGML_VULKAN=ON -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_SDL2=OFF
if ($LASTEXITCODE -ne 0) { throw "cmake configure 실패 ($LASTEXITCODE)" }
& $cmake --build $build --config Release --target whisper-cli -j
if ($LASTEXITCODE -ne 0) { throw "빌드 실패 ($LASTEXITCODE)" }

$bin = Get-ChildItem $build -Recurse -Filter whisper-cli.exe | Select-Object -First 1
if (-not $bin) { throw 'whisper-cli.exe를 찾지 못했습니다' }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item $bin.FullName $Dest -Force
Get-ChildItem $bin.DirectoryName -Filter *.dll | Copy-Item -Destination $Dest -Force
Write-Host "완료: $Dest\whisper-cli.exe"
