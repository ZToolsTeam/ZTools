# Tech Stack

## Core Technologies

- **Framework**: Vue 3 (Composition API with `<script setup>`)
- **Build Tool**: Vite 5
- **Language**: JavaScript (ES modules)
- **Package Manager**: npm

## Key Dependencies

- **UI Library**: Ant Design Vue 4 (CSS-in-JS, no style imports needed)
- **Styling**: Tailwind CSS 3 + PostCSS
- **State Management**: Pinia
- **Routing**: Vue Router 4
- **HTTP Client**: Axios
- **Icons**: Font Awesome 4
- **Testing**: Vitest + @vue/test-utils + fast-check (PBT)

## Auto-Import Configuration

Components from Ant Design Vue are auto-imported via `unplugin-vue-components` - no manual imports required.

## Common Commands

```bash
# Development
npm run dev              # Start dev server (auto-builds CEF-IPC first)
npm run preview          # Preview production build

# Building
npm run build            # Production build (auto-deploys to ../bin/WebResources)

# Testing
npm test                 # Run all tests once
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Generate coverage report
npm run test:ui          # Open Vitest UI
npm run test:e2e         # Run E2E tests
npm run test:all         # Run unit + E2E tests

# Code Quality
npm run prettier         # Format all files
```

## Build Process

1. Pre-build: Compiles CEF-IPC module (`public/js/cef-ipc/build.cjs`)
2. Vite build: Bundles Vue app
3. Post-build: Generates version file and deploys to `../bin/WebResources`

## Environment Variables

Create `.env.development` and `.env.production`:

```env
VITE_API_BASE_URL=/api                    # Dev: proxy to backend
VITE_API_BASE_URL=https://api.ztools.cn   # Prod: live API
VITE_USE_BACKEND_API=true                 # false = mock mode
```

## Path Aliases

- `@` → `src/`
- `@api` → `src/api/`
- `@components` → `src/components/`
- `@stores` → `src/stores/`
- `@composables` → `src/composables/`

## Dev Server

- Host: `0.0.0.0:5173`
- Proxy: `/api` → Backend API (configurable in `vite.config.js`)
- Hot reload enabled for CEF-IPC changes via custom plugin
