import { copyFileSync } from "node:fs";
copyFileSync(
  new URL("../../contracts/v2/protocol.schema.json", import.meta.url),
  new URL("../dist/protocol.schema.json", import.meta.url),
);

copyFileSync(
  new URL("../../contracts/translation-catalog.json", import.meta.url),
  new URL("../dist/translation-catalog.json", import.meta.url),
);
