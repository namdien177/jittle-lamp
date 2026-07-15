import { startCompanionServer } from "../../apps/desktop/src/companion/server";

await startCompanionServer();
await new Promise(() => undefined);
