# Operation Manager

En offline webapplikasjon for å administrere organisasjonsstruktur, personer og operasjoner. Appen er bygget for norsk politi og er inspirert av ArcGIS Enterprise-arbeidsflyt.

## 🚀 Kom i gang

Appen krever **ingen installasjon, ingen server og ingen byggeprosess**. Den kjører direkte i nettleseren.

### Kjør lokalt

1. Klon eller last ned repoet
2. Åpne `index.html` i en nettleser
3. Appen starter automatisk med tom database
4. Importer et av demo-datasettene via **Fil → Import JSON**

### Demo-datasett

| Fil | Beskrivelse |
|-----|-------------|
| `seed.json` | Minimal testdata (Politi, 2 distrikter, 3 ansatte, 2 operasjoner) |
| `seed_politiet_demo.json` | Stort politidemo-datasett |
| `seed_politiet_demo_oslofokus.json` | Politidemo med Oslo-fokus |
| `seed_politiet_demo_oslofokus_med_favoritter.json` | Oslo-demo inkl. favorittgrupper |

## 🌐 Live demo

Appen er tilgjengelig på GitHub Pages:  
👉 **https://christersandum.github.io/operationmanager/**

## 🧭 Funksjoner

- 🏢 **Avdelingshierarki** – naviger i trestruktur med underavdelinger
- 👤 **Personoversikt** – søk og filtrer ansatte per avdeling
- 📋 **Operasjonsstyring** – opprett og administrer operasjoner med status
- 👥 **Medlemmer** – legg til/fjern personer fra operasjoner, sett roller
- ⭐ **Favorittgrupper** – organiser nøkkelpersoner i egne grupper
- 📦 **Innholdskonfigurasjon** – velg applikasjonstype, kart, bakgrunnskart og tjenester per operasjon
- 📥 **Import / 📤 Eksport** – lagre og gjenopprette data som JSON
- 🔄 **Nullstill** – tøm all lokal data

## 👥 Brukerroller (demo-innlogging)

| Bruker | Profil | Tilgang |
|--------|--------|---------|
| `Einar` | Admin | Full tilgang – kan opprette, redigere og slette alt |
| `Nora Eide` | Viewer | Begrenset innsyn – ser kun egne operasjoner og medlemmer |

Bytt bruker via nedtrekksmenyen øverst til venstre, eller bruk URL-parameter: `?user=Nora%20Eide`

## 💾 Lagring

All data lagres lokalt i nettleseren via **IndexedDB** – ingen data sendes til noen server. Data beholdes mellom øktene, men er knyttet til den spesifikke nettleseren og enheten.

## 🗂️ Filstruktur

```
index.html          – App-skallet (HTML/UI)
app.js              – All applikasjonslogikk (~2300 linjer)
styles.css          – Styling
seed.json           – Minimalt testdatasett
seed_politiet_demo*.json  – Demo-datasett for norsk politi
```

## 🛠️ Teknologi

- Vanilla JavaScript (ingen rammeverk, ingen avhengigheter)
- IndexedDB for lokal datalagring
- HTML5 `<dialog>` for modaler
- CSS Grid/Flexbox for layout