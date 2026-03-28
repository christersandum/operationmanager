# Operasjonsadministrasjon – Politiet

A fully offline, browser-based operation management tool built for the Norwegian Police (Politiet).

## Live Demo

👉 **[https://christersandum.github.io/operationmanager/](https://christersandum.github.io/operationmanager/)**

## Features

- **Three-panel layout**: Departments (tree view) → People → Operations
- **Fully offline**: All data stored in IndexedDB (browser-local)
- **JSON import/export**: Full data round-trip via JSON files
- **Operation content config**: ArcGIS Enterprise integration settings (application types, basemaps, services)
- **Role-based membership**: Administrator, Leder, Deltaker, Innsyn per operation member
- **Favorites system**: Create custom groups of people independently from the org tree
- **Bulk add**: Add all people from a department or favorite group to an operation

## Getting Started

1. Open the app in your browser (use the GitHub Pages link above, or open `index.html` locally)
2. Click **Import JSON** and load one of the seed files:
   - `seed_politiet_demo.json` — basic demo data
   - `seed_politiet_demo_oslofokus.json` — Oslo-focused demo
   - `seed_politiet_demo_oslofokus_med_favoritter.json` — Oslo demo with favorites
3. Browse the department tree, select people, create operations, and manage memberships

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML + vanilla JavaScript |
| Storage | IndexedDB |
| Data exchange | JSON import/export |
| Styling | Custom dark-theme CSS |
| Hosting | GitHub Pages |

## Deployment

This is a static site — just enable GitHub Pages on the `main` branch and it works.
No build step required.
