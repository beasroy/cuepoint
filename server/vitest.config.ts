import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // Tests seed from their own fixture, never the live catalogue: brands.test.ts asserts that
      // brand_a exists and that the database's catalogue hash matches the file's, so editing your
      // real brands would otherwise break the suite. dotenv does not override an already-set
      // variable, so this wins over .env. Resolved from the repo root by config.ts.
      CATALOGUE_PATH: "server/test/fixtures/brands.json",
    },
  },
});
