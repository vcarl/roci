import tseslint from "typescript-eslint"
import * as effectPlugin from "@effect/eslint-plugin/plugin"

export default tseslint.config(
  { ignores: ["dist/"] },
  ...tseslint.configs.recommended,
  {
    plugins: { "@effect": effectPlugin },
    rules: {
      "@effect/no-import-from-barrel-package": "error",
      // Effect's generic interfaces use `any` defaults for type params (S = any, Sit = any)
      "@typescript-eslint/no-explicit-any": "off",
      // Unused vars with _ prefix are intentional (e.g. _sit in interrupt conditions)
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
    },
  },
)
