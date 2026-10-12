import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// YAML 的空值写法（`description:` 后面什么都不写）解析出来是 null，而 `.optional()` 只接受 undefined、
// `.default()` 也只对 undefined 生效——「留空」恰恰是最自然的写法，不归一化会让 astro build 直接退出 1。
// 用 preprocess 折成 undefined，而不是 `.nullish()`：后者把 null 放行到页面层，BaseLayout 的描述兜底失效，
// 渲染出空的 <meta name="description">。
const blankAsAbsent = (schema) =>
  z.preprocess((value) => {
    if (value === null) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value;
  }, schema);

const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: blankAsAbsent(z.string().optional()),
    pubDate: blankAsAbsent(z.coerce.date()),
    tags: blankAsAbsent(z.array(z.string()).optional()),
    draft: blankAsAbsent(z.boolean().default(false)),
    syncedFrom: blankAsAbsent(z.string().optional()),
  }),
});

export const collections = { posts };
