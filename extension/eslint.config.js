import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(js.configs.recommended, tseslint.configs.recommended, prettier, {
  ignores: ["dist/**", "node_modules/**"],
});
