import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://chenmochaos.github.io',
  integrations: [mdx()],
  vite: {
    plugins: [tailwindcss()],
    // 图谱依赖是滚动到图谱时才开始动态 import 的。预打包它们，避免开发时第一次
    // 滚动到图谱才触发 Vite 重新优化依赖、整页 reload 的 504。
    optimizeDeps: {
      include: ['sigma', 'graphology', 'd3-force'],
    },
  },
  output: 'static',
  markdown: {
    shikiConfig: {
      theme: 'github-dark',
    },
  },
});
