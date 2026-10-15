# Subtítols en directe · prova amb OpenAI

Eina local per provar si OpenAI serveix per fer subtítols d'un acte en directe
(català, castellà i anglès). No té res a veure amb l'app de l'agenda: no toca
cap base de dades ni cap entorn.

## ★ L'app: «Subtítols IMESDE» (a Aplicacions)

La manera recomanada d'usar-la. És el mateix servidor de sempre, embolcallat:
- **Doble clic i prou**: obre el panell (cap Terminal).
- **El servidor es vigila**: si cau, es torna a engegar en 1 s i els subtítols continuen sols.
- **El Mac no s'adorm** mentre l'app és oberta.
- **Pantalla del públic** (botó «Obrir pantalla ↗» o Cmd+P): s'obre sola a la **pantalla externa** i a
  pantalla completa; si es desendolla l'HDMI i es torna a endollar, hi torna sola (Cmd+Maj+P la hi torna a mà).
- **Una finestra penjada es recarrega sola**; el panell, a més, continua enviant l'àudio sense cap clic.
- **No es pot tancar a mitja sessió** sense confirmar-ho.
- Menú **Guió → Carregar guió…** (un `guio.json` fet amb `guio.mjs`) i **Retirar el guió**.
- **La clau d'OpenAI** es demana en una finestra i es desa **xifrada al Clauer de macOS** (`clau.xifrada`,
  il·legible fora d'aquest Mac i d'aquesta app). Cap `.env`: si n'hi havia un, l'app la hi passa i l'esborra.
  Menú → «Canviar la clau d'OpenAI…» / «Esborrar la clau d'aquest Mac…». Després de refer l'app, macOS
  pot tornar a demanar permís per al Clauer (contrasenya + «Permetre sempre"): l'app espera fins que es contesta.
- Les dades viuen a **`~/Library/Application Support/Subtitols-IMESDE`**: `clau.xifrada`, `guio.json`, `sessions/`,
  `app.log` (menú → «Obrir la carpeta de dades»).
- El primer cop, macOS demana permís per al **micròfon**: cal dir que sí.
- Per refer l'app després de canviar el codi: `npm run empaqueta` → `dist/`.

Pla B: si l'app no arrenca, tanca-la i fes servir `npm run acte` com sempre (no poden anar alhora: el port és el mateix).

## Multicanal (fins a 8 ponents o més)

Chrome (i per tant el panell) només captura **2 canals** de qualsevol targeta. Per a més canals, a
«01 Entrada» tria una targeta del grup **«Multicanal (captura nativa)»**: la llegeix un programa natiu de
macOS (`bin/captura`, font a `nadiu/captura.swift`) amb tots els canals (targeta física, Dante Virtual
Soundcard, Loopback, BlackHole…). A «04 Ponents», cada ponent al seu canal i, si vols, amb el seu idioma.
La captura la fa el servidor: si el panell es tanca o es penja, l'àudio continua entrant; si la targeta
desapareix, es reintenta sola.

## Actualitzacions (des de GitHub)

Repositori públic: <https://github.com/eruizimade/subtitols-imesde> (només codi: cap clau, cap guió,
cap material de clients). Branca principal: **`estable`**.

**A l'app**: en obrir-se mira si hi ha una versió nova i pregunta; també menú → «Comprovar
actualitzacions…». Mai s'actualitza amb els subtítols en marxa. Només es baixa el **codi** (servidor,
panell, pantalla) i se'n comprova la suma SHA-256: la clau (al Clauer), el guió, les tipografies i les
sessions **no es toquen**, i macOS no torna a demanar permisos. Si la versió nova no arrenca, l'app torna
sola a l'anterior (i al menú hi ha «Tornar a la versió anterior»).

**Publicar una versió** (des d'aquesta carpeta):
1. Canvia el codi, puja `version` a `package.json` (i `shellMin` si has canviat `app/` de manera que
   les apps velles no ho puguin fer anar: aquelles hauran de reinstal·lar l'app sencera).
2. `git commit` i `git push origin estable`.
3. `npm run publica -- "Què canvia"` → fa la release a GitHub amb el codi i l'app sencera.

## ⚠ El dia de l'acte

0. **Guió** (si n'hi ha): prepara'l ABANS d'arrencar (vegeu «Guió de l'acte» més avall). El panell,
   a «04 Context», diu quin guió hi ha carregat: comprova que és el d'avui.
1. Obre l'app **Subtítols IMESDE** (o, pla B, al Terminal `cd ~/Desktop/"cute scripts/subtitols openai"` i
   **`npm run acte`**, i no tanquis aquella finestra).
2. Si la clau no és vàlida, el panell surt amb una **barra vermella** que ho diu (i el registre, «✓ Clau d'OpenAI vàlida»).
3. Mac **endollat**, tapa oberta, sense mode de baix consum. A Chrome: Configuració → Rendiment →
   **Estalvi de memòria i Estalvi d'energia apagats** (si no, Chrome pot adormir la pestanya).
4. Notificacions del Mac en **No molestar** (no han de sortir damunt de la pantalla projectada).
5. Si entres per la **taula de so**, «Millora de veu» **apagada**. Sota el nivell ha de dir
   «senyal net (sense filtres)».
6. Obre **un sol** panell de captura.
7. **La pantalla**: si pots, surt per HDMI d'aquest mateix Mac amb «Obrir pantalla ↗» (és el camí
   més segur). En un altre ordinador (`http://IP:4321/pantalla`, **sense paràmetres**: amb
   paràmetres a la URL el panell deixa de manar-hi):
   - prova **al recinte i abans** que s'hi arriba: moltes xarxes Wi-Fi de recintes aïllen els
     ordinadors entre ells. Millor per cable.
   - aquell ordinador no pot impedir que s'adormi: treu-li el repòs de pantalla i el salvapantalles
     (`caffeinate -dis` en un Mac; a Windows, Energia → «Mai»).
   - obre-la **quan el servidor ja estigui en marxa** i **no la recarreguis** durant l'acte (si cal:
     comprova que el servidor respon i després doble clic per a pantalla completa).
8. Prova ràpida abans de començar: parla, mira que surti el text, i desendolla i torna a endollar
   la targeta: el panell s'ha de posar vermell i recuperar-se sol.

### Què fa sola durant l'acte

- **Música llarga sense parlar**: no s'atura (abans s'aturava als 10 minuts).
- **Tall de Wi-Fi o del servidor**: el panell es reconnecta i torna a enviar l'àudio sol.
- **Targeta desendollada**: alarma vermella i la torna a obrir quan torna.
- **OpenAI talla cada sessió als 60 minuts**: es renova sola cap als 50, aprofitant una pausa, i
  l'àudio de mentre es reconnecta es guarda i no es perd.
- **Barra vermella al panell** = alguna cosa no va (diu què). **Taronja** = avís (p. ex. fa estona
  que no surt text: normal si sona música).
- Aturar demana **dos clics**.
- **Música llarga o descans**: botó **«Pantalla visible / AMAGADA»** de la capçalera (o «amagar pantalla» a «05 Pantalla»): el sistema segueix
  escoltant, però al públic no li surt res (la música fa que el model s'inventi text). Desmarca-ho
  quan torni a parlar algú. Mentre està amagada, el panell té una barra taronja que ho recorda.
- **Si recarregues el panell**: prem **«Continuar aquí ▶»** de seguida (sense això no s'envia àudio).
  No premis «Començar»: començaria una sessió nova.
- Prova de resistència sense acte: `npm run resistencia -- 70 sessions/<un>.wav --silenci-cada=10 --silenci-min=4 --talla-panell-cada=15`

## Guió de l'acte (parts guionitzades)

Amb el text que llegiran, la traducció d'aquelles parts surt molt millor (noms, termes, registre).

1. Desa el guió com a **text pla** (`guio.txt`, UTF-8). Una frase o paràgraf per línia. Les
   acotacions entre `[ ]` o `( )`, els números de línia i les etiquetes de qui parla
   («PRESENTADORA:») es treuen soles.
2. `node guio.mjs guio.txt --de=ca` (llengua en què es llegirà; `--a=ca,es,en` per defecte).
   Fa `guio.json` (el que fa servir el servidor) i `guio-revisio.txt` (per llegir-lo).
3. Revisa `guio-revisio.txt`. Si hi corregeixes res (o hi enganxes traduccions oficials):
   `node guio.mjs --de-revisio guio-revisio.txt`.
4. Arrenca el servidor: ha de dir «✓ Guió carregat: N frases». Si canvies el guió amb el servidor
   en marxa, el recarrega sol (els noms per a la transcripció entren a la renovació següent).
5. **Després de l'acte, reanomena `guio.json`** (p. ex. `guio-2026-10-15.json`): si no, el pròxim
   acte el faria servir.

Si el ponent se n'aparta, es tradueix el que diu de debò; si una frase no s'assembla a res del guió,
funciona com sempre.

## Carta (prompter): el guió sencer baixant mentre es llegeix

Com als programes de traducció simultània: en comptes dels subtítols del que es diu, la pantalla
ensenya **el guió sencer** (una carta, un parlament) en els idiomes de «Subtítols en», en columnes
una al costat de l'altra, i **baixa sol a mesura que el ponent el llegeix**. La frase que es llegeix
queda en blanc a l'alçada de lectura; les llegides i les que vénen, apagades.

1. Cal un **guió carregat** (el mateix de sempre: menú Guió → Carregar guió…).
2. Panell → **06 Carta** → **Carta** (tornar a **Subtítols** quan s'acabi la lectura).
3. **seguir la veu** (encès per defecte): la carta avança sola amb el que es transcriu — cal que la
   sessió estigui en marxa i «Escoltant». Tolera paraules menjades o mal transcrites i frases saltades;
   no salta enrere per casualitat.
4. L'operador sempre mana: **clic a una frase** de la llista, **◀ Anterior / Següent ▶**, **Al principi**,
   o un **comandament de presentacions** (envia Av Pàg / Re Pàg; el panell ha de ser la finestra activa).
   Si s'apaga «seguir la veu», només avança a mà.
5. Fons, tipografia, mida, àrea, colors per idioma, «original» i «amagar pantalla» valen igual.
   **Posició** decideix l'alçada de lectura (Dalt / Mig / Baix).

Per URL (sense panell): `/pantalla?view=carta`.

## Posar-la en marxa

1. Crea un fitxer `.env` en aquesta carpeta:
   ```
   OPENAI_API_KEY=sk-...
   ```
2. `npm start`
3. Obre amb **Chrome**:
   - http://localhost:4321/captura — el panell de control (tria l'entrada, el canal i comença)
   - http://localhost:4321/pantalla — el que es projecta (doble clic = pantalla completa)

La pantalla es pot obrir des d'un altre ordinador de la mateixa xarxa canviant
`localhost` per la IP d'aquest Mac.

## Modes de transcripció (al panell)

- **Equilibrat** (recomanat): `gpt-live-transcribe`, retard baix.
- **Ràpid**: el mateix model amb el retard mínim; s'equivoca una mica més.
- **Whisper**: `gpt-realtime-whisper`; només amb un senyal molt net.

La traducció la fa `gpt-4.1-mini`, frase a frase i en paral·lel per llengua.

## Opcions de la pantalla

Normalment **cap**: la pantalla segueix el que es tria al panell. Els paràmetres de la URL hi manen
per sobre (i aleshores el panell ja no la controla), només per a casos especials:
`/pantalla?langs=ca,es,en&src=1&size=4.2&tags=0&clear=7&lines=2&dwell=2.5&theme=dark&pos=bottom`

## Ajustos (al `.env`, opcionals)

```
TRANSLATE_MODEL=gpt-4.1-mini   # model de traducció
TRANSCRIBE_MODEL=…             # força un model de transcripció
IDLE_COMMIT_MS=1100            # silenci que tanca una frase
IDLE_STOP_MIN=0                # aturar-se sol després de N min sense text (0 = mai)
ROTATE_MIN=50                  # renova la sessió d'OpenAI (que en talla als 60)
COMMIT_PAUSE_MS=600            # pausa que tanca un tros cap a OpenAI (0 = no)
GUIO=altre.json                # un altre fitxer de guió
PORT=4321
```

## Registre

Cada sessió deixa un fitxer a `sessions/` amb cada frase, les traduccions i quant
ha trigat la traducció: serveix per revisar la qualitat després de l'acte.

## Consells per a la prova

- Millor un senyal net de la taula (bus de veu/presentador) que un micro d'ambient:
  la música fa que el model s'inventi text.
- Omple el camp «Context» amb noms d'intèrprets i obres.
- Per provar sense acte: «Tria un fitxer…» + «Reproduir ▶» amb l'enregistrament d'un acte passat.
