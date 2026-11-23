import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts', piExtension: 'src/features/review/pi/piExtension.ts' },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
})
