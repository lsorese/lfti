#!/usr/bin/env node

import { Client } from '@notionhq/client'
import { NotionToMarkdown } from 'notion-to-md'
import { marked } from 'marked'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import { execSync } from 'child_process'

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
    ? `<div class="w-[200px] md:w-[200px] max-md:w-[120px] max-sm:hidden shrink-0"><img src="${escapeHtml(imgSrc)}" alt="" loading="lazy" class="w-full h-full object-cover block"></div>`
    : ''
  const desc = og.description
    ? `<div class="text-xs text-[rgba(217,201,160,0.6)] line-clamp-2">${escapeHtml(og.description.slice(0, 200))}</div>`
    : ''
  return `<a href="${escapeHtml(url)}" class="bookmark-card flex border border-[rgba(217,201,160,0.15)] my-3 overflow-hidden transition-colors duration-150 hover:border-[#c4982e]" target="_blank" rel="noopener noreferrer">
  <div class="flex-1 py-3 px-4 min-w-0 flex flex-col gap-1.5">
    <div class="font-bold text-sm truncate">${escapeHtml(og.title)}</div>
    ${desc}
    <div class="text-[11px] text-[rgba(217,201,160,0.6)] mt-auto">${escapeHtml(og.siteName || new URL(url).hostname)}</div>
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
      return `<div class="my-5 overflow-hidden"><iframe src="${escapeHtml(embedUrl)}" width="100%" height="352" frameborder="0" allowtransparency="true" allow="encrypted-media" loading="lazy" class="block border-0"></iframe></div>`
    }

    // Apple Music
    if (host.includes('music.apple.com')) {
      const embedUrl = url.replace('music.apple.com', 'embed.music.apple.com')
      return `<div class="my-5 overflow-hidden"><iframe src="${escapeHtml(embedUrl)}" width="100%" height="450" frameborder="0" allow="autoplay *; encrypted-media *;" sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-top-navigation-by-user-activation" loading="lazy" class="block border-0"></iframe></div>`
    }

    // Bandcamp — handle already-embedded URLs and scrape for embed IDs
    if (host.includes('bandcamp.com')) {
      // If the URL is already an embed URL, use it directly
      const existingEmbed = url.match(/EmbeddedPlayer\/(album|track)=(\d+)/)
      if (existingEmbed) {
        const isAlbum = existingEmbed[1] === 'album'
        return `<div class="my-5 overflow-hidden"><iframe src="${escapeHtml(url.startsWith('http') ? url : 'https://' + url)}" width="100%" height="${isAlbum ? 472 : 120}" frameborder="0" seamless loading="lazy" class="block border-0"></iframe></div>`
      }

      process.stdout.write(`  Fetching Bandcamp embed ID for ${u.pathname}... `)
      const info = await fetchBandcampEmbedId(url)
      if (info) {
        console.log(`got ${info.type}=${info.id}`)
        const isAlbum = info.type === 'album'
        const height = isAlbum ? 472 : 120
        const size = isAlbum ? 'size=large' : 'size=large'
        return `<div class="my-5 overflow-hidden"><iframe src="https://bandcamp.com/EmbeddedPlayer/${info.type}=${info.id}/${size}/bgcol=1a1410/linkcol=8b6914/tracklist=false/transparent=true/" width="100%" height="${height}" frameborder="0" seamless loading="lazy" class="block border-0"></iframe></div>`
      }
      console.log('failed, using fallback link')
      return `<div class="my-5 overflow-hidden"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="block py-3 px-4 border border-[rgba(217,201,160,0.15)] text-[rgba(217,201,160,0.6)] text-[13px] break-all hover:border-[#c4982e] hover:text-[#d9c9a0] transition-colors duration-150">${escapeHtml(url)}</a></div>`
    }

    // YouTube
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      let videoId = u.searchParams.get('v')
      if (host.includes('youtu.be')) videoId = u.pathname.slice(1)
      if (videoId) {
        return `<div class="my-5 overflow-hidden relative pb-[56.25%] h-0"><iframe src="https://www.youtube.com/embed/${escapeHtml(videoId)}" width="100%" height="400" frameborder="0" allowfullscreen loading="lazy" class="absolute inset-0 w-full h-full border-0"></iframe></div>`
      }
    }

    // Fallback
    return `<div class="my-5"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="block py-3 px-4 border border-[rgba(217,201,160,0.15)] text-[rgba(217,201,160,0.6)] text-[13px] break-all hover:border-[#c4982e] hover:text-[#d9c9a0] transition-colors duration-150">${escapeHtml(url)}</a></div>`
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
@font-face { font-family: 'Space Mono'; font-style: normal; font-weight: 400; font-display: swap; src: url(/fonts/space-mono-regular.woff2) format('woff2'); }
@font-face { font-family: 'Space Mono'; font-style: italic; font-weight: 400; font-display: swap; src: url(/fonts/space-mono-regular-italic.woff2) format('woff2'); }
@font-face { font-family: 'Space Mono'; font-style: normal; font-weight: 700; font-display: swap; src: url(/fonts/space-mono-bold.woff2) format('woff2'); }
@font-face { font-family: 'Space Mono'; font-style: italic; font-weight: 700; font-display: swap; src: url(/fonts/space-mono-bold-italic.woff2) format('woff2'); }
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
    backLink && !isIndex ? '<nav class="mb-7"><a href="/" class="text-[rgba(217,201,160,0.6)] border-b border-[#c4982e] hover:text-[#d9c9a0] transition-colors duration-200">&larr; back</a></nav>' : ''

  const hasCoverEntries = entries.some((e) => e.coverLocal)

  let entriesHtml = ''
  if (entries.length > 0 && hasCoverEntries) {
    entriesHtml = `<div class="grid grid-cols-4 max-md:grid-cols-2 gap-0.5 mt-8">
      ${entries
        .map((e) => {
          if (e.coverLocal) {
            return `<div class="relative overflow-hidden group">
              <a href="/${e.slug}.html" class="block w-full pb-[100%] relative overflow-hidden">
                <img src="${e.coverLocal}" alt="${escapeHtml(e.title)}" loading="lazy" class="absolute inset-0 w-full h-full object-cover transition-all duration-150 group-hover:brightness-110">
              </a>
            </div>`
          }
          return `<div class="flex items-center p-3 border border-[rgba(217,201,160,0.15)]">
            <div>
              <a href="/${e.slug}.html" class="font-bold block hover:text-[#c4982e] transition-colors duration-150">${escapeHtml(e.title)}</a>
              ${e.date ? `<time class="text-xs text-[rgba(217,201,160,0.6)] block mt-1">${new Date(e.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</time>` : ''}
            </div>
          </div>`
        })
        .join('\n')}
    </div>`
  } else if (entries.length > 0) {
    entriesHtml = `<ul class="mt-5 list-none p-0 space-y-1.5">
      ${entries
        .map(
          (e) =>
            `<li><a href="/${e.slug}.html" class="font-bold hover:text-[#c4982e] transition-colors duration-150">${escapeHtml(e.title)}</a>${e.date ? `<time class="text-xs text-[rgba(217,201,160,0.6)] ml-3">${new Date(e.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}</time>` : ''}</li>`
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
  <style>${CSS}__TAILWIND_CSS__</style>
</head>
<body class="bg-[#1c1508] text-[#d9c9a0] font-mono text-sm leading-7 tracking-tight antialiased overflow-x-hidden">
  <a href="#main-content" class="absolute -top-full left-4 bg-[#c4982e] text-[#1c1508] px-4 py-2 z-[200] font-bold focus:top-2">Skip to content</a>
  ${!isIndex ? `<header class="sticky top-0 z-[100] bg-[rgba(28,21,8,0.95)] backdrop-blur-2xl backdrop-saturate-[1.8] border-b border-[rgba(217,201,160,0.12)]" role="banner">
    <div class="max-w-[600px] mx-auto px-4 py-4 flex items-center justify-between">
      <a href="/" class="font-bold text-sm tracking-tight hover:text-[#c4982e] transition-colors duration-200">Logan, from the Internet.</a>
    </div>
  </header>` : ''}
  <main id="main-content" class="max-w-[600px] mx-auto px-5 max-md:px-[2vw] pt-10 pb-[max(5vh,2rem)]" role="main">
    ${nav}
    <article class="content">
      ${!isIndex ? `<h1 class="text-[1.8em] text-center tracking-tight mb-10 leading-snug">${escapeHtml(title)}</h1>` : ''}
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
        indexContent += `<h1 class="text-[1.8em] text-center tracking-tight mb-5 leading-snug">Logan, from the Internet.</h1>\n`
        indexContent += `<img src="${localImg}" alt="Logan, from the Internet" class="index-hero-img max-w-[224px] w-full h-auto aspect-[256/182] mx-auto mb-6 block" width="256" height="182">\n`
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
          indexContent += `<div class="grid grid-cols-4 max-md:grid-cols-2 gap-0.5 mt-8">\n`
          for (const e of withCovers) {
            indexContent += `<div class="relative overflow-hidden group">
              <a href="/${e.slug}.html" class="block w-full pb-[100%] relative overflow-hidden">
                <img src="${e.coverLocal}" alt="${escapeHtml(e.title)}" loading="lazy" class="absolute inset-0 w-full h-full object-cover transition-all duration-150 group-hover:brightness-110">
              </a>
            </div>\n`
          }
          indexContent += `</div>\n`
        }

        // List for entries without covers
        if (withoutCovers.length > 0) {
          indexContent += `<ul class="mt-5 list-none p-0 space-y-1.5">\n`
          for (const e of withoutCovers) {
            indexContent += `<li><a href="/${e.slug}.html" class="font-bold hover:text-[#c4982e] transition-colors duration-150">${escapeHtml(e.title)}</a></li>\n`
          }
          indexContent += `</ul>\n`
        }
      }
    } else if (block.type === 'child_page') {
      // Render as a link
      const entry = entries.find((e) => e.pageId === block.id)
      if (entry) {
        indexContent += `<p><a href="/${entry.slug}.html" class="page-link font-bold border-b border-[#c4982e] hover:text-[#c4982e] transition-colors duration-150">${escapeHtml(entry.title)}</a></p>\n`
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

  // 10. Compile Tailwind CSS from generated HTML
  console.log('\nCompiling Tailwind CSS...')
  const twInput = path.join(__dirname, 'styles.css')
  const twOutput = path.join(OUT_DIR, 'tailwind.css')
  execSync(
    `npx @tailwindcss/cli -i ${twInput} -o ${twOutput} --minify`,
    { cwd: __dirname, stdio: 'pipe' }
  )
  const compiledTw = await fs.readFile(twOutput, 'utf-8')

  // Inject compiled Tailwind CSS into all HTML files
  const htmlFiles = (await fs.readdir(OUT_DIR)).filter((f) => f.endsWith('.html'))
  for (const file of htmlFiles) {
    const filePath = path.join(OUT_DIR, file)
    let html = await fs.readFile(filePath, 'utf-8')
    html = html.replace('__TAILWIND_CSS__', compiledTw)
    await fs.writeFile(filePath, html)
  }
  await fs.rm(twOutput) // clean up standalone CSS file
  console.log(`✓ Tailwind CSS compiled and injected into ${htmlFiles.length} pages`)

  console.log(`\n✓ Built ${entries.length + 1} pages to ${OUT_DIR}/`)
}

build().catch((e) => {
  console.error('\nBuild failed:', e)
  process.exit(1)
})
