import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DesktopCommanderClient } from "../src/desktop-commander-client.js";
import { buildToolManifest } from "@open-desktop-remote/tool-contracts";

const outputPath = fileURLToPath(
  new URL("../../tool-contracts/src/manifest.generated.json", import.meta.url),
);

const client = await DesktopCommanderClient.start();
try {
  const tools = await client.listTools();
  const manifest = buildToolManifest(tools);

  await writeFile(
    outputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
} finally {
  await client.close();
}
