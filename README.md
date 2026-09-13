# Tobi Aina — tobi.getpolisha.com

A static site. No build step, no dependencies, no package manager.
Vercel serves the files in this repository exactly as they are.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page. Markup only. |
| `styles.css` | The whole design system and every breakpoint. |
| `main.js` | Case-study tabs and the scroll reveal. Nothing else. |
| `assets/` | Real product screenshots and the portrait. Names blurred. |
| `fonts/` | IBM Plex Sans and Mono, latin subset, self-hosted. |
| `share.html` | Social-preview page served to crawlers. |
| `middleware.js` | Redirects social crawlers to `share.html`. |
| `vercel.json` | Rewrites: `/og-image.jpg` → `/image.jpg`, and the crawler rule. |
| `image.jpg` | The 1200×630 Open Graph image. |

## Local preview

```
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## The social preview — do not break this

Three things work together so that a shared link shows a preview card:

1. `index.html` carries `og:` and `twitter:` tags directly.
2. `vercel.json` rewrites a request from a known social crawler to `share.html`.
3. `middleware.js` does the same for crawlers that arrive before the rewrite.

All three point at `/og-image.jpg`, which `vercel.json` rewrites to `/image.jpg`.
If you rename `image.jpg`, update the rewrite and both sets of tags, then retest
with the LinkedIn Post Inspector and the Facebook Sharing Debugger.

## Facts used on the page

Only these, and nothing beyond them:

- Direct Apply has three role-based portals on one source of truth.
- 85 database tables, 204 production migrations.
- Tobi designed, built and operates the system.
- CA$500 diagnostic; CA$3,500–6,000 build; CA$500–900/month optional support.
- First three complete builds at CA$2,500 in exchange for a testimonial,
  permission to show blurred work and one 30-minute case-study conversation.
- Contact: tobaina@gmail.com

The page makes no revenue claim and names no client.

## Design rules

IBM Plex Sans and IBM Plex Mono, served from `fonts/` rather than Google
Fonts, so the typography is identical on networks that block
`fonts.googleapis.com` and there is no flash of fallback text.
White surfaces, light blue utility areas,
navy product frame, Polisha blue (`#1763d7`, shared with verdict.getpolisha.com)
for actions and selected states only.

Not used, deliberately: serif type, italics, gradient headline text, coloured
words inside headings, glass or blurred surfaces, decorative blobs, floating
fake dashboards, invented interface graphics.

Every text colour pair on the page clears WCAG AA contrast (4.5:1).
