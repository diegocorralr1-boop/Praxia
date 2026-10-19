// ESLint flat config. The app is classic browser scripts (no bundler), tests are Node CommonJS.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "fonts/**", "dist/**"] },
  js.configs.recommended,
  {
    files: ["app.js", "legal.js", "legal-config.js", "config.js", "aviso-pacientes.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, supabase: "readonly" },
    },
    rules: {
      // The app's style is dense; keep ESLint focused on real bugs.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-useless-escape": "warn",
      "no-cond-assign": "off",
      "no-undef": "error",
      "no-redeclare": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "eqeqeq": ["warn", "smart"],
    },
  },
  {
    files: ["tests/**/*.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { "no-unused-vars": ["warn", { args: "none" }] },
  },
];
