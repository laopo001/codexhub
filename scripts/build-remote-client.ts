import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { build, type Plugin } from "esbuild";

const outfile = "dist-node/ssh/remote-client.cjs";

await mkdir(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: ["src/cli/codexhubRemoteClient.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
  minify: false,
  treeShaking: true,
  plugins: [nodePtyStubPlugin()],
  logLevel: "silent"
});

const output = await readFile(outfile, "utf8");
if (output.includes("node_modules/.pnpm/node-pty")) {
  throw new Error("remote client bundle unexpectedly references node-pty");
}

const info = await stat(outfile);
console.error(`built SSH remote client: ${outfile} (${info.size} bytes)`);

function nodePtyStubPlugin(): Plugin {
  return {
    name: "codexhub-remote-client-node-pty-stub",
    setup(builder) {
      builder.onResolve({ filter: /^node-pty$/ }, () => ({
        path: "node-pty",
        namespace: "codexhub-remote-client-stub"
      }));
      builder.onLoad({ filter: /.*/, namespace: "codexhub-remote-client-stub" }, () => ({
        loader: "js",
        contents: [
          "export const spawn = () => {",
          "  throw new Error('node-pty is not available in the CodexHub SSH remote client bundle');",
          "};"
        ].join("\n")
      }));
    }
  };
}
