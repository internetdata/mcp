import { svc, typeChecked } from "@mslm/libjs-eslint-config";

export default [
  { ignores: ["dist/**", "node_modules/**", "spec/**", "integration/**", "src/generated/**", "**/*.gen.ts"] },
  ...svc,
  typeChecked(import.meta.dirname),
];
