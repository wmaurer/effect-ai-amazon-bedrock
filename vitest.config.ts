import * as path from "node:path"
import { defineConfig, mergeConfig, type ViteUserConfig } from "vitest/config"

const integrationTestsEnabled = process.env.EFFECT_INTEGRATION_TESTS === "1"

const exclude = [
  "**/.*/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/coverage/**",
  "**/test/utils/**",
  ...(!integrationTestsEnabled ? ["**/*.integration.test.{ts,tsx}"] : []),
  "**/*.d.ts",
  "**/*.config.*",
  "**/vitest.*"
]

const shared: ViteUserConfig = {
  server: {
    watch: {
      ignored: exclude
    }
  },
  resolve: {
    tsconfigPaths: true
  },
  test: {
    exclude,
    passWithNoTests: true,
    setupFiles: [path.join(import.meta.dirname, "vitest.setup.ts")],
    sequence: {
      concurrent: true
    },
    include: ["test/**/*.test.{ts,tsx}"]
  }
}

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      mergeConfig(shared, {
        root: "packages/amazon-bedrock",
        test: { name: "@wmaurer/effect-ai-amazon-bedrock" }
      })
    ]
  }
})
