/**
 * Parse a single HTTP byte range.  Edge's human download flow and Agent's
 * local delivery flow deliberately use the same range semantics so that a
 * browser or download manager can resume a file in either place.
 *
 * @returns {null|{start:number,end:number}|'invalid'}
 */
export function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return 'invalid';
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return 'invalid';
  end = Math.min(end, size - 1);
  return { start, end };
}

export function bearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && /^Bearer\s+\S+$/iu.test(authorization)) return authorization.replace(/^Bearer\s+/iu, '');
  const queryToken = request.query?.token;
  return typeof queryToken === 'string' ? queryToken : null;
}
