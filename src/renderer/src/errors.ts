const settingErrors: Record<string, string> = {
  'clips.max_clip_seconds': 'Najdłuższy klip: wpisz liczbę sekund większą od zera.',
  'vertical.track_sample_fps': 'Sprawdzanie położenia piłki: wpisz liczbę większą od zera i nie większą niż 30.',
  'vertical.ball_trust': 'Pewność rozpoznania piłki: wpisz liczbę od 0 do 1.',
  'vertical.ball_confirmation_frames': 'Liczba rozpoznań piłki: wpisz liczbę całkowitą co najmniej 1, np. 1, 2 lub 3.',
  'vertical.ball_lead_fraction': 'Położenie piłki w pionowym obrazie: wpisz liczbę od 0 do 0,5.'
}

/** Display plain Polish messages; keep configuration keys and external diagnostics in the console. */
export function userError(error: unknown, fallback: string): string {
  console.error(error)
  const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : ''
  const setting = message.match(/^([a-z_]+\.[a-z_/]+) musi /)?.[1]
  if (setting) {
    return settingErrors[setting] ?? 'Jedno z ustawień ma niedozwoloną wartość. Sprawdź wpisane liczby lub przywróć zalecane ustawienia.'
  }
  if (/^Nieprawidłowa (sekcja|wartość) (ustawień|ustawienia)/.test(message)) {
    return 'Nie udało się odczytać jednego z ustawień. Sprawdź wpisane wartości lub przywróć zalecane ustawienia.'
  }
  return /^(Nie |Nieprawidł|Czasy |Częstotliwość |Analiza )/.test(message) ? message : fallback
}
