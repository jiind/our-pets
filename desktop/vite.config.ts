import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const gsapNotice = readFileSync(new URL('./node_modules/gsap/gsap-core.js', import.meta.url), 'utf8').match(/\/\*![\s\S]*?\*\//)?.[0];
if (!gsapNotice) {
  throw new Error('GSAP 원본 라이선스 고지를 찾지 못했습니다.');
}

export default defineConfig({
  clearScreen: false,
  build: {
    license: { fileName: 'licenses/frontend.txt' },
    rolldownOptions: {
      output: {
        postBanner: `${gsapNotice}\n/* Additional dependency notices: licenses/frontend.txt and licenses/dependencies.txt */`,
      },
    },
  },
  server: {
    watch: { ignored: ['**/src-tauri/**', '**/test-results/**'] },
  },
});
