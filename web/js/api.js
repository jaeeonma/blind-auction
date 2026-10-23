// Calls to the read-only API (design.md 11번). Same origin as the page, so plain relative URLs.

/** An API answer that is not 200, with the API's own message. */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status, or 0 when the API could not be reached
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
async function get(path) {
  let res;
  try {
    res = await fetch(path, { headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError(0, "API에 연결할 수 없습니다. npm run api가 실행 중인지 확인하세요.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body;
}

/** @param {"" | "active" | "finalized"} status */
export const listAuctions = (status) => get(status ? `/auctions?status=${status}` : "/auctions");

/** @param {string} id */
export const getAuction = (id) => get(`/auctions/${encodeURIComponent(id)}`);

/** @param {string} address */
export const listUserAuctions = (address) => get(`/users/${encodeURIComponent(address)}/auctions`);
