import { svc, typeChecked } from "@mslmio/eslint-config";

export default [
  { ignores: ["dist/**", "node_modules/**", "spec/**", "integration/**", "src/generated/**", "**/*.gen.ts"] },
  ...svc,
  typeChecked(import.meta.dirname),
];
