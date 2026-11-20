# AdTwin backend (Neon Function `adtwinapi`)

Node 24 function on Neon project gentle-art-93331887, branch main.
URL: https://br-small-night-a10aqywd-adtwinapi.compute.c-1.ap-southeast-1.aws.neon.tech/

Build: `npm i jose@5.9.6 esbuild` then
`npx esbuild index.ts --bundle --minify --platform=node --target=node24 --format=esm --banner:js="import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);" --outfile=dist/index.mjs`
and zip `dist/index.mjs` as `index.mjs`. Deploy with `neon functions deploy adtwinapi` or the Neon API.

Environment variables (set in Neon, never committed): HEYGEN_API_KEY, ANTHROPIC_API_KEY, META_APP_ID, META_APP_SECRET, optional META_CONFIG_ID, META_GRAPH_VERSION.
