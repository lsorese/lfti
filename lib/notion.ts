import {
  type ExtendedRecordMap,
  type SearchParams,
  type SearchResults
} from 'notion-types'
import { mergeRecordMaps } from 'notion-utils'
import pMap from 'p-map'
import pMemoize from 'p-memoize'

import {
  isPreviewImageSupportEnabled,
  navigationLinks,
  navigationStyle
} from './config'
import { getTweetsMap } from './get-tweets'
import { notion } from './notion-api'
import { getPreviewImageMap } from './preview-images'

const getNavigationLinkPages = pMemoize(
  async (): Promise<ExtendedRecordMap[]> => {
    const navigationLinkPageIds = (navigationLinks || [])
      .map((link) => link?.pageId)
      .filter(Boolean)

    if (navigationStyle !== 'default' && navigationLinkPageIds.length) {
      return pMap(
        navigationLinkPageIds,
        async (navigationLinkPageId) =>
          notion.getPage(navigationLinkPageId, {
            chunkLimit: 1,
            fetchMissingBlocks: false,
            fetchCollections: false,
            signFileUrls: false
          }),
        {
          concurrency: 4
        }
      )
    }

    return []
  }
)

async function fetchPageWithRetry(
  pageId: string,
  retries = 3,
  delay = 5000
): Promise<ExtendedRecordMap> {
  for (let i = 0; i < retries; i++) {
    try {
      return await notion.getPage(pageId)
    } catch (err: any) {
      const is429 = err?.message?.includes('429') || err?.status === 429
      if (is429 && i < retries - 1) {
        const backoff = delay * Math.pow(2, i)
        console.warn(
          `Rate limited fetching page "${pageId}", retrying in ${backoff}ms (attempt ${i + 1}/${retries})`
        )
        await new Promise((resolve) => setTimeout(resolve, backoff))
      } else {
        throw err
      }
    }
  }
  throw new Error(`Failed to fetch page "${pageId}" after ${retries} retries`)
}

export async function getPage(pageId: string): Promise<ExtendedRecordMap> {
  let recordMap = await fetchPageWithRetry(pageId)

  if (navigationStyle !== 'default') {
    // ensure that any pages linked to in the custom navigation header have
    // their block info fully resolved in the page record map so we know
    // the page title, slug, etc.
    const navigationLinkRecordMaps = await getNavigationLinkPages()

    if (navigationLinkRecordMaps?.length) {
      recordMap = navigationLinkRecordMaps.reduce(
        (map, navigationLinkRecordMap) =>
          mergeRecordMaps(map, navigationLinkRecordMap),
        recordMap
      )
    }
  }

  if (isPreviewImageSupportEnabled) {
    const previewImageMap = await getPreviewImageMap(recordMap)
    ;(recordMap as any).preview_images = previewImageMap
  }

  await getTweetsMap(recordMap)

  return recordMap
}

export async function search(params: SearchParams): Promise<SearchResults> {
  return notion.search(params)
}
