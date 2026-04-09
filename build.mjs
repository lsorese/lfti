#!/usr/bin/env node

import { Client } from '@notionhq/client'
import { NotionToMarkdown } from 'notion-to-md'
import { marked } from 'marked'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, 'out')
const IMAGES_DIR = path.join(OUT_DIR, 'images')
const ROOT_PAGE_ID = 'd54e04487d2e48b4a96584b977fedeba'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

if (!process.env.NOTION_TOKEN) {
  console.error(
    'NOTION_TOKEN is required.\n' +
      '1. Create an integration at https://www.notion.so/my-integrations\n' +
      '2. Share your root page with the integration\n' +
      '3. Put the token in .env as NOTION_TOKEN=ntn_...'
  )
  process.exit(1)
}

const notion = new Client({ auth: process.env.NOTION_TOKEN })
const n2m = new NotionToMarkdown({ notionClient: notion })

// Custom transformer: render bookmark blocks as rich link cards
n2m.setCustomTransformer('bookmark', async (block) => {
  const url = block.bookmark?.url
  if (!url) return ''
  const og = await fetchOgData(url)
  return await buildBookmarkCard(url, og)
})

// Custom transformer: render embed blocks (Spotify, Apple Music, Bandcamp, etc.)
n2m.setCustomTransformer('embed', async (block) => {
  const url = block.embed?.url
  if (!url) return ''
  return await buildEmbed(url)
})

// Custom transformer: render video embeds
n2m.setCustomTransformer('video', async (block) => {
  const url = block.video?.external?.url || block.video?.file?.url
  if (!url) return ''
  return await buildEmbed(url)
})

// Map section database IDs to category filters
// These databases are linked views that aren't directly accessible via the API,
// so we populate them from "All Pages" entries using the Category property.
const SECTION_DB_CATEGORIES = {
  '9a612bf3-8728-4ce3-ba67-0790faf78763': ['Albums', 'Music', 'Review'], // Music
  'f970b3b8-7caf-4b53-95bd-c77b35579a74': ['Letters'],                   // Letters
  '6be6129a-77e9-4b76-b814-3a9f86d8d6aa': ['Short Story', 'Writing']     // Short Stories
}

// Page ID -> { title, slug } for inter-page linking
const pageMap = new Map()

// OG data cache
const ogCache = new Map()

// ---------------------------------------------------------------------------
// Open Graph / Bookmark helpers
// ---------------------------------------------------------------------------

async function fetchOgData(url) {
  if (ogCache.has(url)) return ogCache.get(url)
  const fallback = { title: url, description: '', image: '', siteName: '' }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StaticSiteBot/1.0)' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow'
    })
    if (!res.ok) { ogCache.set(url, fallback); return fallback }
    const html = await res.text()

    const get = (property) => {
      // Match both property="og:X" and name="og:X"
      const re = new RegExp(
        `<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']*?)["']|<meta[^>]*content=["']([^"']*?)["'][^>]*(?:property|name)=["']${property}["']`,
        'i'
      )
      const m = html.match(re)
      return m ? (m[1] || m[2] || '') : ''
    }

    const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)

    const data = {
      title: get('og:title') || (titleTag ? titleTag[1].trim() : '') || url,
      description: get('og:description') || get('description'),
      image: get('og:image'),
      siteName: get('og:site_name') || new URL(url).hostname
    }
    ogCache.set(url, data)
    return data
  } catch {
    ogCache.set(url, fallback)
    return fallback
  }
}

async function buildBookmarkCard(url, og) {
  let imgSrc = og.image || ''
  // Resolve relative OG image URLs against the source URL
  if (imgSrc && !imgSrc.startsWith('http')) {
    try {
      imgSrc = new URL(imgSrc, url).href
    } catch {
      imgSrc = ''
    }
  }
  // Download OG image locally so it doesn't break
  if (imgSrc && imgSrc.startsWith('http')) {
    imgSrc = await downloadImage(imgSrc)
    // If download failed and returned the original http URL, skip it
    if (imgSrc.startsWith('http')) imgSrc = ''
  }
  const imgHtml = imgSrc
    ? `<div class="bookmark-image"><img src="${escapeHtml(imgSrc)}" alt="" loading="lazy"></div>`
    : ''
  const desc = og.description
    ? `<div class="bookmark-desc">${escapeHtml(og.description.slice(0, 200))}</div>`
    : ''
  return `<a href="${escapeHtml(url)}" class="bookmark-card${imgSrc ? '' : ' no-image'}" target="_blank" rel="noopener noreferrer">
  <div class="bookmark-content">
    <div class="bookmark-title">${escapeHtml(og.title)}</div>
    ${desc}
    <div class="bookmark-url">${escapeHtml(og.siteName || new URL(url).hostname)}</div>
  </div>
  ${imgHtml}
</a>`
}

async function fetchBandcampEmbedId(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StaticSiteBot/1.0)' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow'
    })
    if (!res.ok) return null
    const html = await res.text()

    // Look for tralbum ID in the page — several possible patterns
    // 1. <meta property="og:video" content="...track=XXXX...">
    const ogVideo = html.match(/og:video[^>]*content="[^"]*(?:track|album)=(\d+)/)
    if (ogVideo) return { id: ogVideo[1], type: html.includes('/album/') ? 'album' : 'track' }

    // 2. data-tralbum-id="XXXX"
    const tralbum = html.match(/data-tralbum-id="(\d+)"/)
    if (tralbum) return { id: tralbum[1], type: html.includes('/album/') ? 'album' : 'track' }

    // 3. "id":XXXX in the TralbumData script
    const tralbumData = html.match(/TralbumData\s*=\s*\{[^}]*"id"\s*:\s*(\d+)/)
    if (tralbumData) return { id: tralbumData[1], type: html.includes('/album/') ? 'album' : 'track' }

    // 4. look in any script or meta for album= or track= pattern
    const embedParam = html.match(/(?:track|album)=(\d{5,})/)
    if (embedParam) {
      const type = embedParam[0].startsWith('album') ? 'album' : 'track'
      return { id: embedParam[1], type }
    }

    return null
  } catch {
    return null
  }
}

async function buildEmbed(url) {
  try {
    const u = new URL(url)
    const host = u.hostname

    // Spotify
    if (host.includes('spotify.com')) {
      const embedUrl = url.replace('open.spotify.com/', 'open.spotify.com/embed/')
      return `<div class="embed"><iframe src="${escapeHtml(embedUrl)}" width="100%" height="352" frameborder="0" allowtransparency="true" allow="encrypted-media" loading="lazy"></iframe></div>`
    }

    // Apple Music
    if (host.includes('music.apple.com')) {
      const embedUrl = url.replace('music.apple.com', 'embed.music.apple.com')
      return `<div class="embed"><iframe src="${escapeHtml(embedUrl)}" width="100%" height="450" frameborder="0" allow="autoplay *; encrypted-media *;" sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-top-navigation-by-user-activation" loading="lazy"></iframe></div>`
    }

    // Bandcamp — handle already-embedded URLs and scrape for embed IDs
    if (host.includes('bandcamp.com')) {
      // If the URL is already an embed URL, use it directly
      const existingEmbed = url.match(/EmbeddedPlayer\/(album|track)=(\d+)/)
      if (existingEmbed) {
        const isAlbum = existingEmbed[1] === 'album'
        return `<div class="embed"><iframe src="${escapeHtml(url.startsWith('http') ? url : 'https://' + url)}" width="100%" height="${isAlbum ? 472 : 120}" frameborder="0" seamless loading="lazy"></iframe></div>`
      }

      process.stdout.write(`  Fetching Bandcamp embed ID for ${u.pathname}... `)
      const info = await fetchBandcampEmbedId(url)
      if (info) {
        console.log(`got ${info.type}=${info.id}`)
        const isAlbum = info.type === 'album'
        const height = isAlbum ? 472 : 120
        const size = isAlbum ? 'size=large' : 'size=large'
        return `<div class="embed"><iframe src="https://bandcamp.com/EmbeddedPlayer/${info.type}=${info.id}/${size}/bgcol=1a1410/linkcol=8b6914/tracklist=false/transparent=true/" width="100%" height="${height}" frameborder="0" seamless loading="lazy"></iframe></div>`
      }
      console.log('failed, using fallback link')
      return `<div class="embed"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="embed-fallback">${escapeHtml(url)}</a></div>`
    }

    // YouTube
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      let videoId = u.searchParams.get('v')
      if (host.includes('youtu.be')) videoId = u.pathname.slice(1)
      if (videoId) {
        return `<div class="embed embed-video"><iframe src="https://www.youtube.com/embed/${escapeHtml(videoId)}" width="100%" height="400" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`
      }
    }

    // Fallback
    return `<div class="embed"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="embed-fallback">${escapeHtml(url)}</a></div>`
  } catch {
    return `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'untitled'
  )
}

function getTitle(page) {
  const titleProp = Object.values(page.properties).find(
    (p) => p.type === 'title'
  )
  return titleProp?.title?.map((t) => t.plain_text).join('') || 'Untitled'
}

function getDate(page) {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === 'date' && prop.date?.start) return prop.date.start
  }
  return page.created_time?.slice(0, 10)
}

function getCategories(page) {
  const cat = page.properties?.Category
  if (!cat) return []
  if (cat.type === 'multi_select') return cat.multi_select?.map((s) => s.name) || []
  if (cat.type === 'select') return cat.select ? [cat.select.name] : []
  return []
}

function getCoverUrl(page) {
  if (!page.cover) return null
  if (page.cover.type === 'external') return page.cover.external.url
  if (page.cover.type === 'file') return page.cover.file.url
  return null
}

async function getAllBlocks(blockId) {
  const blocks = []
  let cursor
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100
    })
    blocks.push(...res.results)
    cursor = res.has_more ? res.next_cursor : undefined
  } while (cursor)
  return blocks
}

async function queryDatabase(dbId) {
  // Try dataSources.query first (official v5 SDK), fall back to blocks.children
  try {
    const pages = []
    let cursor
    do {
      const res = await notion.dataSources.query({
        data_source_id: dbId,
        start_cursor: cursor,
        page_size: 100
      })
      pages.push(...res.results)
      cursor = res.has_more ? res.next_cursor : undefined
    } while (cursor)
    return pages
  } catch (e) {
    console.log(`  ⚠ Database query failed (${e.code}), trying blocks.children fallback...`)
    const pages = []
    const blocks = await getAllBlocks(dbId)
    for (const block of blocks) {
      try {
        const page = await notion.pages.retrieve({ page_id: block.id })
        pages.push(page)
      } catch {
        // skip inaccessible pages
      }
    }
    return pages
  }
}

// ---------------------------------------------------------------------------
// Image downloading
// ---------------------------------------------------------------------------

async function downloadImage(url) {
  try {
    const hash = crypto.createHash('md5').update(url).digest('hex')
    const parsed = new URL(url)
    let ext = path.extname(parsed.pathname).split('?')[0] || '.png'
    if (ext.length > 5) ext = '.png'
    const filename = `${hash}${ext}`
    const filepath = path.join(IMAGES_DIR, filename)

    try {
      await fs.access(filepath)
      return `/images/${filename}`
    } catch {
      // not cached yet
    }

    const res = await fetch(url)
    if (!res.ok) return url
    const buffer = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(filepath, buffer)
    return `/images/${filename}`
  } catch (e) {
    console.warn(`  ⚠ failed to download image: ${url.slice(0, 80)}...`)
    return url
  }
}

async function processImages(html) {
  const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/g
  const matches = [...html.matchAll(imgRegex)]
  for (const match of matches) {
    const originalUrl = match[1]
    if (originalUrl.startsWith('http')) {
      const localUrl = await downloadImage(originalUrl)
      html = html.replaceAll(match[1], localUrl)
    }
  }
  return html
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

async function renderPageShallow(pageId) {
  // Render only top-level blocks, skipping child_page and child_database blocks.
  // Used for the index page to avoid inlining all child content.
  const blocks = await getAllBlocks(pageId)
  const kept = blocks.filter(
    (b) => b.type !== 'child_page' && b.type !== 'child_database'
  )

  // Convert only the kept blocks to markdown
  const mdParts = []
  for (const block of kept) {
    try {
      const mdBlock = await n2m.blockToMarkdown(block)
      if (mdBlock) {
        const text =
          typeof mdBlock === 'string' ? mdBlock : mdBlock.parent || ''
        if (text.trim()) mdParts.push(text)
      }
    } catch {
      // skip blocks that fail to convert
    }
  }
  const md = mdParts.join('\n\n')
  let html = await marked(md)
  html = await processImages(html)
  return html
}

async function renderPage(pageId) {
  const mdBlocks = await n2m.pageToMarkdown(pageId)
  const mdResult = n2m.toMarkdownString(mdBlocks)
  const md = typeof mdResult === 'string' ? mdResult : mdResult.parent

  let html = await marked(md)
  html = await processImages(html)

  // Replace Notion page links with local links
  for (const [notionId, info] of pageMap) {
    const bare = notionId.replace(/-/g, '')
    const patterns = [
      `https://www.notion.so/${bare}`,
      `https://notion.so/${bare}`,
      bare
    ]
    for (const p of patterns) {
      if (html.includes(p)) {
        html = html.replaceAll(p, `/${info.slug}.html`)
      }
    }
  }

  return html
}

// ---------------------------------------------------------------------------
// HTML template — matches the existing earthy/terminal design
// ---------------------------------------------------------------------------

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #1a1410;
  --bg-secondary: #261e15;
  --fg: #e0d5c0;
  --fg-muted: rgba(224,213,192,0.6);
  --fg-subtle: rgba(224,213,192,0.18);
  --accent: #c9a84c;
  --accent-hover: #dfc06a;
  --code-bg: #0f0c08;
  --code-border: #2e2419;
  --code-fg: #e0d5c0;
  --header-bg: rgba(26,20,16,0.95);
}

a { color: inherit; text-decoration: none; }

body {
  background: var(--bg);
  color: var(--fg);
  font-family: 'Space Mono', monospace;
  font-size: 14px;
  line-height: 1.6;
  letter-spacing: -0.01em;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

/* scrollbar */
::-webkit-scrollbar { width: 4px; height: 4px; background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--fg-subtle); }
::-webkit-scrollbar-track { background: var(--bg); }

/* skip link (accessibility) */
.skip-link {
  position: absolute;
  top: -100%;
  left: 16px;
  background: var(--accent);
  color: var(--bg);
  padding: 8px 16px;
  z-index: 200;
  font-weight: 700;
}
.skip-link:focus { top: 8px; }

/* header */
header {
  position: sticky; top: 0; z-index: 100;
  background: var(--header-bg);
  backdrop-filter: saturate(180%) blur(16px);
  -webkit-backdrop-filter: saturate(180%) blur(16px);
  border-bottom: 1px solid var(--fg-subtle);
}
.header-inner {
  max-width: 600px;
  margin: 0 auto;
  padding: 14px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.site-title { font-weight: 700; font-size: 14px; letter-spacing: -0.02em; }

/* main */
main {
  max-width: 600px;
  margin: 0 auto;
  padding: 32px 16px calc(max(5vh, 32px));
}
main.index-page { max-width: 600px; }

nav { margin-bottom: 24px; }
nav a {
  color: var(--fg-muted);
  border-bottom: 1px solid var(--accent);
}
nav a:hover { color: var(--fg); }

/* hero image on index */
img.index-hero-img {
  max-width: 400px !important;
  margin: 0 auto 1em;
  display: block;
}

/* index page title */
.index-title {
  font-size: 1.8em;
  text-align: center;
  letter-spacing: -0.03em;
  margin-bottom: 1em;
  line-height: 1.3;
}

/* page title */
.page-title {
  font-size: 1.8em;
  text-align: center;
  letter-spacing: -0.03em;
  margin-bottom: 1.5em;
  line-height: 1.3;
}

/* content typography */
.content h1 { font-size: 1.6em; margin: 1.5em 0 0.3em; letter-spacing: -0.02em; font-weight: 700; }
.content h2 { font-size: 1.3em; margin: 2em 0 0.3em; letter-spacing: -0.02em; font-weight: 700; }
.content h3 { font-size: 1.1em; margin: 1.5em 0 0.3em; letter-spacing: -0.02em; font-weight: 700; }
.content p { padding: 0.3em 0; line-height: 1.7; }

.content a {
  border-bottom: 0.1rem solid var(--accent);
  background: linear-gradient(90deg, var(--accent), var(--accent-hover)) no-repeat 50% 100% / 0 0.1rem;
  transition: background-position 300ms, background-size 300ms;
}
.content a:hover {
  border-bottom-color: transparent;
  background-position: 0 100%;
  background-size: 100% 0.1rem;
}

/* blockquote */
.content blockquote {
  margin: 0.75em 0;
  padding: 0.2em 0.75em;
  border-left: 2px solid var(--accent);
  font-style: normal;
  font-size: 13px;
  opacity: 0.85;
}

/* code */
.content pre {
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  color: var(--code-fg);
  font-size: 13px;
  line-height: 1.35;
  padding: 16px;
  overflow-x: auto;
  border-radius: 0;
  margin: 1em 0;
}
.content code {
  font-family: 'Space Mono', monospace;
  font-size: 0.9em;
}
.content p code,
.content li code {
  background: var(--bg-secondary);
  padding: 2px 5px;
  border-radius: 2px;
}
.content pre code {
  background: none;
  padding: 0;
  font-size: inherit;
}

/* images */
.content img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 1em auto;
}

/* hr */
.content hr {
  border: none;
  border-top: 1px solid var(--fg-subtle);
  margin: 1.5em 0;
}

/* lists */
.content ul, .content ol { line-height: 1.35; padding-left: 1.5em; margin: 0.5em 0; }
.content li { padding: 2px 0; }

/* tables */
.content table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 13px; }
.content th, .content td { border: 1px solid var(--fg-subtle); padding: 6px 10px; text-align: left; }
.content th { background: var(--bg-secondary); font-weight: 700; }

/* entries grid (index page gallery) */
.entries {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0;
  margin-top: 2em;
}

.entry { position: relative; overflow: hidden; }

.entry.has-cover .entry-cover {
  display: block;
  width: 100%;
  padding-bottom: 100%;
  position: relative;
  overflow: hidden;
}
.entry.has-cover .entry-cover img {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
  object-fit: cover;
  transition: filter 150ms linear;
}
.entry.has-cover:hover .entry-cover img {
  filter: brightness(110%);
}
.entry.has-cover .entry-info { display: none; }

.entry:not(.has-cover) {
  display: flex;
  align-items: center;
  padding: 12px;
  border: 1px solid var(--fg-subtle);
}
.entry-title { font-weight: 700; display: block; }
.entry-title:hover { color: var(--accent); }
.entry time { font-size: 12px; color: var(--fg-muted); display: block; margin-top: 2px; }

/* entries list (no covers) */
.entries-list { margin-top: 2em; list-style: none; padding: 0; }
.entries-list li { padding: 8px 0; border-bottom: 1px solid var(--fg-subtle); }
.entries-list li:last-child { border-bottom: none; }
.entries-list a { font-weight: 700; }
.entries-list a:hover { color: var(--accent); }
.entries-list time { font-size: 12px; color: var(--fg-muted); margin-left: 12px; }

/* embeds */
.embed {
  margin: 1em 0;
  border-radius: 0;
  overflow: hidden;
}
.embed iframe {
  display: block;
  border: none;
}
.embed-video {
  position: relative;
  padding-bottom: 56.25%;
  height: 0;
}
.embed-video iframe {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
}
.embed-fallback {
  display: block;
  padding: 12px 14px;
  border: 1px solid var(--fg-subtle);
  color: var(--fg-muted);
  font-size: 13px;
  word-break: break-all;
}
.embed-fallback:hover { border-color: var(--accent); color: var(--fg); }

/* page links on index */
.page-link {
  font-weight: 700;
  border-bottom: 1px solid var(--accent);
}
.page-link:hover { color: var(--accent); }

/* bookmark cards */
.bookmark-card {
  display: flex;
  border: 1px solid var(--fg-subtle);
  margin: 0.75em 0;
  overflow: hidden;
  transition: border-color 150ms;
  text-decoration: none;
  background: none !important;
  border-bottom: 1px solid var(--fg-subtle) !important;
}
.bookmark-card:hover { border-color: var(--accent) !important; }
.bookmark-content {
  flex: 1;
  padding: 12px 14px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bookmark-title {
  font-weight: 700;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bookmark-desc {
  font-size: 12px;
  color: var(--fg-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bookmark-url {
  font-size: 11px;
  color: var(--fg-muted);
  margin-top: auto;
}
.bookmark-image {
  width: 200px;
  flex-shrink: 0;
}
.bookmark-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

@media (max-width: 720px) {
  .entries { grid-template-columns: repeat(2, 1fr); }
  main { padding-left: 2vw; padding-right: 2vw; }
  .bookmark-image { width: 120px; }
}
@media (max-width: 480px) {
  .entries { grid-template-columns: repeat(2, 1fr); }
  .bookmark-image { display: none; }
}
`

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function htmlTemplate(
  title,
  content,
  { isIndex = false, entries = [], backLink = true } = {}
) {
  const nav =
    backLink && !isIndex ? '<nav><a href="/">← back</a></nav>' : ''

  const hasCoverEntries = entries.some((e) => e.coverLocal)

  let entriesHtml = ''
  if (entries.length > 0 && hasCoverEntries) {
    // Gallery grid (matches current 4-col image grid)
    entriesHtml = `<div class="entries">
      ${entries
        .map((e) => {
          const cover = e.coverLocal
            ? `<a href="/${e.slug}.html" class="entry-cover"><img src="${e.coverLocal}" alt="${escapeHtml(e.title)}" loading="lazy"></a>`
            : ''
          return `<div class="entry${e.coverLocal ? ' has-cover' : ''}">
            ${cover}
            <div class="entry-info">
              <a href="/${e.slug}.html" class="entry-title">${escapeHtml(e.title)}</a>
              ${e.date ? `<time>${new Date(e.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</time>` : ''}
            </div>
          </div>`
        })
        .join('\n')}
    </div>`
  } else if (entries.length > 0) {
    // Simple list fallback
    entriesHtml = `<ul class="entries-list">
      ${entries
        .map(
          (e) =>
            `<li><a href="/${e.slug}.html">${escapeHtml(e.title)}</a>${e.date ? `<time>${new Date(e.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}</time>` : ''}</li>`
        )
        .join('\n')}
    </ul>`
  }

  const pageUrl = isIndex ? 'https://loganfromtheinter.net/' : `https://loganfromtheinter.net/${slugify(title)}.html`
  const metaTitle = isIndex ? 'Logan, from the Internet.' : `${escapeHtml(title)} — Logan, from the Internet.`
  const metaDesc = isIndex
    ? 'The personal garden of Logan Sorese — music, letters, short stories, and more.'
    : `${escapeHtml(title)} — by Logan Sorese`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metaTitle}</title>
  <meta name="description" content="${metaDesc}">
  <meta name="author" content="Logan Sorese">
  <link rel="canonical" href="${pageUrl}">
  <meta property="og:type" content="${isIndex ? 'website' : 'article'}">
  <meta property="og:title" content="${metaTitle}">
  <meta property="og:description" content="${metaDesc}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:site_name" content="Logan, from the Internet.">
  <link rel="icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="128x128" href="/favicon-128x128.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/favicon-192x192.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
  <a href="#main-content" class="skip-link">Skip to content</a>
  ${!isIndex ? `<header role="banner">
    <div class="header-inner">
      <a href="/" class="site-title">Logan, from the Internet.</a>
    </div>
  </header>` : ''}
  <main id="main-content" class="${isIndex ? 'index-page' : 'page'}" role="main">
    ${nav}
    <article class="content">
      ${!isIndex ? `<h1 class="page-title">${escapeHtml(title)}</h1>` : ''}
      ${content}
      ${entriesHtml}
    </article>
  </main>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function copyDir(src, dest) {
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true })
      await copyDir(srcPath, destPath)
    } else {
      await fs.copyFile(srcPath, destPath)
    }
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function build() {
  console.log('Building static site...\n')

  // Clean & create output dirs
  await fs.rm(OUT_DIR, { recursive: true, force: true })
  await fs.mkdir(OUT_DIR, { recursive: true })
  await fs.mkdir(IMAGES_DIR, { recursive: true })

  // Copy public assets (favicon, images, etc.)
  const publicDir = path.join(__dirname, 'public')
  try {
    await copyDir(publicDir, OUT_DIR)
    console.log('✓ Copied public assets')
  } catch {
    console.log('⚠ No public/ directory found, skipping')
  }

  // 1. Fetch root page
  console.log('Fetching root page...')
  let rootPage
  try {
    rootPage = await notion.pages.retrieve({ page_id: ROOT_PAGE_ID })
  } catch (e) {
    console.error(
      `\nFailed to fetch root page. Make sure:\n` +
        `  1. Your NOTION_TOKEN is a valid integration token (starts with ntn_)\n` +
        `  2. The root page is shared with your integration\n` +
        `\nError: ${e.message}`
    )
    process.exit(1)
  }
  const rootTitle = getTitle(rootPage)
  console.log(`✓ Root page: "${rootTitle}"`)

  // 2. Discover all pages via search API (more reliable than crawling databases)
  console.log('Searching for all pages...')
  const entries = []
  const seenIds = new Set([ROOT_PAGE_ID])

  let cursor
  do {
    const res = await notion.search({
      filter: { property: 'object', value: 'page' },
      start_cursor: cursor,
      page_size: 100
    })
    for (const page of res.results) {
      if (seenIds.has(page.id)) continue
      seenIds.add(page.id)

      const title = getTitle(page)
      let slug = slugify(title)

      // Deduplicate slugs
      const existingSlugs = entries.map((e) => e.slug)
      if (existingSlugs.includes(slug)) {
        slug = `${slug}-${page.id.slice(0, 8)}`
      }

      const date = getDate(page)
      const coverUrl = getCoverUrl(page)

      const categories = getCategories(page)
      const parentDb = page.parent?.database_id || null

      pageMap.set(page.id, { title, slug })
      entries.push({ title, slug, date, coverUrl, categories, parentDb, pageId: page.id })
    }
    cursor = res.has_more ? res.next_cursor : undefined
  } while (cursor)

  console.log(`  Found ${entries.length} pages`)

  // Sort entries by date (newest first)
  entries.sort((a, b) => {
    if (!a.date && !b.date) return 0
    if (!a.date) return 1
    if (!b.date) return -1
    return b.date.localeCompare(a.date)
  })

  // 4. Download cover images
  for (const entry of entries) {
    if (entry.coverUrl) {
      process.stdout.write(`  Downloading cover: ${entry.title}... `)
      entry.coverLocal = await downloadImage(entry.coverUrl)
      console.log('done')
    }
  }

  // 5. Build structured index page by walking root blocks
  console.log('\nBuilding index page...')
  const rootBlocks = await getAllBlocks(ROOT_PAGE_ID)

  // Map database IDs to entries using Category property
  // The section databases (Music, Letters, Short Stories) are linked views
  // that aren't directly accessible, so we use categories to sort entries.
  const dbEntries = new Map()
  for (const entry of entries) {
    // Check if this entry matches any section database by category
    for (const [dbId, cats] of Object.entries(SECTION_DB_CATEGORIES)) {
      if (entry.categories.some((c) => cats.includes(c))) {
        if (!dbEntries.has(dbId)) dbEntries.set(dbId, [])
        dbEntries.get(dbId).push(entry)
      }
    }
    // Also map by actual parent database (for "All Pages" and others)
    if (entry.parentDb) {
      if (!dbEntries.has(entry.parentDb)) dbEntries.set(entry.parentDb, [])
      // Only add if not already mapped to a section database
      const alreadyMapped = Object.keys(SECTION_DB_CATEGORIES).some(
        (dbId) => dbEntries.get(dbId)?.includes(entry)
      )
      if (!alreadyMapped) {
        dbEntries.get(entry.parentDb).push(entry)
      }
    }
  }

  // Walk root blocks and build index HTML
  let indexContent = ''
  let isFirstImage = true
  for (const block of rootBlocks) {
    // Special handling: first image block is the hero, with site title above it
    if (block.type === 'image' && isFirstImage) {
      isFirstImage = false
      const imgUrl = block.image?.file?.url || block.image?.external?.url
      if (imgUrl) {
        const localImg = await downloadImage(imgUrl)
        indexContent += `<h1 class="index-title">Logan, from the Internet.</h1>\n`
        indexContent += `<img src="${localImg}" alt="Logan, from the Internet" class="index-hero-img">\n`
      }
      continue
    }
    if (block.type === 'child_database') {
      // Insert linked entries for this database
      const dbPages = dbEntries.get(block.id) || []
      if (dbPages.length > 0) {
        const withCovers = dbPages.filter((e) => e.coverLocal)
        const withoutCovers = dbPages.filter((e) => !e.coverLocal)

        // Gallery grid for entries with covers
        if (withCovers.length > 0) {
          indexContent += `<div class="entries">\n`
          for (const e of withCovers) {
            indexContent += `<div class="entry has-cover">
              <a href="/${e.slug}.html" class="entry-cover"><img src="${e.coverLocal}" alt="${escapeHtml(e.title)}" loading="lazy"></a>
              <div class="entry-info"><a href="/${e.slug}.html" class="entry-title">${escapeHtml(e.title)}</a></div>
            </div>\n`
          }
          indexContent += `</div>\n`
        }

        // List for entries without covers
        if (withoutCovers.length > 0) {
          indexContent += `<ul class="entries-list">\n`
          for (const e of withoutCovers) {
            indexContent += `<li><a href="/${e.slug}.html">${escapeHtml(e.title)}</a></li>\n`
          }
          indexContent += `</ul>\n`
        }
      }
    } else if (block.type === 'child_page') {
      // Render as a link
      const entry = entries.find((e) => e.pageId === block.id)
      if (entry) {
        indexContent += `<p><a href="/${entry.slug}.html" class="page-link">${escapeHtml(entry.title)}</a></p>\n`
      }
    } else if (block.type === 'bookmark') {
      // Render bookmark card
      const url = block.bookmark?.url
      if (url) {
        const og = await fetchOgData(url)
        indexContent += (await buildBookmarkCard(url, og)) + '\n'
      }
    } else if (block.type === 'embed' || block.type === 'video') {
      const url = block[block.type]?.url || block[block.type]?.external?.url
      if (url) {
        indexContent += (await buildEmbed(url)) + '\n'
      }
    } else {
      // Render normal blocks (headings, text, images, etc.)
      try {
        const mdBlock = await n2m.blockToMarkdown(block)
        const text = typeof mdBlock === 'string' ? mdBlock : mdBlock?.parent || ''
        if (text.trim()) {
          let html = await marked(text)
          html = await processImages(html)
          indexContent += html
        }
      } catch {
        // skip blocks that fail
      }
    }
  }

  // 6. Generate index.html
  const indexHtml = htmlTemplate(rootTitle, indexContent, {
    isIndex: true,
    entries: [],
    backLink: false
  })
  await fs.writeFile(path.join(OUT_DIR, 'index.html'), indexHtml)
  console.log('✓ index.html')

  // 7. Render and generate each page
  for (const entry of entries) {
    process.stdout.write(`  Rendering: ${entry.title}... `)
    try {
      const content = await renderPage(entry.pageId)
      const pageHtml = htmlTemplate(entry.title, content, { isIndex: false })
      await fs.writeFile(path.join(OUT_DIR, `${entry.slug}.html`), pageHtml)
      console.log('done')
    } catch (e) {
      console.log(`FAILED: ${e.message}`)
    }
  }

  // 8. Generate sitemap.xml
  const DOMAIN = 'https://loganfromtheinter.net'
  const today = new Date().toISOString().slice(0, 10)
  let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${DOMAIN}/</loc><lastmod>${today}</lastmod><priority>1.0</priority></url>
`
  for (const entry of entries) {
    sitemap += `  <url><loc>${DOMAIN}/${entry.slug}.html</loc><lastmod>${entry.date || today}</lastmod></url>\n`
  }
  sitemap += `</urlset>`
  await fs.writeFile(path.join(OUT_DIR, 'sitemap.xml'), sitemap)
  console.log('✓ sitemap.xml')

  // 9. Generate robots.txt
  await fs.writeFile(
    path.join(OUT_DIR, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${DOMAIN}/sitemap.xml\n`
  )
  console.log('✓ robots.txt')

  console.log(`\n✓ Built ${entries.length + 1} pages to ${OUT_DIR}/`)
}

build().catch((e) => {
  console.error('\nBuild failed:', e)
  process.exit(1)
})
