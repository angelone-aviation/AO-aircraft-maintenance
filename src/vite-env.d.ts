/**
 * Responsibility: Ambient types for Vite's client API, the PWA plugin's
 *   virtual modules and the constants vite.config.ts defines.
 * Layer: Config. Type declarations only; emits no code.
 * Dependencies: vite/client, vite-plugin-pwa/client.
 */
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Site-relative paths of the PDF viewer's on-demand files, replaced at build
 * time by vite.config.ts; not defined under Vitest.
 */
declare const __PDF_VIEWER_FILES__: string[];
