// Dynamic Expo config. Keeps app.json as the base and injects the catalog URL
// from the environment, so the deployed Worker URL is never committed — the
// open-source source stays generic, and a specific build (e.g. this repo's CI)
// pre-wires its own backend via the CARDSCAN_CATALOG_URL environment variable.
// Self-hosters either set that variable or enter their URL in the app's
// Settings screen.
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...(config.extra ?? {}),
    catalogUrl: process.env.CARDSCAN_CATALOG_URL ?? '',
  },
});
