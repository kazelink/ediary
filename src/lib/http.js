export function jsonError(c, message, status) {
  return c.json({ error: message }, status);
}

export function textError(c, message, status) {
  return c.text(message, status);
}

export function getContentLength(c) {
  const value = Number.parseInt(c.req.header('Content-Length') || '', 10);
  return Number.isFinite(value) ? value : null;
}

export async function parseJsonBody(c, invalidMessage = 'Invalid JSON payload') {
  try {
    return { value: await c.req.json(), response: null };
  } catch {
    return { value: null, response: jsonError(c, invalidMessage, 400) };
  }
}

export async function parseFormBody(c, invalidMessage = 'Invalid form payload') {
  try {
    return { value: await c.req.parseBody(), response: null };
  } catch {
    return { value: null, response: jsonError(c, invalidMessage, 400) };
  }
}
