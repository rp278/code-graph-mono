// Cookie-based feature flags. A flag is on only when its cookie is exactly "true".

function readCookie(name) {
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const c = part.trim();
    if (c.startsWith(prefix)) {
      try {
        return decodeURIComponent(c.slice(prefix.length));
      } catch {
        return c.slice(prefix.length);
      }
    }
  }
  return null;
}

export const FEATURE_DEVELOPMENT_COOKIE = 'cg_feature_development_enabled';

export function isFeatureDevelopmentEnabled() {
  return readCookie(FEATURE_DEVELOPMENT_COOKIE) === 'true';
}
