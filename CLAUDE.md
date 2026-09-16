# Blog - Personal Website

## Project Overview
Minus 的个人博客网站，集个人名片与文章发布于一体。黑色简约高级风格，参考 https://letters.thedankoe.com/。

## Tech Stack
- **Framework**: Astro v6 + MDX
- **Styling**: Tailwind CSS v4 (CSS-first config, 无 tailwind.config.mjs)
- **Animation**: CSS native transitions only (no JS animation libraries)
- **Deploy**: GitHub Pages (via GitHub Actions, static) — https://chenmochaos.github.io/
- **Package Manager**: pnpm

## Directory Structure
```
Blog/
├── src/
│   ├── layouts/
│   │   ├── BaseLayout.astro      # HTML shell, meta, global styles
│   │   └── PostLayout.astro      # Article detail page layout
│   ├── components/
│   │   ├── Hero.astro            # Name + tagline + social links
│   │   ├── About.astro           # Background, skills, current focus
│   │   ├── Projects.astro        # Project cards grid
│   │   ├── PostList.astro        # Article list with title/date/excerpt
│   │   ├── Footer.astro          # Contact info + links
│   │   └── SocialLinks.astro     # Reusable social icon links
│   ├── pages/
│   │   ├── index.astro           # Single-page home (all sections)
│   │   └── posts/
│   │       └── [...slug].astro   # Dynamic article detail page
│   ├── content/
│   │   └── posts/                # MDX article files
│   │       └── hello-world.mdx   # Example post
│   └── styles/
│       └── global.css            # Tailwind directives + custom base styles
├── public/
│   └── fonts/                    # Self-hosted fonts if needed
├── .github/
│   └── workflows/
│       └── deploy.yml            # GitHub Pages 构建 + 发布
├── astro.config.mjs
├── tsconfig.json
├── package.json
└── CLAUDE.md
```

## Naming Conventions
- Components: PascalCase (`PostList.astro`)
- Pages: kebab-case or `[...slug]` pattern
- MDX posts: kebab-case with date prefix optional (`hello-world.mdx`)
- CSS classes: Tailwind utility-first, avoid custom class names unless truly reusable
- Content collection: `posts` (singular noun collection name in config)

## Design System

### Colors (Dark Theme)
```
--bg-primary:    #0a0a0a    (page background)
--bg-secondary:  #141414    (cards, elevated surfaces)
--bg-tertiary:   #1a1a1a    (hover states, subtle backgrounds)
--border:        #262626    (dividers, card borders)
--text-primary:  #fafafa    (headings, body text)
--text-secondary:#a1a1a1    (dates, descriptions, muted text)
--text-tertiary: #6b6b6b    (footer, least important text)
--accent:        #e5e5e5    (links, highlights on hover)
```

### Typography
- **Font Family**: `Inter` (body) + `system-ui` fallback
- **Heading sizes**: Hero title 4xl-6xl, section titles 2xl-3xl, card titles lg-xl
- **Body**: base (16px), leading-relaxed
- **Weight**: 300 (body), 400 (normal), 600 (headings), 700 (hero title)
- **Letter spacing**: tight for headings, normal for body

### Spacing
- Section vertical padding: `py-20` to `py-32`
- Max content width: `max-w-2xl` (reading-optimized ~672px)
- Component gap: `space-y-6` to `space-y-8`

### Animations
- Page load: fade-in (`opacity 0→1, 0.6s ease`)
- Scroll reveal: elements fade-in + slight translateY (`20px→0, 0.5s`)
- Hover: color transitions (`0.2s ease`), subtle scale on project cards (`scale-[1.02]`)
- Links: underline slide-in on hover (CSS only)
- Page transitions: Astro View Transitions API (fade)

## Development Commands
```bash
pnpm dev          # Start dev server
pnpm build        # Build for production
pnpm preview      # Preview production build locally
```

## Content Authoring
Articles are MDX files in `src/content/posts/`. Frontmatter schema:
```yaml
---
title: "Article Title"
description: "Short excerpt for the list view"
pubDate: 2024-01-15
tags: ["web3", "dev"]
draft: false
---
```

## Rules
- No JS animation libraries — CSS transitions and Astro View Transitions only
- No component libraries (shadcn, etc.) — all components are hand-crafted
- Keep bundle size minimal: zero client-side JS by default, use `client:*` directives only when necessary
- Images must have explicit width/height or use Astro's `<Image>` component
- All colors from the design system, no hardcoded hex values outside Tailwind config
- Responsive: mobile-first, single breakpoint at `md` (768px) is enough for this layout
