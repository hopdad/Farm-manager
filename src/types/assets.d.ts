// Side-effect stylesheet imports (e.g. 'maplibre-gl/dist/maplibre-gl.css') type-check even when
// next-env.d.ts hasn't been generated yet (it is gitignored; `next dev`/`next build` write it).
declare module '*.css';
