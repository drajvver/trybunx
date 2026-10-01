# Developer/CI build entry point. End users only run the resulting installer.
param([switch]$PrepareOnly)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Windows PowerShell started through an intermediate process (pwsh -> npm/cmd
# -> powershell) inherits PowerShell 7's module paths, which makes module
# auto-loading resolve incompatible 7.0.0.0 modules and break cmdlets such as
# Get-FileHash. Restore the Windows PowerShell module paths before anything else.
if ($PSVersionTable.PSEdition -eq "Desktop" -and $env:PSModulePath -match '(?i)[\\/]PowerShell[\\/]7|[\\/]Program Files[\\/]PowerShell[\\/]Modules|[\\/]Documents[\\/]PowerShell[\\/]Modules|[\\/]WindowsApps[\\/][^;]*PowerShell') {
    $env:PSModulePath = "$HOME\Documents\WindowsPowerShell\Modules;$env:ProgramFiles\WindowsPowerShell\Modules;$PSHOME\Modules"
}
if ($env:OS -ne "Windows_NT") { throw "Build this installer on Windows x64." }
Set-Location (Split-Path $PSScriptRoot -Parent)
function Run {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
$Stage = Join-Path (Get-Location) ".windows-build"
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force "$Stage/python", "$Stage/bin", "$Stage/licenses" | Out-Null
# uv's managed Python comes from python-build-standalone and is relocatable.
Run uv @("python", "install", "3.12")
$Python = (& uv python find --managed-python 3.12).Trim()
if ($LASTEXITCODE -ne 0) { throw "Managed Python not found" }
$PythonRoot = Split-Path $Python -Parent
Copy-Item $PythonRoot "$Stage/runtime" -Recurse
$BundledPython = "$Stage/runtime/python.exe"
Run $BundledPython @("-c", "import struct; assert struct.calcsize('P') == 8")
Copy-Item python/worker.py "$Stage/python/"
Copy-Item python/ocr, python/track "$Stage/python/" -Recurse
Get-ChildItem "$Stage/python" -Directory -Recurse -Filter __pycache__ | Remove-Item -Recurse -Force
Run uv @("export", "--project", "python", "--frozen", "--no-dev", "--no-hashes", "--output-file", "$Stage/requirements.txt")
# Install only the locked ONNX/CPU runtime; no system Python is needed.
Run uv @("pip", "install", "--python", $BundledPython, "--target", "$Stage/python/vendor",
    "-r", "$Stage/requirements.txt")

Run $BundledPython @("$Stage/python/track/download_model.py")


# Official FFmpeg Windows download provider; verify the published archive hash.
$ArchiveUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
Invoke-WebRequest $ArchiveUrl -OutFile "$Stage/ffmpeg.zip"
Invoke-WebRequest "$ArchiveUrl.sha256" -OutFile "$Stage/ffmpeg.sha256"
$Expected = ((Get-Content "$Stage/ffmpeg.sha256" -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash "$Stage/ffmpeg.zip" -Algorithm SHA256).Hash -ne $Expected) { throw "FFmpeg checksum mismatch" }
Expand-Archive "$Stage/ffmpeg.zip" "$Stage/ffmpeg"
$FfmpegRoot = (Get-ChildItem "$Stage/ffmpeg" -Directory | Select-Object -First 1).FullName
Copy-Item "$FfmpegRoot/bin/ffmpeg.exe", "$FfmpegRoot/bin/ffprobe.exe" "$Stage/bin/"
Copy-Item "$FfmpegRoot/LICENSE" "$Stage/licenses/FFmpeg-LICENSE.txt"
Copy-Item "$Stage/ffmpeg.sha256" "$Stage/licenses/"
"Build: $ArchiveUrl`nSource: https://www.gyan.dev/ffmpeg/builds/ (release source archive)" | Set-Content "$Stage/licenses/FFmpeg-source.txt"
Copy-Item "$Stage/requirements.txt" "$Stage/licenses/python-packages.txt"
# Prefetch OCR weights on the build machine; no download on first use.
$env:PYTHONPATH = "$Stage/python/vendor;$Stage/python"
Run $BundledPython @("-c", "from ocr.neural import NeuralScoreReader; NeuralScoreReader('cpu')")
Run $BundledPython @("scripts/verify_windows_bundle.py", $Stage)
if (-not $PrepareOnly) {
    Run npm.cmd @("run", "build")
    Run npx.cmd @("electron-builder", "--win", "--x64", "--config", "electron-builder.windows.yml", "--publish", "never")
}
