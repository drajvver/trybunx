# Wydanie dla Windows x64

Gotowe pliki są dostępne w sekcji Releases repozytorium:

- `Trybunx-Setup-0.2.0-windows-x64.exe` — pełny instalator z polskim interfejsem. Uruchom plik i przejdź przez instalację.
- `Trybunx-0.2.0-windows-x64.zip` — aplikacja bez instalatora. Rozpakuj **cały** ZIP do zwykłego folderu, a następnie uruchom `TrybunaTV AI Clip Hunter.exe`. Zachowaj pozostałe pliki i folder `resources` obok aplikacji.
- `SHA256SUMS.txt` — sumy kontrolne plików.

Wymagany jest Windows 10/11, 64-bitowy procesor Intel lub AMD. Pakiet zawiera własny Python, biblioteki Visual C++ i OCR/ONNX, modele rozpoznawania wyniku i śledzenia akcji oraz FFmpeg/FFprobe. Standardowa analiza działa bez instalowania osobnych narzędzi i bez pobierania modeli przy pierwszym użyciu. Obliczenia działają na procesorze; karta NVIDIA nie jest wymagana. Opcjonalny, techniczny tryb Tesseract wymaga osobnej instalacji Tesseract; nie jest domyślnie używany.

Wyniki analizy trafiają do folderu `Dokumenty/TrybunaTV`. Wersja ZIP korzysta z tych samych ustawień użytkownika co wersja instalowana; nie przechowuje ustawień wewnątrz folderu aplikacji.

Instalator nie ma podpisu cyfrowego. Windows może wyświetlić ostrzeżenie o nieznanym wydawcy. Przed uruchomieniem sprawdź, czy plik pochodzi z tego repozytorium.

## Budowanie przez programistę

Na Windows x64 z Node.js 22, `uv` i Visual Studio 2022 z narzędziami C++:

```powershell
npm ci
npm run typecheck
npm run dist:win
```

Skrypt przygotowuje przenośny Python 3.12, instaluje zależności z `python/uv.lock`, pobiera i sprawdza sumę kontrolną FFmpeg oraz modelu śledzenia, a także zapisuje modele OCR. `electron-builder.windows.yml` pakuje wyłącznie przygotowane zasoby Windows, nigdy lokalne środowisko `.venv`.

Workflow `.github/workflows/windows.yml` buduje na Windows, testuje zasoby po przeniesieniu do ścieżki ze spacjami z odciętą siecią Python, następnie instaluje aplikację i sprawdza pełną analizę syntetycznego meczu przez IPC aplikacji. Test uruchomionej aplikacji usuwa Python i FFmpeg z PATH oraz nadpisania ścieżek narzędzi. Oczekuje trzech klipów poziomych i trzech pionowych. Gotowe EXE, ZIP i sumy kontrolne zostają zapisane jako artefakt `Trybunx-Windows-x64`.
