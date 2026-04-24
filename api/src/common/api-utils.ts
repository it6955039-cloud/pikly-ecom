// src/common/api-utils.ts

const API_VERSION = '5.0.0'

export function successResponse(data: any, meta: any = {}) {
  return {
    success: true,
    data,
    meta: {
      version: API_VERSION,
      timestamp: new Date().toISOString(),
      // cacheHit is ONLY included when explicitly passed by the caller.
      // Endpoints that don't cache (orders, users, cart, etc.) will no longer
      // show a misleading cacheHit:false in their response.
      ...meta,
    },
  }
}

export function paginatedResponse(data: any, pagination: any, meta: any = {}) {
  return {
    success: true,
    data,
    meta: {
      version: API_VERSION,
      timestamp: new Date().toISOString(),
      pagination,
      ...meta,
    },
  }
}

export function errorResponse(code: string, message: string, statusCode: number) {
  return { success: false, error: { code, message, statusCode } }
}

// ── Offset pagination ────────────────────────────────────────────────────────
export function paginate(array: any[], page: number, limit: number) {
  const p = Math.max(1, Number(page) || 1)
  const l = Math.min(100, Math.max(1, Number(limit) || 20))
  const total = array.length
  const totalPages = Math.ceil(total / l)
  return {
    items: array.slice((p - 1) * l, p * l),
    total,
    page: p,
    limit: l,
    totalPages,
    hasNextPage: p < totalPages,
    hasPrevPage: p > 1,
    mode: 'offset' as const,
  }
}

// ── Cursor pagination ────────────────────────────────────────────────────────
export function cursorPaginate(array: any[], cursor: string | undefined, limit: number) {
  const l = Math.min(100, Math.max(1, Number(limit) || 20))

  let startIndex = 0
  if (cursor) {
    try {
      const lastId = Buffer.from(cursor, 'base64').toString('utf-8')
      const idx = array.findIndex((item) => (item.id ?? item.asin) === lastId)
      startIndex = idx === -1 ? 0 : idx + 1
    } catch {
      startIndex = 0
    }
  }

  const items = array.slice(startIndex, startIndex + l)
  const hasNext = startIndex + l < array.length
  const hasPrev = startIndex > 0

  const lastId = items[items.length - 1]?.id ?? items[items.length - 1]?.asin ?? ''
  const firstId = items[0]?.id ?? items[0]?.asin ?? ''
  const prevItem = startIndex > 0 ? array[startIndex - 1] : null
  const prevId = prevItem?.id ?? prevItem?.asin ?? ''

  return {
    items,
    total: array.length,
    limit: l,
    nextCursor: hasNext ? Buffer.from(lastId).toString('base64') : null,
    prevCursor: hasPrev ? Buffer.from(prevId).toString('base64') : null,
    hasNextPage: hasNext,
    hasPrevPage: hasPrev,
    mode: 'cursor' as const,
  }
}

// ── Smart paginate ───────────────────────────────────────────────────────────
export function smartPaginate(
  array: any[],
  params: { page?: number; limit?: number; cursor?: string },
) {
  const { page, limit = 20, cursor } = params

  if (cursor !== undefined && cursor !== null && cursor !== '') {
    return cursorPaginate(array, cursor, limit)
  }

  const pageNum = Number(page)
  if (page !== undefined && page !== null && !isNaN(pageNum) && pageNum > 0) {
    return paginate(array, pageNum, limit)
  }

  return cursorPaginate(array, undefined, limit)
}
