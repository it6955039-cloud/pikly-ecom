import { paginate, cursorPaginate, smartPaginate } from './api-utils'

const makeItems = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `item_${i}`, value: i }))

describe('paginate', () => {
  it('returns correct slice for page 1', () => {
    const result = paginate(makeItems(50), 1, 10)
    expect(result.items).toHaveLength(10)
    expect(result.items[0].id).toBe('item_0')
    expect(result.hasNextPage).toBe(true)
    expect(result.hasPrevPage).toBe(false)
    expect(result.totalPages).toBe(5)
  })

  it('returns correct slice for last page', () => {
    const result = paginate(makeItems(25), 3, 10)
    expect(result.items).toHaveLength(5)
    expect(result.hasNextPage).toBe(false)
    expect(result.hasPrevPage).toBe(true)
  })
})

describe('cursorPaginate (BUG-01 fix — id-based stable cursor)', () => {
  it('returns first page when no cursor is given', () => {
    const items = makeItems(30)
    const result = cursorPaginate(items, undefined, 10)
    expect(result.items).toHaveLength(10)
    expect(result.items[0].id).toBe('item_0')
    expect(result.nextCursor).not.toBeNull()
    expect(result.prevCursor).toBeNull()
  })

  it('next cursor points to the correct next page by item id', () => {
    const items = makeItems(30)
    const page1 = cursorPaginate(items, undefined, 10)
    const page2 = cursorPaginate(items, page1.nextCursor!, 10)
    // page2 must start immediately after the last item of page1
    expect(page2.items[0].id).toBe('item_10')
  })

  it('is stable after item insertion (BUG-01)', () => {
    // Simulate: client loads page 1, then a new item is prepended to the array.
    // With the old index-based cursor the client would receive a duplicate.
    // With the new id-based cursor it correctly continues from where it left off.
    const items = makeItems(30)
    const page1 = cursorPaginate(items, undefined, 10)
    const lastSeen = page1.items[page1.items.length - 1].id // item_9

    // A new item is inserted at position 5 (simulates a live catalogue update)
    const mutatedItems = [...items.slice(0, 5), { id: 'item_new', value: -1 }, ...items.slice(5)]

    const page2 = cursorPaginate(mutatedItems, page1.nextCursor!, 10)
    // Should start from item_10, not item_9 (which would be a duplicate)
    const ids = page2.items.map((i) => i.id)
    expect(ids).not.toContain(lastSeen)
    expect(ids[0]).toBe('item_10')
  })
})

describe('smartPaginate', () => {
  it('uses offset mode when page is provided', () => {
    const result = smartPaginate(makeItems(20), { page: 2, limit: 5 })
    expect(result.mode).toBe('offset')
  })

  it('uses cursor mode when cursor is provided', () => {
    const items = makeItems(20)
    const first = cursorPaginate(items, undefined, 5)
    const result = smartPaginate(items, { cursor: first.nextCursor! })
    expect(result.mode).toBe('cursor')
  })
})
