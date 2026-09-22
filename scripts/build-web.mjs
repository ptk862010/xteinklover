import esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["web/convert.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: true,
  outfile: "public/convert.js",
  logLevel: "info",
});
