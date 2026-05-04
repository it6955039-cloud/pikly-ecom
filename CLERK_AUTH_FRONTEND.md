# Clerk Authentication — Frontend Integration Guide

**Applies to:** Next.js 14+ (App Router). Sections marked _Pages Router_ cover the legacy setup.  
**API base:** `http://localhost:4000` (dev) · `https://api.pikly.com` (prod)  
**Related docs:** [API.md](API.md) · [ARCHITECTURE.md](clerk-migration/ARCHITECTURE.md)

---

## Table of Contents

1. [Overview — what changed](#1-overview)
2. [Installation](#2-installation)
3. [Environment variables](#3-environment-variables)
4. [Provider setup](#4-provider-setup)
5. [Middleware — protecting routes](#5-middleware)
6. [Getting a token and calling the API](#6-calling-the-api)
7. [Authentication hooks and components](#7-hooks-and-components)
8. [Sign-in and sign-up UI](#8-sign-in-and-sign-up-ui)
9. [Role-based UI (admin vs customer)](#9-role-based-ui)
10. [Cart — guest to authenticated merge](#10-cart-merge)
11. [Protected page patterns](#11-protected-page-patterns)
12. [Error handling](#12-error-handling)
13. [React Query integration](#13-react-query-integration)
14. [Showcase — calling the legacy auth demo](#14-showcase-legacy-demo)
15. [Migration from old JWT system](#15-migration-checklist)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Overview

The backend has migrated from a custom bcrypt + JWT engine to **Clerk** as the Identity Provider. Every production API endpoint that previously expected your own `accessToken` now expects a **Clerk session token** in the same `Authorization: Bearer` header format. Nothing else about the API changes — all endpoints, request bodies, and response shapes are identical.

### What is different for the frontend

| Before | After |
|---|---|
| Call `POST /api/auth/login` → store JWT in localStorage | Use Clerk's `<SignIn />` component → Clerk manages the session |
| Call `POST /api/auth/refresh` to keep the session alive | Clerk auto-refreshes the token — you do nothing |
| Read `user.userId` from a decoded JWT | Call `useAuth().userId` — returns the Clerk user ID |
| Send `Authorization: Bearer <your-jwt>` | Send `Authorization: Bearer <clerk-session-token>` — same header, different value |
| Handle logout by deleting localStorage | Call `signOut()` from `useClerk()` |

The legacy login endpoints (`POST /api/auth/login`, `POST /api/auth/register`) are still active but only for the `/showcase/*` demo routes. **Do not use them for real users.**

---

## 2. Installation

```bash
npm install @clerk/nextjs
# or
yarn add @clerk/nextjs
# or
pnpm add @clerk/nextjs
```

That is the only new dependency. Nothing else changes in `package.json`.

---

## 3. Environment Variables

Add these to your frontend `.env.local`. Get the values from the [Clerk Dashboard](https://dashboard.clerk.com) → your application → API Keys.

```bash
# .env.local (Next.js frontend)

# Public key — safe to expose to the browser
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Where Clerk sends users when they need to sign in
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up

# Where Clerk redirects after successful sign-in / sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/

# Your API base URL
NEXT_PUBLIC_API_URL=http://localhost:4000
```

> **Never** put the Clerk Secret Key (`sk_live_...`) in your frontend `.env`. That key belongs only on the backend. The frontend only ever uses the Publishable Key.

---

## 4. Provider Setup

### App Router (Next.js 14+)

Wrap your root layout in `ClerkProvider`. This gives every component in your app access to auth state.

```tsx
// app/layout.tsx
import { ClerkProvider } from '@clerk/nextjs'
import type { ReactNode } from 'react'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}
```

That is all. No extra context providers, no Redux auth slice, no token state needed — Clerk handles everything internally.

### Pages Router (legacy)

```tsx
// pages/_app.tsx
import { ClerkProvider } from '@clerk/nextjs'
import type { AppProps } from 'next/app'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <ClerkProvider {...pageProps}>
      <Component {...pageProps} />
    </ClerkProvider>
  )
}
```

---

## 5. Middleware

The Next.js middleware file controls which routes require authentication at the edge, before the page renders. This replaces any manual JWT-checking logic you had in `getServerSideProps` or layout components.

```typescript
// middleware.ts  (at the project root, next to package.json)
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// Define which routes require a signed-in user
const isProtectedRoute = createRouteMatcher([
  '/account(.*)',
  '/orders(.*)',
  '/checkout(.*)',
  '/wishlist(.*)',
  '/admin(.*)',
])

export default clerkMiddleware((auth, req) => {
  if (isProtectedRoute(req)) {
    auth().protect()   // redirects to /sign-in if not authenticated
  }
})

export const config = {
  matcher: [
    // Run on all routes except Next.js internals and static files
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
```

> **Showcase routes** (`/showcase/*`) do not need Clerk middleware — they use the legacy session cookie independently. If you build showcase UI pages, exclude them from `isProtectedRoute`.

---

## 6. Calling the API

The key concept: you need to attach a fresh Clerk token to every authenticated API request. The token is short-lived (Clerk rotates it automatically), so you must call `getToken()` at request time — never cache it.

### The API client utility

Create a central API client so the auth header logic is written once:

```typescript
// lib/api.ts
import { auth } from '@clerk/nextjs/server'  // Server Components / Route Handlers
// import { useAuth } from '@clerk/nextjs'    // Client Components (see below)

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

// ── Server-side fetch (Server Components, Route Handlers) ────────────────────

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const { getToken } = auth()
  const token = await getToken()

  const res = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }))
    throw new ApiError(res.status, error.code ?? 'API_ERROR', error.message)
  }

  return res.json()
}

// ── Client-side fetch factory (call this in a hook or event handler) ─────────

export function createApiClient(getToken: () => Promise<string | null>) {
  return async function apiFetch<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await getToken()

    const res = await fetch(`${BASE_URL}/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    })

    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }))
      throw new ApiError(res.status, error.code ?? 'API_ERROR', error.message)
    }

    return res.json()
  }
}

// ── Error class ───────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
```

### Using it in a Server Component

```tsx
// app/orders/page.tsx
import { apiFetch } from '@/lib/api'

export default async function OrdersPage() {
  // getToken() is called inside apiFetch — no boilerplate needed here
  const { data: orders } = await apiFetch<{ data: Order[] }>('/orders')

  return (
    <ul>
      {orders.map(order => (
        <li key={order.orderId}>{order.orderId} — {order.status}</li>
      ))}
    </ul>
  )
}
```

### Using it in a Client Component

```tsx
// components/ProfileCard.tsx
'use client'
import { useAuth } from '@clerk/nextjs'
import { createApiClient } from '@/lib/api'
import { useEffect, useState } from 'react'

export function ProfileCard() {
  const { getToken } = useAuth()
  const [profile, setProfile] = useState<UserProfile | null>(null)

  useEffect(() => {
    const api = createApiClient(getToken)
    api<{ data: UserProfile }>('/users/profile')
      .then(res => setProfile(res.data))
      .catch(console.error)
  }, [getToken])

  if (!profile) return <div>Loading...</div>
  return <div>{profile.firstName} {profile.lastName}</div>
}
```

### Guest routes (cart, product pages)

Some API endpoints work for both guests and authenticated users. Send the token if you have one, omit it if not — the API handles both cases gracefully.

```typescript
// The API client above already handles this: token is only added if non-null.
// For guest cart, don't call getToken() at all — just omit the Authorization header.

const res = await fetch(`${BASE_URL}/api/cart`, {
  headers: {
    'Content-Type': 'application/json',
    'X-Session-ID': guestSessionId,   // guest identifier
  },
})
```

---

## 7. Hooks and Components

### `useAuth()` — the primary hook

```tsx
'use client'
import { useAuth } from '@clerk/nextjs'

function MyComponent() {
  const {
    isLoaded,      // false during initial hydration — show skeleton until true
    isSignedIn,    // boolean
    userId,        // Clerk external ID (e.g. "user_2abc123") — NOT your DB UUID
    sessionId,     // current session ID
    getToken,      // async function — call at request time to get a fresh JWT
    signOut,       // function — ends the session
  } = useAuth()

  if (!isLoaded) return <Skeleton />
  if (!isSignedIn) return <a href="/sign-in">Sign in</a>

  return <div>Signed in as {userId}</div>
}
```

> **Important:** `userId` from `useAuth()` is the Clerk external ID (`user_2abc...`), not your database UUID. Your backend resolves this to the internal UUID transparently — you never need the internal UUID on the frontend.

### `useUser()` — profile data

```tsx
'use client'
import { useUser } from '@clerk/nextjs'

function Avatar() {
  const { isLoaded, isSignedIn, user } = useUser()

  if (!isLoaded || !isSignedIn) return null

  return (
    <img
      src={user.imageUrl}
      alt={user.fullName ?? 'User avatar'}
      width={40}
      height={40}
    />
  )
}
```

`user` contains: `id`, `firstName`, `lastName`, `fullName`, `imageUrl`, `primaryEmailAddress`, `publicMetadata` (where `role` lives), `createdAt`.

### `useClerk()` — advanced operations

```tsx
'use client'
import { useClerk } from '@clerk/nextjs'

function SignOutButton() {
  const { signOut } = useClerk()

  return (
    <button onClick={() => signOut({ redirectUrl: '/' })}>
      Sign out
    </button>
  )
}
```

### `<SignedIn>` and `<SignedOut>` — conditional rendering

```tsx
import { SignedIn, SignedOut } from '@clerk/nextjs'

function Navbar() {
  return (
    <nav>
      <SignedIn>
        {/* Only renders when user is authenticated */}
        <a href="/account">My Account</a>
        <a href="/orders">Orders</a>
        <SignOutButton />
      </SignedIn>

      <SignedOut>
        {/* Only renders when user is NOT authenticated */}
        <a href="/sign-in">Sign In</a>
        <a href="/sign-up">Register</a>
      </SignedOut>
    </nav>
  )
}
```

---

## 8. Sign-in and Sign-up UI

### Option A — Clerk's prebuilt components (fastest)

Create the pages and drop in the components. Clerk renders a full, branded UI:

```tsx
// app/sign-in/[[...sign-in]]/page.tsx
import { SignIn } from '@clerk/nextjs'

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <SignIn />
    </main>
  )
}
```

```tsx
// app/sign-up/[[...sign-up]]/page.tsx
import { SignUp } from '@clerk/nextjs'

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <SignUp />
    </main>
  )
}
```

The `[[...sign-in]]` folder name is required — it catches all the sub-routes Clerk needs (e.g. `/sign-in/factor-one`, `/sign-in/sso-callback`).

### Option B — Clerk's prebuilt modal (no redirect)

```tsx
'use client'
import { SignInButton, SignUpButton } from '@clerk/nextjs'

function HeroSection() {
  return (
    <div>
      <SignInButton mode="modal">
        <button className="btn-primary">Sign In</button>
      </SignInButton>

      <SignUpButton mode="modal">
        <button className="btn-secondary">Create Account</button>
      </SignUpButton>
    </div>
  )
}
```

### Option C — Custom UI with Clerk hooks (full control)

```tsx
'use client'
import { useSignIn } from '@clerk/nextjs'
import { useState } from 'react'

export function CustomSignInForm() {
  const { isLoaded, signIn, setActive } = useSignIn()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  if (!isLoaded) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    try {
      const result = await signIn.create({
        identifier: email,
        password,
      })

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId })
        // Redirect after sign-in
        window.location.href = '/'
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.message ?? 'Sign in failed')
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="Email"
        required
      />
      <input
        type="password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="Password"
        required
      />
      {error && <p className="text-red-500">{error}</p>}
      <button type="submit">Sign In</button>
    </form>
  )
}
```

---

## 9. Role-Based UI

User roles (`customer` | `admin`) are stored in Clerk's `publicMetadata`. Access them via `useUser()`:

```tsx
'use client'
import { useUser } from '@clerk/nextjs'

type UserRole = 'customer' | 'admin'

function useRole(): UserRole {
  const { user } = useUser()
  return (user?.publicMetadata?.role as UserRole) ?? 'customer'
}

// Usage in a component
function AdminPanel() {
  const role = useRole()

  if (role !== 'admin') {
    return <p>Access denied.</p>
  }

  return <div>Admin dashboard content</div>
}
```

### Protecting an entire admin section in middleware

```typescript
// middleware.ts — add admin route protection
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isAdminRoute  = createRouteMatcher(['/admin(.*)'])
const isProtectedRoute = createRouteMatcher(['/account(.*)', '/orders(.*)', '/checkout(.*)'])

export default clerkMiddleware(async (auth, req) => {
  const { userId, sessionClaims } = await auth()

  // Admin routes: must be signed in AND have the admin role
  if (isAdminRoute(req)) {
    if (!userId) {
      return auth().redirectToSignIn()
    }
    const role = (sessionClaims?.public_metadata as any)?.role
    if (role !== 'admin') {
      // Redirect non-admins to homepage
      return Response.redirect(new URL('/', req.url))
    }
  }

  // Standard protected routes: must be signed in
  if (isProtectedRoute(req)) {
    auth().protect()
  }
})
```

> **Setting a user's role:** Go to Clerk Dashboard → Users → select a user → Metadata → Public Metadata → set `{ "role": "admin" }`. The middleware picks it up on the next request without a redeploy.

---

## 10. Cart Merge

When a guest signs in, their guest cart must be merged into their persistent user cart. This is a single API call that happens once, immediately after sign-in completes.

```tsx
// hooks/useCartMerge.ts
'use client'
import { useAuth } from '@clerk/nextjs'
import { createApiClient } from '@/lib/api'
import { useCartStore } from '@/store/cart'   // your local guest cart state

export function useCartMerge() {
  const { getToken, isSignedIn } = useAuth()
  const guestItems = useCartStore(state => state.items)
  const clearGuestCart = useCartStore(state => state.clear)

  async function mergeCart() {
    if (!isSignedIn || guestItems.length === 0) return

    const api = createApiClient(getToken)
    await api('/cart/merge', {
      method: 'POST',
      body: JSON.stringify({ guestItems }),
    })

    clearGuestCart()   // guest cart is now in the DB — clear local state
  }

  return { mergeCart }
}
```

### Trigger the merge after sign-in

```tsx
// app/sign-in/[[...sign-in]]/page.tsx
'use client'
import { SignIn, useAuth } from '@clerk/nextjs'
import { useCartMerge } from '@/hooks/useCartMerge'
import { useEffect } from 'react'

export default function SignInPage() {
  const { isSignedIn } = useAuth()
  const { mergeCart } = useCartMerge()

  useEffect(() => {
    if (isSignedIn) {
      mergeCart()   // fires once when user becomes authenticated
    }
  }, [isSignedIn])

  return (
    <main className="flex min-h-screen items-center justify-center">
      <SignIn afterSignInUrl="/" />
    </main>
  )
}
```

---

## 11. Protected Page Patterns

### Server Component — fetch data on the server, redirect if unauthenticated

```tsx
// app/account/page.tsx
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { apiFetch } from '@/lib/api'

export default async function AccountPage() {
  const { userId } = auth()

  if (!userId) {
    redirect('/sign-in')
  }

  // apiFetch attaches the Clerk token automatically
  const { data: profile } = await apiFetch<{ data: UserProfile }>('/users/profile')

  return (
    <div>
      <h1>Hello, {profile.firstName}</h1>
      <p>{profile.email}</p>
    </div>
  )
}
```

### Client Component — show loading state while auth resolves

```tsx
'use client'
import { useAuth, useUser } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace('/sign-in')
    }
  }, [isLoaded, isSignedIn, router])

  if (!isLoaded) {
    return <div className="animate-pulse">Loading...</div>
  }

  if (!isSignedIn) {
    return null   // redirect is in flight
  }

  return <>{children}</>
}
```

---

## 12. Error Handling

The API returns structured errors in a consistent shape:

```json
{
  "success": false,
  "statusCode": 401,
  "code": "INVALID_CLERK_TOKEN",
  "message": "Token verification failed"
}
```

### Error codes you need to handle

| Code | HTTP | Meaning | Frontend action |
|---|---|---|---|
| `INVALID_CLERK_TOKEN` | 401 | JWT is expired or tampered | Call `getToken()` again and retry. If it persists, call `signOut()`. |
| `AUTH_PIPELINE_MISCONFIGURED` | 401 | Backend config error | Log to Sentry, show generic error to user |
| `JIT_PROVISIONING_FAILED` | 401 | User account setup in progress | Retry after 1–2 seconds (transient — webhook in flight) |
| `AUTHENTICATION_REQUIRED` | 401 | No token sent | Redirect to `/sign-in` |
| `INSUFFICIENT_ROLE` | 403 | User lacks required role | Redirect to home, show "access denied" toast |
| `USER_NOT_PROVISIONED` | 404 | GIM mapping missing (race) | Retry once after 500ms |

### Global error handler with React Query

```typescript
// lib/queryClient.ts
import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/lib/api'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          // Retry transient provisioning race once
          if (error.code === 'JIT_PROVISIONING_FAILED' && failureCount < 2) return true
          if (error.code === 'USER_NOT_PROVISIONED' && failureCount < 1) return true
          // Never retry auth errors
          if (error.status === 401 || error.status === 403) return false
        }
        return failureCount < 3
      },
      retryDelay: attemptIndex => Math.min(500 * 2 ** attemptIndex, 4000),
    },
  },
})
```

---

## 13. React Query Integration

The cleanest pattern: one hook per resource, `getToken` from `useAuth()` baked in.

```typescript
// hooks/useProfile.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@clerk/nextjs'
import { createApiClient, ApiError } from '@/lib/api'

export function useProfile() {
  const { getToken, isSignedIn } = useAuth()

  return useQuery({
    queryKey: ['profile'],
    queryFn: async () => {
      const api = createApiClient(getToken)
      const res = await api<{ data: UserProfile }>('/users/profile')
      return res.data
    },
    enabled: isSignedIn === true,   // only run when signed in
    staleTime: 5 * 60 * 1000,       // 5 minutes
  })
}

export function useUpdateProfile() {
  const { getToken } = useAuth()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (dto: UpdateProfileDto) => {
      const api = createApiClient(getToken)
      return api<{ data: UserProfile }>('/users/profile', {
        method: 'PATCH',
        body: JSON.stringify(dto),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}
```

### Orders with pagination

```typescript
// hooks/useOrders.ts
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@clerk/nextjs'
import { createApiClient } from '@/lib/api'

export function useOrders(page = 1, limit = 10, status?: string) {
  const { getToken, isSignedIn } = useAuth()

  return useQuery({
    queryKey: ['orders', page, limit, status],
    queryFn: async () => {
      const api = createApiClient(getToken)
      const params = new URLSearchParams({
        page:  String(page),
        limit: String(limit),
        ...(status ? { status } : {}),
      })
      const res = await api<{ data: Order[]; pagination: Pagination }>(
        `/orders?${params}`,
      )
      return res
    },
    enabled: isSignedIn === true,
    placeholderData: previousData => previousData,   // keep old data while fetching next page
  })
}
```

---

## 14. Showcase — Legacy Auth Demo

The showcase is an isolated demo of the original bcrypt + JWT auth system. It lives at `/showcase/*` routes on the API. You can call it from your frontend to show stakeholders how the old auth system worked, but it must never be used for real users.

The showcase uses a **cookie-based session** scoped to the `/showcase/` path, so browsers automatically send the `legacy_session` cookie only to showcase routes.

### Sign in to the showcase

```typescript
// This is a one-off demo function — not for production use
async function showcaseLogin(email: string, password: string) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/showcase/auth/login`, {
    method: 'POST',
    credentials: 'include',   // REQUIRED — tells browser to accept the Set-Cookie header
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  if (!res.ok) throw new Error('Showcase login failed')
  return res.json()
  // The API sets a legacy_session cookie (HTTPOnly, path=/showcase, 15-min TTL)
  // All subsequent showcase requests automatically include this cookie
}
```

### Call a showcase endpoint

```typescript
async function getShowcaseProfile() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/showcase/profile`, {
    credentials: 'include',   // browser sends the legacy_session cookie automatically
  })
  return res.json()
}
```

### Showcase vs production — key differences visible in responses

```json
// Production response (Clerk)
{
  "data": {
    "internalId": "550e8400-e29b-41d4-a716-446655440000",
    "sessionCtx":  "clerk_production",
    "email":       "user@example.com"
  }
}

// Showcase response (legacy JWT)
{
  "data": {
    "legacyUserId": "550e8400-e29b-41d4-a716-446655440000",
    "sessionCtx":   "legacy_showcase",
    "email":        "demo@pikly.com",
    "note": "This token was verified by LegacyShowcaseAdapter, not Clerk"
  }
}
```

### Available showcase endpoints

| Method | Path | Auth required | Description |
|---|---|---|---|
| `POST` | `/api/showcase/auth/login` | No | Sign in with legacy bcrypt password |
| `POST` | `/api/showcase/auth/register` | No | Create a legacy-only account |
| `POST` | `/api/showcase/auth/logout` | Yes (cookie) | Revoke the legacy session |
| `POST` | `/api/showcase/auth/introspect` | Yes (cookie) | Inspect the current legacy token |
| `GET` | `/api/showcase/profile` | Yes (cookie) | Profile data via legacy session |
| `GET` | `/api/showcase/info` | No | Architecture info — shows both adapters |
| `GET` | `/api/showcase/admin` | Yes (cookie, admin role) | Admin-only showcase endpoint |

---

## 15. Migration Checklist

Things to remove or replace in your existing frontend code:

### Remove from your codebase

```typescript
// REMOVE — no longer needed
localStorage.setItem('accessToken', ...)
localStorage.getItem('accessToken')
localStorage.removeItem('accessToken')
sessionStorage.setItem('token', ...)
document.cookie = 'token=...'

// REMOVE — no longer needed
await fetch('/api/auth/refresh', ...)
setInterval(() => refreshToken(), 14 * 60 * 1000)

// REMOVE — custom JWT decode
import jwtDecode from 'jwt-decode'
const { userId, role, exp } = jwtDecode(token)

// REMOVE — your old auth context/store
import { AuthContext } from '@/contexts/AuthContext'
const { user, login, logout } = useContext(AuthContext)
```

### Replace with

```typescript
// REPLACE localStorage token management with:
import { useAuth } from '@clerk/nextjs'
const { getToken, isSignedIn, signOut } = useAuth()
const token = await getToken()   // call at request time, never cache

// REPLACE manual refresh interval with:
// Nothing. Clerk handles it automatically.

// REPLACE jwtDecode with:
import { useUser } from '@clerk/nextjs'
const { user } = useUser()
const role = user?.publicMetadata?.role  // 'customer' | 'admin'

// REPLACE your auth context/store with:
import { SignedIn, SignedOut, useAuth, useUser } from '@clerk/nextjs'
```

### Update API call sites

Every place in your codebase that called `POST /api/auth/login` or `POST /api/auth/register` to get a token should now use Clerk's sign-in/sign-up flow. Search for these patterns:

```bash
# Find all places that still use the old auth endpoints
grep -r "auth/login\|auth/register\|auth/refresh\|accessToken\|refreshToken" \
  --include="*.ts" --include="*.tsx" src/
```

---

## 16. Troubleshooting

### "Unauthorized — INVALID_CLERK_TOKEN" on every request

Most common cause: the token is cached and stale. Always call `getToken()` fresh at request time. Never do:

```typescript
// WRONG — stale token
const token = await getToken()
setInterval(() => fetch('/api/something', {
  headers: { Authorization: `Bearer ${token}` }  // same stale token every time
}), 30_000)

// CORRECT — fresh token per request
setInterval(async () => {
  const token = await getToken()   // fresh call inside the interval
  fetch('/api/something', { headers: { Authorization: `Bearer ${token}` } })
}, 30_000)
```

### "JIT_PROVISIONING_FAILED" on first sign-in after sign-up

This is a transient race: the user completed sign-up, Clerk is redirecting them to your app, but the Clerk webhook (`user.created`) has not arrived at the backend yet. The JIT guard kicks in and provisions the account automatically. Retry after 1 second — it resolves itself. Add a retry in your React Query config (see [Section 12](#12-error-handling)).

### User's role is `undefined` after they should be admin

The `role` in `user.publicMetadata` is set via the Clerk Dashboard. After you set it:
1. The user must sign out and sign back in — the session token needs to be reissued with the new metadata.
2. Alternatively, from the Clerk Dashboard, revoke the user's sessions and they will be forced to re-authenticate.

### Cookie not being sent on showcase routes

Make sure `credentials: 'include'` is on every `fetch()` call to showcase endpoints. Without it, the browser silently drops the `legacy_session` cookie and every showcase request returns 401.

```typescript
// WRONG
fetch('/api/showcase/profile')

// CORRECT
fetch('/api/showcase/profile', { credentials: 'include' })
```

Also verify your API server has CORS configured to allow credentials from your frontend origin. In `main.ts`, `credentials: true` is already set in the CORS config.

### `isLoaded` is `true` but `isSignedIn` flickers

This happens when Next.js renders the page statically and then rehydrates. The solution is to always check `isLoaded` first before branching on `isSignedIn`:

```tsx
const { isLoaded, isSignedIn } = useAuth()

if (!isLoaded) return <Skeleton />                    // hydrating
if (!isSignedIn) return <a href="/sign-in">Login</a>  // definitely not signed in
return <Dashboard />                                   // definitely signed in
```

### Admin page accessible to customers in the browser (middleware not running)

Check that your `middleware.ts` file is at the project root — not inside `src/` or `app/`. The file must be co-located with `package.json` and `next.config.js`. Next.js only looks for middleware at the root level.

---

## Quick Reference

```typescript
// Get the current user's identity
const { isLoaded, isSignedIn, userId, getToken } = useAuth()
const { user } = useUser()

// Get a fresh token for API calls
const token = await getToken()

// User role
const role = user?.publicMetadata?.role as 'customer' | 'admin'

// Sign out
const { signOut } = useClerk()
await signOut({ redirectUrl: '/' })

// Attach token to any fetch
const res = await fetch('/api/users/profile', {
  headers: { Authorization: `Bearer ${await getToken()}` },
})

// Server component auth check
import { auth } from '@clerk/nextjs/server'
const { userId } = auth()
if (!userId) redirect('/sign-in')
```
