# Marketing site

Static homepage for whichsitesuse.com, in the Moonlight design system (see the spec's brand section in Notion). No build step: Render serves this folder as is.

- `index.html`: the homepage. Copy is written and checked in MetaMonster (planned site "WhichSitesUse", page "Home"); keep the two in step when the copy changes.
- `styles.css`: Moonlight tokens (light and dark), type, buttons, tables.
- `lookup.js`: the free domain lookup. It calls `GET {wsu-api}/v1/domains/{domain}` (the API base is the `wsu-api` meta tag in `index.html`). Until that endpoint is public, it keeps the example result and says lookups open at launch.
- `assets/`: logo, favicons and touch icon from the final brand files.

Preview locally with any static server, for example `npx serve site`.

## Render

Static site, root directory `site`, no build command, publish directory `.`.
