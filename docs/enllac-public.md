# Enllaç públic: seguir els subtítols des de fora (imesde.app/subtitolsXXXXXXXX)

Algú que no és a la sala (o que hi és, amb el mòbil) obre `https://imesde.app/subtitolsXXXXXXXX` i hi llegeix
els subtítols **en l'idioma que l'operador ha triat per a aquell enllaç**. `XXXXXXXX` és un token únic, generat
un sol cop; l'adreça és sempre la mateixa, acte rere acte.

Hi ha dues meitats, en dos repositoris:

| Meitat | On | Què fa |
|---|---|---|
| **Emissor** | aquest repo (`enllac.mjs`, panell) | envia el text cap a imesde.app mentre hi ha sessió |
| **Relleu + pàgina** | repo de l'agenda (imesde.app, Next.js a Vercel) | rep el text, el reparteix i serveix la pàgina pública |

El servidor de subtítols és darrere la xarxa del recinte: **sempre és ell qui truca cap a fora** (HTTPS sortint).
imesde.app no s'hi connecta mai.

## Clau i token

- La **clau d'emissió** (`clau`) és un secret de 32 caràcters o més. La genera imesde.app (només un
  administrador amb sessió) i s'enganxa un sol cop al panell de Subtítols. Qui la té pot escriure al feed.
- El **token** (`XXXXXXXX`, 8 caràcters `[a-z2-7]`) és el que surt a l'adreça pública. Qui el té només pot llegir.
- El token es **deriva** de la clau al servidor de imesde.app amb un secret que només té ell
  (p. ex. `base32(HMAC-SHA256(secret, "subtitols-v1:" + clau))` → 8 primers caràcters). Així no cal desar res
  a cap base de dades, i qui coneix el token (qualsevol espectador) no en pot treure la clau ni escriure al feed.
- L'emissor no calcula mai el token: el pregunta (`GET`, a sota).

## API de imesde.app (la que fa servir l'emissor)

Base: `https://www.imesde.app` (l'emissor la pot canviar amb `ENLLAC_URL`, per a proves i per al preview).
Totes dues amb `Authorization: Bearer <clau>`.

### `GET /api/subtitols/feed` — «qui soc?»

Comprova la clau i diu quina adreça pública li toca. L'emissor la crida en desar la clau i en engegar.

```
200 { "token": "k3f7q2ma", "url": "https://imesde.app/subtitolsk3f7q2ma" }
401 { "error": "…" }      clau no vàlida
```

### `POST /api/subtitols/feed` — l'estat d'ara

Cos JSON (com a molt uns 6 KB). **Cada enviament porta l'estat sencer** (no deltes): si se'n perd un, el següent
ho arregla.

```jsonc
{
  "v": 1,
  "boot": "mk3a9x",        // canvia quan el servidor de subtítols es reinicia (i «seq» torna a començar)
  "seq": 1234,             // creix a cada enviament; el relleu descarta els que arribin desordenats (mateix boot, seq més petit)
  "now": 1795092187321,    // rellotge de l'emissor (ms). Els t0/tEnd són en aquest mateix rellotge
  "running": true,         // hi ha sessió en marxa
  "hidden": false,         // l'operador ha amagat la pantalla o no escolta (música, descans): no s'ha d'ensenyar text
  "lang": "en",            // idioma del text (ISO 639-1): el que l'operador ha triat per a aquest enllaç
  "clearAt": 0,            // ms; si > 0, fora tot bloc amb t0 < clearAt («Netejar pantalla»)
  "blocks": [              // les últimes frases amb text (màx. 8), de més vella a més nova
    { "id": 41, "text": "Good evening, everyone.", "final": true,  "t0": 1795092180000, "tEnd": 1795092183000, "speaker": "Marta Puig" },
    { "id": 42, "text": "Tonight we have",          "final": false, "t0": 1795092184000, "tEnd": 1795092186900, "speaker": null }
  ]
}
```

- Un bloc amb `final: false` és la frase que s'està dient: el seu `text` canvia a cada enviament (normalment
  creix; de tant en tant es reescriu). Quan passa a `final: true` encara pot canviar un cop (la traducció
  definitiva). El `id` és estable dins d'un mateix `boot`.
- `speaker` pot ser `null`.
- Les frases velles **no s'esborren soles** de la llista: després d'un silenci llarg, les últimes 8 poden ser de
  fa minuts. La pàgina decideix què ensenya amb `now - tEnd` (la sala esborra el text al cap d'uns 8 s sense
  canvis; per a qui llegeix en un mòbil pot ser més generós, p. ex. 20–30 s).
- `text` fa com a molt 600 caràcters per frase.

Respostes: `204` (rebut), o bé `200 { "viewers": 3 }` si el relleu sap quanta gent té la pàgina oberta ara
(opcional: el panell ho ensenya a l'operador) · `401` (clau no vàlida) · `400`/`413` (cos mal fet o massa gran) · `429` amb
`Retry-After` (massa de pressa).

**Ritme de l'emissor**: només quan canvia alguna cosa i com a molt un enviament cada 400 ms (si n'hi ha un en
curs, s'espera i s'envia l'estat més nou: no fa cua); un batec cada 10 s mentre hi ha sessió; un últim enviament
amb `running: false` en aturar. Temps màxim per petició 5 s; si falla, torna-hi amb espera creixent fins a 10 s.
Un error del relleu **no afecta mai** els subtítols de la sala.

## El que ha de fer imesde.app amb això

- **Pàgina pública** `https://imesde.app/subtitols<token>` (sense sessió, `noindex`, pensada per a mòbil i per
  a un portàtil): el text gros, les últimes frases, la que s'està dient ben visible; que es mogui sola. Si
  `running` és fals o fa més de ~25 s que no arriba res: «Ara no hi ha subtítols en directe». Si `hidden`: res de
  text nou (pausa). Que no deixi adormir la pantalla (Wake Lock) i que es reconnecti sola.
- **Repartiment**: de l'últim estat rebut cap a les pàgines obertes, amb el mínim retard raonable (objectiu:
  menys d'1 s afegit). SSE amb l'estat sencer a cada missatge, o el que encaixi millor amb el que ja té l'agenda.
- **Caducitat**: l'estat d'un token s'oblida al cap d'una estona sense batecs (no és cap arxiu).
- **Generar claus**: només administradors amb sessió; es veu un cop la clau i l'adreça que li correspon.
- Un token desconegut o sense estat: la mateixa pàgina, amb «Ara no hi ha subtítols en directe» (no un 404 que
  delati quins tokens existeixen).

## Proves sense imesde.app

`node proves/relleu.mjs` fa de imesde.app en aquest ordinador (mateixa API i una pàgina mínima):
`ENLLAC_URL=http://localhost:4396` al servidor de subtítols, i la clau que el mateix programa escriu en engegar.
