# The Tony Hawk Paradox: launch site

Scroll-driven single-page site. The skater completes a 1080 as the visitor
scrolls, twelve chapter panels render in from the star field, and the landing
raises an email signup panel from a halfpipe.

## Files

- `index.html` : structure, chapter copy, signup form
- `style.css` : palette, type, panel states, mobile and reduced-motion rules
- `main.js` : Three.js scene, GSAP ScrollTrigger timeline, Lenis, form handling
- `assets/skater.glb` : the 3D skater model (1.4 MB, textures stripped)
- `assets/cover.png` : book cover, used for the social card and no-WebGL fallback

## Deploy

Static site, no build step. Upload all files to GitHub Pages keeping the
folder structure. `skater.glb` and `cover.png` must both sit inside `assets/`.

## The skater model

`assets/skater.glb` is your Meshy model with the photo textures stripped out,
which took it from 10.1 MB to 1.4 MB. The textures were never visible anyway,
since the model renders as glowing edges or wireframe.

The model is a static mesh, not rigged. That is fine here: the skater holds one
pose and spins as a rigid body, so no bones are needed.

If the model fails to load for any reason, the scene falls back to a hand-built
box figure so the page never renders empty.

## Style toggle (temporary)

A control in the bottom left lets you compare three treatments:

- **Glowing edges** : dark body with bright blue edge lines (current default)
- **Wireframe** : see-through blue mesh
- **Rim light** : dark solid lit from behind so the silhouette catches a blue edge

Once you pick one:
1. Set `DEFAULT_STYLE` in `main.js` to `'edges'`, `'wire'`, or `'rim'`
2. Delete the `#style-toggle` div in `index.html`
3. Delete the toggle CSS block at the bottom of `style.css`
4. Delete the toggle wiring block at the bottom of `main.js`

## Tuning the model

Three constants near the top of the skater section in `main.js`:

- `MODEL_SCALE` : raise or lower if the figure reads too big or small
- `MODEL_TILT` : extra x-rotation if the pose sits at a wrong angle
- `DEFAULT_STYLE` : which treatment loads by default

## Still to do

- **Formspree ID** : search `index.html` for `YOUR_FORM_ID` and paste in your
  real form ID. Until then the signup form will not deliver anywhere.
- **Chapter teasers** : each panel has an `EDIT: final teaser` comment
- **Chapter icons** : inline SVGs, swap for images if you want

## Fallback paths

Retest these after any change:
- Reduced motion: static layout, one rendered frame, no scroll-jacking
- No WebGL: gradient background, cover art hero, all panels visible
- Mobile: native scroll, lower particle counts, lower pixel ratio

## SEO / GEO / going live

The site is built to be found by both traditional search and AI answer engines (ChatGPT, Perplexity, Gemini, Google AI Overviews).

### What's in place

- Full meta tags: title, description, canonical URL, Open Graph, Twitter Card, all pointing at `https://tonyhawkparadox.com/`
- `robots.txt`: allows standard search engines and AI crawlers by default (both citation/retrieval bots and training bots). The reasoning is documented in the file itself. If you'd rather opt out of AI training specifically while keeping citation visibility, the file tells you exactly which four lines to flip.
- `sitemap.xml`: single entry for the one page.
- Structured data (JSON-LD) for `Book`, `Person` (you), and `FAQPage`, so AI systems and Google can extract accurate facts directly rather than guessing from prose.
- A visible FAQ panel (footer, next to "About the author") with the same four questions and answers as the FAQ structured data. Keep these two in sync if you edit one.
- Favicon and touch icons, built from the triangle emblem on the book cover's board graphic.
- `llms.txt`: a plain-text summary for AI systems. Worth flagging honestly: as of this writing there's no solid evidence this file materially affects what gets retrieved or cited. It's here because it's low-cost and some tools recommend it, not because it's proven to matter.
- `CNAME`: required for GitHub Pages to serve a custom domain.

### One real strength worth knowing

All of the chapter and FAQ text lives directly in the page's HTML, not injected by JavaScript after load. That matters because a common way sites accidentally become invisible to AI crawlers is hiding their real content behind JS that bots don't execute. This site doesn't have that problem.

### To actually go live at tonyhawkparadox.com

1. Buy/point the domain's DNS at GitHub Pages (an A record to GitHub's IPs, or a CNAME record to `dmb333.github.io`, per GitHub's custom domain docs).
2. In the repo's GitHub Pages settings, set the custom domain to `tonyhawkparadox.com` (this should auto-detect from the `CNAME` file once it's pushed) and enable "Enforce HTTPS."
3. After DNS propagates, submit `https://tonyhawkparadox.com/sitemap.xml` to Google Search Console and Bing Webmaster Tools.
4. Once you have a real Formspree ID confirmed working and a release date, update the FAQ answer and the `Book` schema in `<head>` with the real date rather than leaving it open-ended.
