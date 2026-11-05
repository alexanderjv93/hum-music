# Hum

Generate songs from a sentence or your own lyrics, powered by [SunoAPI.org](https://docs.sunoapi.org/).
A static front end with one Netlify Function. There are no dependencies and no build step.

## Deploy on Netlify

1. Import this repository. The settings in `netlify.toml` are picked up automatically.
2. Under **Site configuration > Environment variables**, add:

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `SUNO_API_KEY` | Yes | Your SunoAPI.org key. Never commit it. |
   | `ACCESS_CODE` | Recommended | Visitors must enter this code to generate. Without it, anyone with the URL can spend your credits. |

3. Redeploy so the variables take effect.

## Layout

- `public/`: the page, styles and browser code
- `netlify/functions/api.mjs`: keeps the key on the server and forwards requests to Suno

## Run locally

```bash
SUNO_API_KEY=your-key npx netlify-cli dev
```
