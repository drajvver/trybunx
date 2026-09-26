# Dokumentacja techniczna

Ten katalog jest przeznaczony dla osób rozwijających projekt. Zwykli
użytkownicy powinni zacząć od [głównego przewodnika](../../README.md).

## Wymagania

- Node.js 20 lub nowszy;
- FFmpeg dostępny w systemie;
- `uv` do przygotowania środowiska Pythona.

```bash
npm install
npm run python:setup
npm run dev
```

Na macOS FFmpeg można zainstalować poleceniem `brew install ffmpeg`.

## Testy i build

```bash
npm run typecheck
npm test
npm run build
```

Test E2E generuje syntetyczne nagranie i wymaga FFmpeg z filtrem `drawtext`.

## Architektura

Electron i TypeScript obsługują aplikację, interfejs, analizę mediów oraz
generowanie klipów. Izolowany worker Pythona wykonuje OCR wyniku oraz śledzenie
piłki. FFmpeg odpowiada za odczyt i kodowanie materiałów.

Najważniejsze katalogi:

- `src/main/` — proces główny, potok analizy i obsługa plików wideo;
- `src/renderer/` — interfejs React;
- `src/shared/` — kontrakty i konfiguracja;
- `python/` — worker OCR i śledzenia;
- `config/default.yaml` — ustawienia domyślne.

Szczegółowe decyzje i historia zmian są w [JOURNAL.md](../../JOURNAL.md), a
oryginalne wymagania produktu w [prd.md](../../prd.md).
