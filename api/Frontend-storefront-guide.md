# Pikly Storefront — Frontend Implementation Guide (JavaScript / Next.js)

## What changed in this session

### 1. `nav` removed
The `nav` object (departments mega-menu) is gone from the response.
Your frontend was already not using it — zero impact.

### 2. `thumbnails` array removed → `thumbnailAlt` added

**Before:**
```json
"thumbnail": "https://...main.jpg",
"thumbnails": ["https://...1.jpg", "https://...2.jpg", "...14 more"]
```

**After:**
```json
"thumbnail":    "https://...main.jpg",
"thumbnailAlt": "https://...2.jpg"
```

This is a storefront API, not a PDP. You only ever need 2 images on a card:
- `thumbnail` → primary image shown by default
- `thumbnailAlt` → shown on hover (or as a fallback if primary fails). `null` when DB has no second image.

---

## Project Setup

```bash
npx create-next-app@latest pikly-storefront --javascript --tailwind --app

npm install lucide-react
```

```
# .env.local
API_URL=http://localhost:3000/api
```

```css
/* src/app/globals.css — add after tailwind directives */
@layer utilities {
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
}
```

---

## File Structure

```
src/
  app/
    page.jsx                         ← async server component, ISR 5min
    layout.jsx
    globals.css

  components/
    storefront/
      StorefrontRenderer.jsx         ← iterates sections[], dispatches by type
      ProductCard.jsx                ← universal card, all ProductCardV2 fields
      BadgeChip.jsx                  ← typed badge colors
      Stars.jsx                      ← star rating
      DealCountdown.jsx              ← countdown timer + % claimed bar
      LazySection.jsx                ← IntersectionObserver wrapper

      sections/
        SubNavStrip.jsx
        HeroBannerSlider.jsx
        QuadMosaicRow.jsx
        ProductCarousel.jsx
        DealGrid.jsx
        BestsellerList.jsx
        AlsoViewedGrid.jsx
        EditorialCampaign.jsx
        ContinueShopping.jsx
        BrowsingHistory.jsx

  lib/
    api.js
    analytics.js
```

---

## lib/api.js

```js
export async function getStorefront({ alsoViewedPage, token } = {}) {
  const params = new URLSearchParams()
  if (alsoViewedPage && alsoViewedPage > 1) {
    params.set('alsoViewedPage', String(alsoViewedPage))
  }

  const res = await fetch(
    `${process.env.API_URL}/homepage/storefront/v2?${params}`,
    {
      next: { revalidate: 300 },           // ISR — matches 5 min backend cache
      headers: {
        'Accept': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  )

  if (!res.ok) throw new Error(`Storefront fetch failed: ${res.status}`)
  const json = await res.json()
  return json.data
}
```

---

## lib/analytics.js

```js
export function trackImpression(token) {
  if (!token) return
  fetch('/api/analytics/impression', {
    method:    'POST',
    headers:   { 'Content-Type': 'application/json' },
    body:      JSON.stringify({ token }),
    keepalive: true,  // survives page navigation
  }).catch(() => {})  // never block rendering
}

export function trackClick(token) {
  if (!token) return
  fetch('/api/analytics/click', {
    method:    'POST',
    headers:   { 'Content-Type': 'application/json' },
    body:      JSON.stringify({ token }),
    keepalive: true,
  }).catch(() => {})
}
```

---

## app/page.jsx

```jsx
import { getStorefront } from '@/lib/api'
import { StorefrontRenderer } from '@/components/storefront/StorefrontRenderer'

export async function generateMetadata() {
  const data = await getStorefront()
  return {
    title:       data.page.title,
    description: data.page.description,
    alternates:  { canonical: data.page.canonical },
    openGraph:   { images: data.page.ogImage ? [data.page.ogImage] : [] },
  }
}

export default async function HomePage({ searchParams }) {
  const alsoViewedPage = parseInt(searchParams?.alsoViewedPage ?? '1', 10) || 1
  const data = await getStorefront({ alsoViewedPage })

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(data.page.structuredData) }}
      />
      <StorefrontRenderer sections={data.sections} page={data.page} />
    </>
  )
}
```

---

## StorefrontRenderer.jsx

```jsx
'use client'
import { SubNavStrip }        from './sections/SubNavStrip'
import { HeroBannerSlider }   from './sections/HeroBannerSlider'
import { QuadMosaicRow }      from './sections/QuadMosaicRow'
import { ProductCarousel }    from './sections/ProductCarousel'
import { DealGrid }           from './sections/DealGrid'
import { BestsellerList }     from './sections/BestsellerList'
import { AlsoViewedGrid }     from './sections/AlsoViewedGrid'
import { EditorialCampaign }  from './sections/EditorialCampaign'
import { ContinueShopping }   from './sections/ContinueShopping'
import { BrowsingHistory }    from './sections/BrowsingHistory'
import { LazySection }        from './LazySection'

function renderSection(section) {
  switch (section.type) {
    case 'sub_nav_strip':      return <SubNavStrip      section={section} />
    case 'hero_banner':        return <HeroBannerSlider section={section} />
    case 'quad_mosaic_row':    return <QuadMosaicRow    section={section} />
    case 'product_carousel':   return <ProductCarousel  section={section} />
    case 'deal_grid':          return <DealGrid         section={section} />
    case 'bestseller_list':    return <BestsellerList   section={section} />
    case 'also_viewed_grid':   return <AlsoViewedGrid   section={section} />
    case 'editorial_campaign': return <EditorialCampaign section={section} />
    case 'continue_shopping':  return <ContinueShopping section={section} />
    case 'browsing_history':   return <BrowsingHistory  section={section} />
    default:                   return null
  }
}

export function StorefrontRenderer({ sections }) {
  return (
    <main className="bg-[#EAEDED] min-h-screen">
      {sections.map((section) => {
        // Skip sections for authenticated users only
        if (section.visibility.audience === 'authenticated') return null

        // Respect minItemsToRender
        const d     = section.data
        const count = d?.products?.length ?? d?.deals?.length ?? d?.panels?.length ?? 0
        if (count > 0 && count < section.renderHints.minItemsToRender) return null

        const content = renderSection(section)
        if (!content) return null

        // Positions 1-4 are above fold — render immediately, no lazy wrapper
        if (!section.renderHints.lazy) {
          return <div key={section.sectionId}>{content}</div>
        }

        return (
          <LazySection key={section.sectionId}>
            {content}
          </LazySection>
        )
      })}
    </main>
  )
}
```

---

## LazySection.jsx

```jsx
'use client'
import { useEffect, useRef, useState } from 'react'

export function LazySection({ children }) {
  const ref     = useRef(null)
  const [show, setShow] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShow(true)
          obs.disconnect()
        }
      },
      { rootMargin: '200px' },  // start loading 200px before viewport
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return (
    <div ref={ref} className="min-h-[200px]">
      {show ? children : <Skeleton />}
    </div>
  )
}

function Skeleton() {
  return (
    <div className="px-4 py-3 bg-white">
      <div className="h-6 w-48 bg-gray-200 rounded animate-pulse mb-3" />
      <div className="flex gap-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex-none w-[185px]">
            <div className="aspect-square bg-gray-200 rounded animate-pulse mb-2" />
            <div className="h-3 bg-gray-200 rounded animate-pulse mb-1" />
            <div className="h-3 bg-gray-200 rounded animate-pulse w-2/3" />
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

## Stars.jsx

```jsx
function StarFull() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 fill-[#FF9900]">
      <path d="M10 1l2.6 5.3 5.9.9-4.3 4.1 1 5.9L10 14.4l-5.2 2.8 1-5.9L1.5 7.2l5.9-.9z" />
    </svg>
  )
}
function StarHalf() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 text-[#FF9900]">
      <path d="M10 1l2.6 5.3 5.9.9-4.3 4.1 1 5.9L10 14.4V1z" fill="currentColor" />
      <path d="M10 14.4l-5.2 2.8 1-5.9L1.5 7.2l5.9-.9L10 1v13.4z" fill="#D5D9D9" />
    </svg>
  )
}
function StarEmpty() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 fill-[#D5D9D9]">
      <path d="M10 1l2.6 5.3 5.9.9-4.3 4.1 1 5.9L10 14.4l-5.2 2.8 1-5.9L1.5 7.2l5.9-.9z" />
    </svg>
  )
}

export function Stars({ rating }) {
  const full  = Math.floor(rating)
  const half  = rating % 1 >= 0.5
  const empty = 5 - full - (half ? 1 : 0)

  return (
    <div className="flex items-center gap-0.5">
      {[...Array(full)].map((_, i)  => <StarFull  key={`f${i}`} />)}
      {half                          && <StarHalf  key="h" />}
      {[...Array(empty)].map((_, i) => <StarEmpty key={`e${i}`} />)}
      <span className="text-xs text-[#0F1111] ml-0.5">{rating}</span>
    </div>
  )
}
```

---

## BadgeChip.jsx

```jsx
const BADGE_STYLES = {
  amazons_choice:  'bg-[#232F3E] text-white',
  best_seller:     'bg-[#E37C16] text-white',
  new_release:     'bg-[#067D62] text-white',
  trending:        'bg-[#7B2D8B] text-white',
  prime:           'bg-[#00A8E0] text-white',
  deal:            'bg-[#CC0C39] text-white',
  lightning_deal:  'bg-[#CC0C39] text-white',
  limited_time_deal:'bg-[#CC0C39] text-white',
  top_rated:       'bg-[#F5A623] text-white',
  free_shipping:   'border border-[#007185] text-[#007185]',
  climate_pledge:  'bg-[#067D62] text-white',
  small_business:  'bg-[#067D62] text-white',
  prime_exclusive: 'bg-[#232F3E] text-white',
}

export function BadgeChip({ badge }) {
  const style = BADGE_STYLES[badge.type] ?? 'bg-gray-200 text-gray-700'
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${style}`}>
      {badge.label}
      {badge.subLabel && (
        <span className="font-normal"> {badge.subLabel}</span>
      )}
    </span>
  )
}
```

---

## DealCountdown.jsx

```jsx
'use client'
import { useEffect, useState } from 'react'

export function DealCountdown({ deal }) {
  const [timeLeft, setTimeLeft] = useState('')

  useEffect(() => {
    if (!deal.endsAt) return
    const tick = () => {
      const diff = new Date(deal.endsAt).getTime() - Date.now()
      if (diff <= 0) { setTimeLeft('Expired'); return }
      const h = Math.floor(diff / 3_600_000)
      const m = Math.floor((diff % 3_600_000) / 60_000)
      const s = Math.floor((diff % 60_000) / 1_000)
      setTimeLeft(h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [deal.endsAt])

  return (
    <div className="space-y-1 mt-1">
      {/* % claimed progress bar */}
      {deal.claimedPct != null && (
        <div>
          <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#CC0C39] rounded-full"
              style={{ width: `${deal.claimedPct}%` }}
            />
          </div>
          <p className="text-[10px] text-[#CC0C39] font-semibold mt-0.5">
            {deal.claimedLabel}
          </p>
        </div>
      )}
      {/* Countdown */}
      {timeLeft && (
        <p className="text-[10px] text-gray-500">
          Ends in: <strong className="text-[#0F1111]">{timeLeft}</strong>
        </p>
      )}
    </div>
  )
}
```

---

## ProductCard.jsx

This is the most important component — used in every section.

```jsx
'use client'
import { useEffect, useState } from 'react'
import Image from 'next/image'
import { Stars }        from './Stars'
import { BadgeChip }    from './BadgeChip'
import { DealCountdown } from './DealCountdown'
import { trackImpression, trackClick } from '@/lib/analytics'

export function ProductCard({ product, size = 'md' }) {
  // thumbnailAlt — hover swap support
  const [imgSrc, setImgSrc] = useState(product.thumbnail)

  // Fire impression token once on mount
  useEffect(() => {
    trackImpression(product.impressionToken)
  }, [product.impressionToken])

  const imgSize = size === 'sm' ? 150 : size === 'lg' ? 240 : 200

  return (
    <a
      href={product.clickUrl}
      onClick={() => trackClick(product.impressionToken)}
      className="group block bg-white border border-transparent hover:border-gray-200
                 hover:shadow-md transition-all duration-200 rounded-sm"
    >
      {/* ── Thumbnail ─────────────────────────── */}
      <div className="relative bg-white p-2 overflow-hidden">
        <Image
          src={imgSrc}
          alt={product.title}
          width={imgSize}
          height={imgSize}
          className="object-contain w-full aspect-square transition-transform duration-300
                     group-hover:scale-105"
          onError={() => {
            // If primary fails and we have alt, try alt
            if (imgSrc === product.thumbnail && product.thumbnailAlt) {
              setImgSrc(product.thumbnailAlt)
            }
          }}
          // Swap to alt on hover if available
          onMouseEnter={() => product.thumbnailAlt && setImgSrc(product.thumbnailAlt)}
          onMouseLeave={() => setImgSrc(product.thumbnail)}
        />

        {/* Discount badge overlay */}
        {product.discountPct > 0 && (
          <div className="absolute top-2 left-2 bg-[#CC0C39] text-white text-xs
                          font-bold px-1.5 py-0.5 rounded">
            -{product.discountPct}%
          </div>
        )}

        {/* Sponsored label */}
        {product.sponsored && (
          <span className="absolute bottom-1.5 left-2 text-[10px] text-gray-400">
            {product.sponsoredLabel ?? 'Sponsored'}
          </span>
        )}
      </div>

      {/* ── Card body ─────────────────────────── */}
      <div className="px-2 pb-2 space-y-1">

        {/* Badges — max 2 */}
        {product.badges.length > 0 && (
          <div className="flex gap-1 flex-wrap pt-1">
            {product.badges.slice(0, 2).map((badge) => (
              <BadgeChip key={badge.type} badge={badge} />
            ))}
          </div>
        )}

        {/* Title */}
        <p className="text-sm text-[#0F1111] line-clamp-2 leading-snug">
          {product.title}
        </p>

        {/* Brand */}
        {product.brand && (
          <p className="text-xs text-gray-500 truncate">{product.brand}</p>
        )}

        {/* Rating */}
        {product.reviewCount > 0 && (
          <div className="flex items-center gap-1">
            <Stars rating={product.avgRating} />
            <span className="text-xs text-[#007185]">
              {product.reviewCount.toLocaleString()}
            </span>
          </div>
        )}

        {/* Price block */}
        <div className="flex items-baseline gap-1 flex-wrap">
          {product.discountPct > 0 && (
            <span className="text-xs text-[#CC0C39] font-semibold">
              -{product.discountPct}%
            </span>
          )}
          <span className="text-base font-semibold text-[#0F1111]">
            {product.price === 0 ? 'Free' : `$${product.price.toFixed(2)}`}
          </span>
          {product.originalPrice && product.originalPrice > product.price && (
            <span className="text-xs text-gray-400 line-through">
              ${product.originalPrice.toFixed(2)}
            </span>
          )}
        </div>

        {/* Savings */}
        {product.savingsAmount > 0 && (
          <p className="text-xs text-[#CC0C39]">
            Save ${product.savingsAmount.toFixed(2)}
          </p>
        )}

        {/* Coupon clip */}
        {product.coupon && (
          <div className="flex items-center gap-1">
            <input type="checkbox" readOnly checked className="accent-[#CC0C39] w-3 h-3" />
            <span className="text-xs text-[#CC0C39]">{product.coupon}</span>
          </div>
        )}

        {/* Purchase signal — social proof */}
        {product.purchaseSignal && (
          <p className="text-xs text-[#CC0C39] font-medium">
            {product.purchaseSignal}
          </p>
        )}

        {/* Delivery promise — #1 conversion driver, always show */}
        {product.deliveryPromise && (
          <div className="text-xs leading-tight">
            <span className="text-[#007600] font-medium">
              {product.deliveryPromise.headline}
            </span>
            {product.deliveryPromise.cutoffLabel && (
              <span className="text-gray-500">
                {' '}— {product.deliveryPromise.cutoffLabel}
              </span>
            )}
          </div>
        )}

        {/* Stock signal */}
        {(product.stockSignal.status === 'low_stock' || product.stockSignal.status === 'last_few') && (
          <p className="text-xs text-[#CC0C39]">
            {product.stockSignal.label ?? 'Only a few left in stock – order soon'}
          </p>
        )}
        {product.stockSignal.status === 'out_of_stock' && (
          <p className="text-xs text-gray-400">Currently unavailable</p>
        )}

        {/* Deal countdown + claimed bar */}
        {product.deal && (product.deal.claimedPct != null || product.deal.endsAt) && (
          <DealCountdown deal={product.deal} />
        )}

        {/* Category rank — shown in BestsellerList */}
        {product.categoryRank && (
          <p className="text-[10px] text-[#007185]">
            #{product.categoryRank.rank} in{' '}
            <a href={product.categoryRank.categoryLink} className="hover:underline">
              {product.categoryRank.categoryName}
            </a>
          </p>
        )}
      </div>
    </a>
  )
}
```

---

## sections/SubNavStrip.jsx

```jsx
export function SubNavStrip({ section }) {
  return (
    <nav className="bg-[#232F3E] border-b border-[#3D4F5E]">
      <div className="flex items-center overflow-x-auto scrollbar-hide">
        {section.data.links.map((link) => (
          <a
            key={link.link}
            href={link.link}
            className="flex items-center gap-1 px-3 py-2.5 text-[13px] text-white
                       whitespace-nowrap hover:bg-[#3D4F5E] transition-colors shrink-0"
          >
            {link.label}
            {link.badge && (
              <span className="ml-1 text-[10px] bg-[#CC0C39] text-white
                               px-1 py-0.5 rounded font-bold">
                {link.badge}
              </span>
            )}
          </a>
        ))}
      </div>
    </nav>
  )
}
```

---

## sections/HeroBannerSlider.jsx

```jsx
'use client'
import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export function HeroBannerSlider({ section }) {
  const { banners, autoplayMs } = section.data
  const [idx, setIdx] = useState(0)

  const next = useCallback(() => setIdx((i) => (i + 1) % banners.length), [banners.length])
  const prev = useCallback(() => setIdx((i) => (i - 1 + banners.length) % banners.length), [banners.length])

  useEffect(() => {
    if (!autoplayMs || banners.length <= 1) return
    const id = setInterval(next, autoplayMs)
    return () => clearInterval(id)
  }, [autoplayMs, next, banners.length])

  const slide = banners[idx]
  if (!slide) return null

  return (
    <div className="relative w-full overflow-hidden bg-[#EAEDED]">
      <div className="relative w-full" style={{ aspectRatio: '21/9' }}>
        {slide.desktopImage ? (
          <Image src={slide.desktopImage} alt={slide.altText} fill
                 className="object-cover" priority sizes="100vw" />
        ) : (
          <div className="w-full h-full bg-gradient-to-r from-[#232F3E] to-[#37475A]" />
        )}

        {/* Text overlay */}
        {(slide.title || slide.ctaText) && (
          <div className={`absolute inset-0 flex flex-col justify-center px-12
            ${slide.textAlignment === 'center' ? 'items-center text-center'
              : slide.textAlignment === 'right'  ? 'items-end text-right'
              : 'items-start'}`}>
            {slide.eyebrow && (
              <p className={`text-sm font-medium mb-1
                ${slide.textColor === 'light' ? 'text-white' : 'text-[#0F1111]'}`}>
                {slide.eyebrow}
              </p>
            )}
            {slide.title && (
              <h1 className={`text-3xl md:text-4xl font-bold mb-2
                ${slide.textColor === 'light' ? 'text-white' : 'text-[#0F1111]'}`}>
                {slide.title}
              </h1>
            )}
            {slide.subtitle && (
              <p className={`text-base mb-4
                ${slide.textColor === 'light' ? 'text-white/90' : 'text-gray-700'}`}>
                {slide.subtitle}
              </p>
            )}
            {slide.ctaText && slide.ctaLink && (
              <a href={slide.ctaLink}
                 className="inline-block bg-[#FF9900] hover:bg-[#E88B00] text-[#0F1111]
                            font-bold py-2.5 px-6 rounded text-sm transition-colors shadow">
                {slide.ctaText}
              </a>
            )}
          </div>
        )}
      </div>

      {banners.length > 1 && (
        <>
          <button onClick={prev} aria-label="Previous"
            className="absolute left-3 top-1/2 -translate-y-1/2 bg-white/80
                       hover:bg-white rounded-full p-2 shadow transition-all">
            <ChevronLeft className="w-5 h-5 text-gray-800" />
          </button>
          <button onClick={next} aria-label="Next"
            className="absolute right-3 top-1/2 -translate-y-1/2 bg-white/80
                       hover:bg-white rounded-full p-2 shadow transition-all">
            <ChevronRight className="w-5 h-5 text-gray-800" />
          </button>
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
            {banners.map((_, i) => (
              <button key={i} onClick={() => setIdx(i)}
                className={`h-2 rounded-full transition-all
                  ${i === idx ? 'w-4 bg-white' : 'w-2 bg-white/50'}`} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
```

---

## sections/QuadMosaicRow.jsx

```jsx
import Image from 'next/image'

export function QuadMosaicRow({ section }) {
  return (
    <div className="px-4 py-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {section.data.panels.map((panel) => (
          <div key={panel.panelId} className="bg-white p-3 rounded"
               style={{ backgroundColor: panel.theme.backgroundColor }}>

            {/* Heading */}
            <h2 className="text-sm font-bold text-[#0F1111] leading-tight mb-0.5">
              {panel.heading}
            </h2>
            {panel.priceFilter && (
              <p className="text-[11px] text-gray-500 mb-2">{panel.priceFilter.label}</p>
            )}

            {/* 2×2 cell grid */}
            <div className="grid grid-cols-2 gap-1 mb-2">
              {panel.cells.slice(0, 4).map((cell) => (
                <a key={cell.slug} href={cell.link} className="block group">
                  <div className="aspect-square bg-gray-50 rounded overflow-hidden">
                    <Image
                      src={cell.image ?? cell.productImages[0] ?? '/placeholder.png'}
                      alt={cell.altText}
                      width={120} height={120}
                      className="object-contain w-full h-full
                                 group-hover:scale-105 transition-transform duration-300"
                    />
                  </div>
                  <p className="text-[11px] text-[#0F1111] mt-0.5 leading-tight line-clamp-1">
                    {cell.label}
                  </p>
                </a>
              ))}
            </div>

            {/* See more */}
            <a href={panel.seeMoreLink} className="text-xs font-medium hover:underline"
               style={{ color: panel.theme.accentColor }}>
              {panel.seeMoreText} ›
            </a>
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

## sections/ProductCarousel.jsx

```jsx
'use client'
import { useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { ProductCard } from '../ProductCard'

export function ProductCarousel({ section }) {
  const scrollRef = useRef(null)
  const scroll = (dir) =>
    scrollRef.current?.scrollBy({ left: dir === 'right' ? 420 : -420, behavior: 'smooth' })

  return (
    <div className="px-4 py-3 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          {section.badge && (
            <span className="text-xs font-bold text-[#C7511F] bg-[#FFF3E0]
                             px-2 py-0.5 rounded mr-2">
              {section.badge}
            </span>
          )}
          <span className="text-xl font-bold text-[#0F1111]">{section.title}</span>
          {section.subtitle && (
            <p className="text-xs text-gray-500 mt-0.5">{section.subtitle}</p>
          )}
        </div>
        {section.seeMoreLink && section.renderHints.showSeeMore && (
          <a href={section.seeMoreLink}
             className="text-sm text-[#007185] hover:text-[#C7511F] hover:underline whitespace-nowrap">
            See more ›
          </a>
        )}
      </div>

      {/* Carousel */}
      <div className="relative group">
        <button onClick={() => scroll('left')} aria-label="Previous"
          className="absolute left-0 top-1/3 z-10 bg-white shadow-lg rounded-full p-1.5
                     opacity-0 group-hover:opacity-100 -translate-x-3
                     hidden lg:flex items-center justify-center transition-opacity">
          <ChevronLeft className="w-5 h-5 text-gray-700" />
        </button>

        <div ref={scrollRef} className="flex gap-3 overflow-x-auto scrollbar-hide pb-1">
          {section.data.products.map((product) => (
            <div key={product.asin} className="flex-none w-[calc(50%-6px)] sm:w-[185px]">
              <ProductCard product={product} />
            </div>
          ))}
        </div>

        <button onClick={() => scroll('right')} aria-label="Next"
          className="absolute right-0 top-1/3 z-10 bg-white shadow-lg rounded-full p-1.5
                     opacity-0 group-hover:opacity-100 translate-x-3
                     hidden lg:flex items-center justify-center transition-opacity">
          <ChevronRight className="w-5 h-5 text-gray-700" />
        </button>
      </div>
    </div>
  )
}
```

---

## sections/DealGrid.jsx

```jsx
'use client'
import { useEffect, useState } from 'react'
import { ProductCard } from '../ProductCard'

export function DealGrid({ section }) {
  const { refreshesAt, deals, totalDeals, viewAllLink } = section.data
  const [refresh, setRefresh] = useState('')

  useEffect(() => {
    const tick = () => {
      const diff = new Date(refreshesAt).getTime() - Date.now()
      if (diff <= 0) { setRefresh('Refreshing...'); return }
      const h = Math.floor(diff / 3_600_000)
      const m = Math.floor((diff % 3_600_000) / 60_000)
      setRefresh(`${h}h ${m}m`)
    }
    tick()
    const id = setInterval(tick, 60_000)
    return () => clearInterval(id)
  }, [refreshesAt])

  return (
    <div className="px-4 py-3" style={{ backgroundColor: section.renderHints.backgroundColor ?? '#fff3e0' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-xl font-bold text-[#0F1111]">{section.title}</h2>
          {refresh && <p className="text-xs text-gray-500">Deals refresh in {refresh}</p>}
        </div>
        <a href={viewAllLink}
           className="text-sm text-[#007185] hover:underline whitespace-nowrap">
          See all {totalDeals.toLocaleString()} deals ›
        </a>
      </div>

      {/* Horizontal deal cards */}
      <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-2">
        {deals.map((deal) => (
          <div key={deal.asin} className="flex-none w-[180px] lg:w-[210px]">
            <ProductCard product={deal} size="lg" />
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

## sections/BestsellerList.jsx

```jsx
'use client'
import { useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { ProductCard } from '../ProductCard'

export function BestsellerList({ section }) {
  const scrollRef = useRef(null)
  const scroll = (dir) =>
    scrollRef.current?.scrollBy({ left: dir === 'right' ? 420 : -420, behavior: 'smooth' })

  return (
    <div className="px-4 py-3 bg-white">
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-xs font-bold bg-[#E37C16] text-white px-2 py-0.5 rounded mr-2">
            #1 Best Seller
          </span>
          <span className="text-xl font-bold text-[#0F1111]">{section.title}</span>
        </div>
        {section.seeMoreLink && (
          <a href={section.seeMoreLink}
             className="text-sm text-[#007185] hover:underline">
            See all ›
          </a>
        )}
      </div>

      <div className="relative group">
        <button onClick={() => scroll('left')} aria-label="Previous"
          className="absolute left-0 top-1/3 z-10 bg-white shadow-lg rounded-full p-1.5
                     opacity-0 group-hover:opacity-100 -translate-x-3
                     hidden lg:flex items-center justify-center transition-opacity">
          <ChevronLeft className="w-5 h-5" />
        </button>

        <div ref={scrollRef} className="flex gap-3 overflow-x-auto scrollbar-hide pb-1">
          {section.data.products.map((product) => (
            <div key={product.asin} className="flex-none w-[170px] relative">
              {/* Rank badge — corner overlay on thumbnail */}
              {product.categoryRank && (
                <div className="absolute top-2 left-2 z-10 bg-[#E37C16] text-white
                                text-xs font-black px-1.5 py-0.5 rounded leading-none">
                  #{product.categoryRank.rank}
                </div>
              )}
              <ProductCard product={product} size="sm" />
            </div>
          ))}
        </div>

        <button onClick={() => scroll('right')} aria-label="Next"
          className="absolute right-0 top-1/3 z-10 bg-white shadow-lg rounded-full p-1.5
                     opacity-0 group-hover:opacity-100 translate-x-3
                     hidden lg:flex items-center justify-center transition-opacity">
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
```

---

## sections/AlsoViewedGrid.jsx

```jsx
'use client'
import { useRouter } from 'next/navigation'
import { ProductCard } from '../ProductCard'

export function AlsoViewedGrid({ section }) {
  const { products, pagination, headline } = section.data
  const router = useRouter()

  return (
    <div className="px-4 py-3 bg-white">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-[#0F1111] leading-snug">{headline}</h2>
        <span className="text-sm text-gray-500 whitespace-nowrap ml-4">
          Page {pagination.page} of {pagination.totalPages}
        </span>
      </div>

      {/* 6-column grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {products.map((product) => (
          <ProductCard key={product.asin} product={product} size="sm" />
        ))}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-200">
        <button
          onClick={() => pagination.hasPrevPage && router.push(`/?alsoViewedPage=${pagination.page - 1}`)}
          disabled={!pagination.hasPrevPage}
          className="px-4 py-1.5 text-sm border border-gray-300 rounded
                     hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ← Previous
        </button>
        <span className="text-xs text-gray-500">
          {(pagination.page - 1) * pagination.limit + 1}–
          {Math.min(pagination.page * pagination.limit, pagination.totalItems)} of{' '}
          {pagination.totalItems}
        </span>
        <button
          onClick={() => pagination.hasNextPage && router.push(`/?alsoViewedPage=${pagination.page + 1}`)}
          disabled={!pagination.hasNextPage}
          className="px-4 py-1.5 text-sm border border-gray-300 rounded
                     hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Next →
        </button>
      </div>
    </div>
  )
}
```

---

## sections/EditorialCampaign.jsx

```jsx
import Image from 'next/image'

export function EditorialCampaign({ section }) {
  const { headline, backgroundImage, backgroundGradient, tiles, ctaText, ctaLink, textColor } = section.data

  const bgStyle = backgroundImage
    ? { backgroundImage: `url(${backgroundImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: backgroundGradient ?? 'linear-gradient(135deg, #f8d7e8, #fff0f5)' }

  const textCls = textColor === 'light' ? 'text-white' : 'text-[#0F1111]'
  const linkCls = textColor === 'light' ? 'text-white/90' : 'text-[#007185]'

  return (
    <div className="px-4 py-5" style={bgStyle}>
      <div className="flex items-end justify-between mb-4">
        <h2 className={`text-2xl font-bold ${textCls}`}>{headline}</h2>
        {ctaText && ctaLink && (
          <a href={ctaLink} className={`text-sm hover:underline ${linkCls}`}>{ctaText} ›</a>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tiles.map((tile) => (
          <a key={tile.id} href={tile.link}
             className="bg-white rounded overflow-hidden hover:shadow-md transition-shadow group">
            {tile.image && (
              <div className="aspect-square relative overflow-hidden">
                <Image src={tile.image} alt={tile.label} fill
                       className="object-cover group-hover:scale-105 transition-transform duration-300" />
              </div>
            )}
            <div className="p-2">
              {tile.badge && <p className="text-[10px] text-[#CC0C39] font-bold mb-0.5">{tile.badge}</p>}
              <p className="text-sm font-medium text-[#0F1111]">{tile.label}</p>
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}
```

---

## sections/ContinueShopping.jsx

```jsx
import { ProductCard } from '../ProductCard'

export function ContinueShopping({ section }) {
  // Empty when anonymous (visibility.audience = 'authenticated')
  if (section.data.products.length < section.renderHints.minItemsToRender) return null

  return (
    <div className="px-4 py-3 bg-white">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-bold text-[#0F1111]">{section.title}</h2>
        {section.seeMoreLink && (
          <a href={section.seeMoreLink} className="text-sm text-[#007185] hover:underline">See more ›</a>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-1">
        {section.data.products.map((p) => (
          <div key={p.asin} className="flex-none w-[180px]"><ProductCard product={p} /></div>
        ))}
      </div>
    </div>
  )
}
```

---

## sections/BrowsingHistory.jsx

```jsx
import { ProductCard } from '../ProductCard'

export function BrowsingHistory({ section }) {
  if (section.data.products.length < section.renderHints.minItemsToRender) return null

  return (
    <div className="px-4 py-3 bg-white">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-xl font-bold text-[#0F1111]">{section.title}</h2>
          {section.data.affinityDepts.length > 0 && (
            <p className="text-xs text-gray-500 mt-0.5">
              Based on: {section.data.affinityDepts.join(', ')}
            </p>
          )}
        </div>
        {section.seeMoreLink && (
          <a href={section.seeMoreLink} className="text-sm text-[#007185] hover:underline">See more ›</a>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-1">
        {section.data.products.map((p) => (
          <div key={p.asin} className="flex-none w-[180px]"><ProductCard product={p} /></div>
        ))}
      </div>
    </div>
  )
}
```

---

## Bug fix spotted in your live data

`purchaseSignal` was showing `"30K+ bought+ bought in past month"` — the `+` was being doubled.

Fix in `homepage-storefront-v2.service.ts`, `purchaseSignal()` method — the raw DB field already has `+` in it. Strip it before building the string:

```js
purchaseSignal(p) {
  const b = p.bought_last_month
  if (!b || b < 50) return null
  // Strip any trailing + the raw field might already have
  const bought = String(b).replace(/\+$/, '').trim()
  if (+bought >= 10000) return `${Math.floor(+bought / 1000)}k+ bought in past month`
  if (+bought >= 1000)  return `${Math.floor(+bought / 100) / 10}k+ bought in past month`
  return `${bought}+ bought in past month`
}
```

---

## thumbnailAlt usage summary

```jsx
// ProductCard.jsx — already handled above, but for reference:

// Primary image: always product.thumbnail
// Hover/fallback: product.thumbnailAlt (null if no second image in DB)

// Hover swap:
onMouseEnter={() => product.thumbnailAlt && setImgSrc(product.thumbnailAlt)}
onMouseLeave={() => setImgSrc(product.thumbnail)}

// Error fallback (primary 404):
onError={() => {
  if (imgSrc === product.thumbnail && product.thumbnailAlt) {
    setImgSrc(product.thumbnailAlt)
  }
}}
```
