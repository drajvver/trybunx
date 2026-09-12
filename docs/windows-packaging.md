# Windows installer

Target: Windows 10/11 x64. The recipient runs the small
Trybunx-Setup-VERSION-x64.exe web installer and opens the desktop shortcut.
The installer downloads the app package, so setup needs internet access unless
the accompanying trybunx-clip-hunter-VERSION-x64.nsis.7z package is kept next
to the installer; when it is present (and its checksum matches), setup uses it
directly. The package bundles Python, FFmpeg, FFprobe, neural OCR weights and
both tracking models.
No Python, Node, uv, terminal commands or first-run model downloads are required
on the recipient's machine. The default build bundles CUDA 13.0 PyTorch for RTX 50-series GPUs, with CPU
execution when CUDA is unavailable. The recipient needs a compatible NVIDIA
display driver (580.88 or newer for CUDA 13.0), but no CUDA toolkit installation.
GPU memory usage and speed still need verification on the recipient's card.
For a smaller CPU-only installer, pass -TorchBackend cpu to the PowerShell script.
The optional legacy Tesseract OCR engine is not included; default neural OCR is.

## Building

Build on Windows x64, not macOS, because Python wheels and executables are
platform-specific. The developer/build machine needs Node 22 and uv, plus
internet access. Run npm ci, then npm run dist:win.

The build produces dist/Trybunx-Setup-VERSION-x64.exe plus
dist/trybunx-clip-hunter-VERSION-x64.nsis.7z. NSIS cannot embed installers
larger than 2 GB, which the CUDA runtime exceeds, so electron-builder uses its
nsis-web target. The installer downloads the package from TRYBUNX_PACKAGE_URL
(defaults to this repository's latest GitHub release asset). Set that variable
to your own hosting URL before distributing; ship both files together, or host
the package and publish the installer alone. With no URL set at build time and
no internet at install time, the package must sit next to the installer.

Alternatively run the Windows installer workflow from GitHub Actions. It runs manually or on
build/windows-* branches and uploads a workflow artifact; it does not publish a release.
Download the artifact ZIP, extract it, and give the installer (and the package,
or a hosted package URL) to the recipient.

The build stages a relocatable managed Python, locked Python dependencies,
checksum-verified tracking weights, FFmpeg and its published checksum, and
preloaded RapidOCR weights under .windows-build. It excludes the developer's
venv. FFmpeg currently follows Gyan's release archive; its checksum is verified
and recorded, but repeat builds can select a newer release. Python's 3.12 patch
and uv version also follow their available releases. This is not a fully
reproducible release pipeline yet.

## Verification and release status

The build checks the staged runtime after relocating it to a directory with
spaces, removing normal tool locations from PATH, disabling Python networking,
and running real OCR, both detectors, encoding, and probing. It also asserts
that the selected PyTorch runtime was bundled. Hosted Windows CI has no NVIDIA
GPU, so its detector checks exercise CPU execution, not actual RTX inference. The Windows
workflow repeats those checks against packaged resources, installs the NSIS
installer, and launches the installed Electron app.

Local macOS verification covers TypeScript, bundled binary resolution and
real FFmpeg crop commands in directories containing spaces. A successful
Windows workflow run is still required before calling an EXE tested.
The smoke footage does not establish real-match OCR/tracking quality or
performance on the recipient's hardware.

The current installer is unsigned. Windows may show an unknown-publisher or
SmartScreen prompt; trusted public distribution needs a signing setup.
Third-party Python distribution/package notices remain in the bundled files;
FFmpeg license/checksum and package inventory are included in resources/licenses.
The existing football checkpoint and Ultralytics are AGPL-3.0; retain their
notices and review distribution obligations before distributing releases.
