# TrybunaTV AI Clip Hunter

TrybunaTV AI Clip Hunter pomaga szybko znaleźć bramki i najciekawsze momenty
w gotowym nagraniu meczu piłkarskiego. Wybierasz nagranie, zaznaczasz wynik na
ekranie, a aplikacja tworzy gotowe klipy.

Nie musisz znać się na montażu ani ustawieniach technicznych.

## Jak używać aplikacji

1. Otwórz aplikację i wybierz nagranie meczu.
2. W sekcji **Obszar wyniku** ustaw czas, w którym wynik jest widoczny, a potem
   zaznacz go prostokątem na klatce nagrania.
3. Wybierz **Rozpocznij analizę** i poczekaj na zakończenie.
4. W sekcji **Wyniki** zobaczysz znalezione bramki oraz interesujące momenty.
   Kliknij nazwę klipu, aby odnaleźć go w folderze.

To wszystko. Zaznaczony obszar wyniku zostanie zapamiętany na przyszłość.

## Co otrzymasz

Po zakończeniu analizy aplikacja tworzy folder z wynikami. Znajdziesz w nim:

- klipy bramek w oryginalnym poziomym formacie;
- pionowe klipy 9:16, gotowe do publikacji w mediach społecznościowych;
- listę wykrytych zdarzeń;
- folder z pełnymi wynikami analizy.

Przy pierwszym tworzeniu pionowego klipu aplikacja pobierze niewielki model do
śledzenia piłki. Wymaga to jednorazowo połączenia z internetem; później model
jest używany z dysku.

Pionowy klip podąża za piłką, gdy jest ona dobrze widoczna. Jeżeli kamera
pokazuje szeroki fragment boiska, a piłka nie jest pewnie wykryta, aplikacja
zachowuje całe ujęcie na rozmytym tle zamiast wycinać bramkę z kadru.

## Interesujące momenty

Domyślnie aplikacja tworzy klipy dla potwierdzonych bramek. Potrafi też
znaleźć głośne, emocjonujące fragmenty na podstawie reakcji trybun i
komentarza.

Jeżeli chcesz tworzyć klipy także dla takich momentów, otwórz
**Opcjonalne ustawienia** i zaznacz **Twórz klipy dla interesujących momentów
wykrytych wyłącznie przez dźwięk**.

## Gdy wynik nie jest wykrywany

- Zaznacz możliwie mały prostokąt obejmujący tylko wynik, bez logo stacji i
  zegara.
- Wybierz moment, w którym wynik nie jest zasłonięty przez grafikę lub
  powtórkę.
- Jeżeli nagranie nie ma dźwięku, aplikacja nadal może wykryć bramki po zmianie
  wyniku, ale nie znajdzie momentów opartych wyłącznie na emocjach dźwiękowych.

## Ustawienia

Większość osób nie musi ich zmieniać. Sekcja **Opcjonalne ustawienia** pozwala
między innymi dostosować czułość dźwięku, długość klipów i sposób kadrowania
pionowego nagrania. Zmiany są zapisywane lokalnie na komputerze.

## Pomoc techniczna

Instrukcje dla osób rozwijających projekt, wymagania instalacyjne, testy i opis
techniczny są w [docs/technical](docs/technical/README.md).

## Gotowa aplikacja dla Windows x64

Instalator EXE i pełny ZIP są dostępne w [wydaniach GitHub](https://github.com/drajvver/trybunx/releases). Nie trzeba osobno instalować Pythona ani FFmpeg. Wersję ZIP należy rozpakować w całości przed uruchomieniem aplikacji. [Instrukcja i opis budowania](docs/windows-packaging.md).
