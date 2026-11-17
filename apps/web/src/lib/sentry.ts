/**
 * Sentry error tracking configuration.
 *
 * This module initializes Sentry for the Streamix app. It captures errors
 * automatically, links them to APK versions via release tracking, and
 * includes user context (device model, platform) for easier debugging.
 *
 * To enable:
 * 1. Create a free account at https://sentry.io
 * 2. Create a new project for "Streamix" (JavaScript/React)
 * 3. Copy the DSN (Data Source Name) from the project settings
 * 4. Add it as a VITE_SENTRY_DSN environment variable
 *
 * The SDK is lightweight and only sends data when errors occur.
 * Free tier: 5,000 errors/month with 30-day retention.
 */

import * as Sentry from '@sentry/browser';
import { currentPlatform } from './platform';

/**
 * Initialize Sentry if a DSN is configured.
 * If no DSN is found, Sentry is silently disabled — no errors are thrown.
 *
 * Features enabled:
 * - Error tracking with release/dist tagging
 * - Performance tracing (10% sample rate)
 * - Session Replay (10% session sample, 100% on error)
 * - User context with platform and device info
 */
export function initSentry(dsn: string | undefined, appVersion: string | undefined) {
  if (!dsn) {
    console.debug('[Sentry] No DSN configured — error tracking disabled');
    return;
  }

  const platform = currentPlatform();

  Sentry.init({
    dsn,
    environment: platform === 'android' ? 'android' : 'web',
    release: appVersion ? `streamix@${appVersion}` : undefined,
    dist: appVersion ? appVersion.split('+')[1] : undefined,

    // ── Performance Tracing ──────────────────────────────────────────────
    // Sample 10% of transactions for performance monitoring.
    // Traces capture page loads, navigation, API calls, and custom spans.
    tracesSampleRate: 0.1,

    // ── Session Replay ───────────────────────────────────────────────────
    // Record 10% of user sessions for replay in Sentry dashboard.
    // When an error occurs, record 100% of sessions for full context.
    integrations: [Sentry.replayIntegration()],
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,

    // Error sampling — capture all errors
    sampleRate: 1.0,

    // User context — helps identify which devices are affected
    initialScope: {
      tags: {
        platform,
      },
    },

    // Filter out common noise — these are expected and not actionable
    ignoreErrors: [
      // Network errors that happen during normal usage (e.g., user disconnects)
      'Network request failed',
      'Failed to fetch',
      'Load rejected',
      'ChunkLoadError',

      // Browser-specific noise
      'ResizeObserver loop limit exceeded',
      'Non-Error promise rejection captured',

      // Ad blockers and extensions
      'Cannot read properties of undefined',
    ],

    // Max breadcrumbs — keeps payloads small
    maxBreadcrumbs: 50,

    // Before sending — add any last-minute filtering
    beforeSend(event) {
      // Remove sensitive data from URLs
      if (event.request?.url) {
        event.request.url = event.request.url.replace(/password=[^&]*/, 'password=[REDACTED]');
      }
      return event;
    },
  });

  console.debug(`[Sentry] Initialized — release: ${appVersion}, platform: ${platform}, tracing: enabled, replay: enabled`);
}

/**
 * Set the current user's context for error tracking.
 * This helps identify which user experienced an error.
 */
export function setSentryUser(userId: string, username: string) {
  Sentry.setUser({
    id: userId,
    username,
  });
}

/**
 * Clear the user context when logging out.
 */
export function clearSentryUser() {
  Sentry.setUser(null);
}

/**
 * Capture a custom error with context.
 * Use this for errors that you want to track explicitly.
 */
export function captureError(error: Error | string, context?: Record<string, string | number | boolean>) {
  const message = typeof error === 'string' ? error : error.message;
  Sentry.captureException(error, {
    tags: context,
    extra: { context },
  });
  console.error(`[Sentry] ${message}`, context || '');
}

/**
 * Capture a custom message at any severity level.
 * Sentry captures ALL levels, not just errors. Use this for structured logging.
 *
 * @example
 *   // Log important app events
 *   captureMessage('User added new source', 'info')
 *   captureMessage('Playback started: Movie Title', 'info')
 *   captureMessage('Search query: "action movies"', 'debug')
 *   captureMessage('Slow API response: 3200ms', 'warning')
 *   captureMessage('Failed to load channel list', 'error')
 */
export function captureMessage(message: string, level: Sentry.SeverityLevel = 'info') {
  Sentry.captureMessage(message, level);
}

/**
 * Convenience logging functions — drop-in replacements for console.log that also send to Sentry.
 * These send to Sentry at the appropriate level, so you can see them in your dashboard.
 *
 * @example
 *   // In any component or module:
 *   import { logInfo, logWarning, logDebug } from '../lib/sentry'
 *
 *   logInfo('Playback started', { title: 'Movie Name', duration: 7200 })
 *   logWarning('Slow API response', { endpoint: '/get_vod_cat', time: 3200 })
 *   logDebug('Search executed', { query: 'action', results: 42 })
 */

/** Log an info-level message to Sentry (visible in dashboard under "info" level) */
export function logInfo(message: string, context?: Record<string, string | number | boolean>) {
  Sentry.captureMessage(message, { level: 'info', tags: context, extra: context });
  console.info(`[App] ${message}`, context || '');
}

/** Log a warning-level message to Sentry */
export function logWarning(message: string, context?: Record<string, string | number | boolean>) {
  Sentry.captureMessage(message, { level: 'warning', tags: context, extra: context });
  console.warn(`[App] ${message}`, context || '');
}

/** Log a debug-level message to Sentry (useful for tracing user flows) */
export function logDebug(message: string, context?: Record<string, string | number | boolean>) {
  Sentry.captureMessage(message, { level: 'debug', tags: context, extra: context });
  console.debug(`[App] ${message}`, context || '');
}

/** Log an error-level message to Sentry (without throwing an exception) */
export function logError(message: string, context?: Record<string, string | number | boolean>) {
  Sentry.captureMessage(message, { level: 'error', tags: context, extra: context });
  console.error(`[App] ${message}`, context || '');
}
