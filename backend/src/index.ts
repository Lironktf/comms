import {buildApp} from "./app.js";

const app = await buildApp();

app.indexer?.start();
await app.server.listen({port: app.config.PORT, host: app.config.HOST});
app.server.log.info(
  {registry: app.config.VENDOR_REGISTRY_ADDRESS, attestations: app.config.ATTESTATION_REGISTRY_ADDRESS},
  "ACTP backend up",
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    app.server.log.info({sig}, "shutting down");
    await app.close();
    process.exit(0);
  });
}
