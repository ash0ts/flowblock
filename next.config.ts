import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone', poweredByHeader: false,
  turbopack: { root: process.cwd() }, serverExternalPackages: ['weave', 'pg'],
  outputFileTracingExcludes: { '/*': ['./.env*', './.data/**/*', './.git/**/*', './worker/**/*', './training/artifacts/**/*', './training/.venv/**/*', './wandb/**/*', './.art/**/*'] },
  outputFileTracingIncludes: { '/*': ['./training/results/summary.json', './node_modules/weave/**/*'] },
};
export default config;
