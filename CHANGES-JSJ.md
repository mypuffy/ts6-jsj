# Umbau – Überblick (Deutsch)

## Musikbot (Kern komplett neu)
- **Streaming statt Komplett-Dekodierung**: Früher wurde jeder Track erst heruntergeladen und dann komplett als PCM in den RAM geladen (1-h-Set ≈ 700 MB). Jetzt wird live über FFmpeg gestreamt, max. ~10 s Puffer. Start nach 1–3 s.
- **SoundCloud**: Tracks, Sets, Likes, Profile, Suche (`scsearch`), „recommended“ für Autoplay. Bei SoundCloud wird die 128-kbps-Variante statt 64-kbps-Opus gewählt.
- Weitere Quellen: YouTube/YouTube Music, Bandcamp, Mixcloud, direkte MP3/OGG-Links, Spotify-Track-Links (werden per Suche gematcht), Radio, eigene Bibliothek.
- **Autoplay** (ähnliche Tracks, wenn die Queue leer ist), **Lautheits-Normalisierung**, Vorab-Auflösung des nächsten Tracks, **Auto-Recovery** bei Abbrüchen/abgelaufenen Links (macht an derselben Stelle weiter).
- **Auto-Pause**, wenn niemand im Channel ist, Auto-Resume, wenn jemand kommt.
- Ansage „Now playing …“ im Channel, Track im Nickname (beides abschaltbar).
- Queue: „als Nächstes“, Verschieben, Entfernen, Shuffle (rückgängig machbar), Repeat Track/Queue, Verlauf, eindeutige IDs (Duplikate kein Problem mehr).
- Bot per UI oder `!join` in anderen Channel holen – **ohne** Neuverbindung, Musik läuft weiter.
- Neue Chat-Befehle: `!sc`, `!yt`, `!search` + `!pick`, `!playnext`, `!playnow`, `!seek`, `!ff`, `!rw`, `!loop`, `!shuffle`, `!remove`, `!move`, `!clear`, `!autoplay`, `!history`, `!playlist`, `!join`, `!help`, `!vol +10`. Präfix pro Bot einstellbar.
- Einstellungen pro Bot: Standard-Suche (YouTube/SoundCloud), Autoplay, Normalisierung, Ansagen, Auto-Pause, Nickname-Anzeige, Befehls-Präfix.
- Settings → „Music sources“: yt-dlp-Version + Update-Button (wenn YouTube/SoundCloud plötzlich nicht mehr gehen).

## Design
- Neues Theme „Booth“: Graphit + Signal-Orange, Space Grotesk + JetBrains Mono, Hell/Dunkel.
- Neue Sidebar (Musik oben, Live-Badge, wenn ein Bot spielt), Glas-Header mit **Mini-Player** auf jeder Seite.
- Musik-Seite neu als **Studio**: Bot-Leiste, großer Player mit Cover/Blur-Hintergrund, Suche über YouTube/SoundCloud/Bibliothek/Radio, Queue + Verlauf, Befehlsübersicht.

## Flows & Templates
- „Voice Play“ kann jetzt Links/Suchtext (z. B. `{{event.command_args}}`), Radio-IDs und Modus now/next/queue; startet den Bot falls nötig.
- Neue Nodes: Now Playing Info, Voice Autoplay, Bot Channel Message. Neue Filter: `trunc:N`, `upper`, `lower`, `trim`, `json`.
- 11 neue Templates (neue Kategorie „Music“): Now-Playing-Channel, Song-Requests per `!request`, geplante Radio-/DJ-Show, Nachtlautstärke, „Music Follows Me“ (`!dj`), Channel-Jingle, Regeln für Gäste, geplante Ankündigung, `!help`, Discord-Join/Leave-Log, Join-Log.

## Datenbank
Neue Felder (MusicBot-Einstellungen, Song.thumbnail, MusicRequest.artist/source/requestedBy/playCount). Werden beim Container-Start per `prisma db push` automatisch angelegt – keine manuelle Migration nötig.

## Update
Wie bisher: `docker compose build && docker compose up -d` (Backend + Frontend neu bauen).

---

# Update 2 – Server-Templates & DJ-Funktionen

## Server-Templates (neue Seite „Server Templates“)
- **5 fertige Komplett-Layouts**: Gaming Community, Music & DJ Label, Clan/eSport, Streamer Community, Freundeskreis.
  Jedes enthält Channelbaum mit Spacern, Unterchannels, Max-Clients, Opus-Music-Channels, moderierte Channels
  (Talk Power), Join-Power-geschützte Team-Bereiche, AFK-Channel, Servergruppen mit Rechte-Presets und Icons.
- **Rechte-Presets** für Gruppen: Admin, Moderator, Support, VIP, Member, DJ, Streamer, Bot.
- **14 eigene Pixel-Icons** (Krone, Schild, Stern, Note, Roboter, Kopfhörer, Gamepad, AFK, Schloss …) –
  werden automatisch per TS-Dateitransfer hochgeladen und an Gruppen/Channels gesetzt.
- **Vorschau** (Trockenlauf): zeigt vorher, was angelegt/geändert würde.
- Optional: alle alten Channels löschen, fremde Gruppen löschen, Servername/Willkommensnachricht setzen,
  **Admin-Token** für die oberste Gruppe erzeugen.
- Mehrfach anwendbar: vorhandene Gruppen/Channels mit gleichem Namen werden aktualisiert statt doppelt angelegt.
- **Aktuellen Server als Template speichern** (Backup!), Templates als JSON herunterladen, bearbeiten, importieren.
- **Icons für bestehende Gruppen**: Icon (optional eigene Farbe oder eigenes PNG) auf jede Server-/Channelgruppe
  oder als Server-Icon setzen.
- Hinweis: Für Icons muss der Dateitransfer-Port des TS-Servers (Standard 30033/TCP) vom Panel aus erreichbar sein.

## Musikbot
- **DJ-Gruppen + DJ-Modus**: Steuerbefehle (skip, vol, stop, seek, clear …) nur für bestimmte Servergruppen.
- **!voteskip** – Mehrheit (einstellbar, Standard 50 % der Zuhörer) überspringt; Anfragender/DJ sofort.
- **Queue-Limit pro User** (DJs ausgenommen).
- **Equalizer**: Flat, Bass, Bass Boost, Techno/Schranz, Vocal, Treble, Night, Loud – im Player oder `!eq techno`.
- **Sleep-Timer**: im Player oder `!sleep 30`.
- **!save [Playlist]** speichert den laufenden Track (auch YouTube/SoundCloud, ohne Download) in „Favoriten“.
- **!top** / **!top users** – meistgewünschte Tracks / aktivste Wünscher.
- **Weiterspielen nach Neustart**: Queue + Position werden gespeichert und nach Panel-/Bot-Neustart fortgesetzt.
- `!remove` im DJ-Modus nur für eigene Tracks, `!dj` zeigt, ob man DJ ist.
