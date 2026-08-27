import { installVSCodeExtension } from "../src/core/vscodeExtensionInstaller.js";

const result = await installVSCodeExtension();
console.error(`installed VS Code extension in current host: ${result.localExtension}`);
if (result.localInsidersExtension) {
  console.error(`installed VS Code extension in current host Insiders: ${result.localInsidersExtension}`);
}
if (result.windowsExtension) {
  console.error(`installed VS Code extension in Windows host: ${result.windowsExtension}`);
}
if (result.windowsInsidersExtension) {
  console.error(`installed VS Code extension in Windows host Insiders: ${result.windowsInsidersExtension}`);
}
