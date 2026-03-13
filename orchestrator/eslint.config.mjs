import tseslint from "typescript-eslint"
import * as effectPlugin from "@effect/eslint-plugin/plugin"

export default tseslint.config(
  { ignores: ["dist/"] },
  ...tseslint.configs.recommended,
  {
    plugins: { "@effect": effectPlugin },
    rules: {
      "@effect/no-import-from-barrel-package": "error",
      "@typescript-eslint/no-explicit-any": "error",
      // Unused vars with _ prefix are intentional (e.g. _sit in interrupt conditions)
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
    },
  },
)
